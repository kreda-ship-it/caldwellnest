-- An officer may not remove their own officer row
-- 2026-09-06
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run. Safe to re-run.
--
--
-- THE HOLE
-- Two policies, both correct-looking, together letting the last officer of an organization
-- delete themselves out of it:
--
--   org_memberships_delete   using (user_id = auth.uid() or can_act('manage_members', org_id))
--   org_memberships_update   using (can_act('manage_members', org_id))
--
-- The delete policy carries the comment "A student may always leave. An officer may remove
-- someone." That is the right principle for a member and the wrong one for an officer, and
-- nothing in the policy distinguishes them. The update policy is worse in a quieter way: a
-- manager may update any row on the org, and their own row is one of those, so setting
-- status = 'removed' on yourself has always been permitted.
--
-- guard_org_membership_flags() does not fire on either. It compares flags and role; status is
-- neither, and a DELETE has no new row to compare.
--
--
-- WHY IT MATTERS MOST AT THE ROOT, AND BARELY AT ALL LOWER DOWN
-- can_act() walks parent_id UPWARD, so a club that loses its last officer is still managed by
-- the department above it, and by the school above that. Nothing is stranded.
--
-- The school organization has no parent. If the one membership on it removes itself, no
-- membership row anywhere can reach anything — every club, every department, every future
-- event. Recovery needs is_super_admin() or the SQL editor.
--
-- On this database that is not hypothetical. The root organization has exactly one member,
-- and that account holds no user_roles row: it is an ordinary student who happens to
-- administer the university. It is the single row that must not be able to delete itself.
--
--
-- THE RULE, IN ONE SENTENCE
-- If your membership carries can_manage_members, you cannot be the one who takes it away.
--
-- A plain member leaves freely — they hold no flags, so the guard never looks at them, and
-- "a student may always leave" survives intact. An officer asks somebody else, and in a
-- hierarchy there is always somebody else: anyone holding the flag on this organization or on
-- any organization above it.
--
-- WHY A TRIGGER AND NOT A POLICY. The question "is this the row that carries the authority"
-- is about the row being written, which a policy can see — but the shape of the rule is
-- "you may touch this row, and not in this way", which is the column-level distinction RLS
-- has never been able to make. Same reason as guard_org_membership_flags(), and the same
-- answer.


begin;


create or replace function public.guard_org_self_removal()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text;
begin
  -- BREAK-GLASS, and required for the same reason as the flag guard: the SQL editor sends no
  -- JWT, so auth.uid() is null there and the bootstrap could not undo its own mistakes.
  -- 'anon' deliberately does not match — an unauthenticated browser request carries a JWT and
  -- falls through to the real checks.
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if v_role = '' or v_role = 'service_role' then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  -- A platform administrator can always repair a stranded organization. That is the whole
  -- point of having one, and it is the recovery path this guard exists to avoid needing.
  if public.is_super_admin() then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  -- Only ever about your OWN row. Removing somebody else is what the policies already govern.
  if old.user_id is distinct from auth.uid() then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  -- Only ever about rows that carry authority. A plain member holds no flags and reaches this
  -- line with can_manage_members false, so they leave without ever meeting an exception.
  -- THIS IS THE LINE THAT KEEPS "a student may always leave" TRUE.
  if not coalesce(old.can_manage_members, false) then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'You cannot remove your own officer role. Ask another officer, or someone in the organization above yours, to do it.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Leaving 'active' is removal by another name, and it is the path the interface actually
  -- takes now that removal is a status change rather than a delete.
  if old.status = 'active' and new.status is distinct from 'active' then
    raise exception 'You cannot remove your own officer role. Ask another officer, or someone in the organization above yours, to do it.'
      using errcode = 'insufficient_privilege';
  end if;

  -- And so is handing back the flag itself. Without this the rule would be trivially avoided
  -- in two steps: drop your own can_manage_members, which leaves the guard with nothing to
  -- protect, then remove the row. The end state is identical, so the rule has to cover it.
  --
  -- Note this only bites if you also hold can_manage_admins, since the flag guard already
  -- refuses a flag change without it. Stepping back from your own responsibilities is still
  -- possible — somebody else does it for you, which is the same answer as everywhere else here.
  if new.can_manage_members = false then
    raise exception 'You cannot take away your own permission to manage members. Ask another officer to change it.'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$function$;


-- BEFORE, so the exception happens instead of the write rather than after it. Row-level,
-- because the question is about one membership at a time.
drop trigger if exists org_memberships_guard_self_removal on public.org_memberships;
create trigger org_memberships_guard_self_removal
  before delete or update on public.org_memberships
  for each row execute function public.guard_org_self_removal();


commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY (read-only)
-- ============================================================================

-- Expected: TWO triggers on org_memberships — the flag guard (BEFORE INSERT OR UPDATE) and
-- this one (BEFORE DELETE OR UPDATE). They are independent and both must be present; neither
-- replaces the other.
select pg_get_triggerdef(t.oid) as definition
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where c.relname = 'org_memberships' and not t.tgisinternal
order by t.tgname;

-- Expected: every organization in the tree, and whether anyone can still manage it. A club
-- showing 0 is fine — the department above it manages it. The ROOT showing 0 is the state
-- this guard exists to prevent, and if it ever appears here, fix it before doing anything else.
with recursive tree as (
  select id, parent_id, name, type, 0 as depth, name::text as path
  from public.organizations where parent_id is null
  union all
  select o.id, o.parent_id, o.name, o.type, t.depth + 1, t.path || ' > ' || o.name
  from public.organizations o join tree t on o.parent_id = t.id
  where t.depth < 10
)
select depth, type, path,
       (select count(*) from public.org_memberships m
         where m.org_id = tree.id and m.status = 'active' and m.can_manage_members) as own_managers
from tree order by path;


-- Then run sql/2026-09-06_verify_self_removal.sql.
