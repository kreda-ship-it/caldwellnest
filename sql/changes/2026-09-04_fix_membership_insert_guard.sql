-- Close a privilege-escalation gap in the org membership guard
-- 2026-09-04
--
-- Found while building the stage 3 admin UI, which is the first code that inserts an officer
-- row. Fixes a hole in sql/2026-09-04_org_hierarchy.sql, shipped earlier the same day.
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run. Safe to re-run.
--
-- THE HOLE
-- guard_org_membership_flags() was created BEFORE UPDATE only. It correctly stops someone
-- with can_manage_members from raising an existing member's permissions — that needs
-- can_manage_admins, because whoever can grant permissions can grant them to themselves.
--
-- But nothing guarded INSERT. The insert policy asks only for can_manage_members, so a club
-- officer holding that flag could create a BRAND NEW membership row with every flag set,
-- including can_manage_admins. They could not raise their own row, but they could hand full
-- authority to an accomplice, or to a second account of their own. The end state is the same
-- and the path is one step longer.
--
-- This is the same lesson as A0 in docs/nestrel-campus-engagement-plan.md, arriving from the
-- other direction. There, the risk was writing a role column on a row you own. Here, it is
-- creating a row that grants what you were never given. Both are "the permission system can
-- be used to widen itself", and both are only visible if you ask what a WRITE can create,
-- not just what it can change.
--
-- THE FIX
-- Same trigger function, now also on INSERT. On UPDATE it compares old and new, unchanged.
-- On INSERT there is no OLD row, so the question becomes: does this new row grant anything at
-- all? If it sets any flag, or makes someone an officer, that is granting authority and needs
-- can_manage_admins.
--
-- The join-request path is unaffected: it inserts role='member', status='pending' and every
-- flag false, so it grants nothing and never reaches the exception.

create or replace function public.guard_org_membership_flags()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role             text;
  v_grants_authority boolean;
begin
  -- BREAK-GLASS, and it is required rather than convenient.
  -- The SQL editor sends no JWT, so auth.uid() is null there and every check below would
  -- refuse. Without this, the bootstrap in 2026-09-04_org_hierarchy.sql could not create the
  -- first school admin, and 2026-09-04_verify_can_act.sql could not build its test hierarchy
  -- — the guard would lock the database out of setting itself up.
  --
  -- Note 'anon' deliberately does NOT match. An unauthenticated browser request carries
  -- role 'anon', which is a JWT, so it falls through to the real checks. This is the exact
  -- distinction sql/2026-08-08_align_owner_guards.sql was written to make, after an earlier
  -- guard used `auth.uid() IS NULL` and waved through every anonymous caller along with the
  -- SQL editor.
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if v_role = '' or v_role = 'service_role' then
    return new;
  end if;

  if public.is_super_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- No OLD row to compare against. The question is not "what changed" but "does this row
    -- hand anyone anything". Any true flag, or officer standing, is authority being granted.
    v_grants_authority :=
         new.can_post
      or new.can_manage_members
      or new.can_view_analytics
      or new.can_message
      or new.can_create_child_orgs
      or new.can_moderate
      or new.can_manage_admins
      or new.role = 'officer';
  else
    v_grants_authority :=
         new.can_post              is distinct from old.can_post
      or new.can_manage_members    is distinct from old.can_manage_members
      or new.can_view_analytics    is distinct from old.can_view_analytics
      or new.can_message           is distinct from old.can_message
      or new.can_create_child_orgs is distinct from old.can_create_child_orgs
      or new.can_moderate          is distinct from old.can_moderate
      or new.can_manage_admins     is distinct from old.can_manage_admins
      or new.role                  is distinct from old.role;

    -- Only meaningful on UPDATE: an INSERT cannot move a row that did not exist.
    if new.org_id is distinct from old.org_id then
      raise exception 'A membership cannot be moved between organizations'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  if v_grants_authority and not public.can_act('manage_admins', new.org_id) then
    raise exception 'Granting permissions requires can_manage_admins on this organization'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$function$;

drop trigger if exists org_memberships_guard_flags on public.org_memberships;
create trigger org_memberships_guard_flags
  before insert or update on public.org_memberships
  for each row execute function public.guard_org_membership_flags();

notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY — expected: BEFORE INSERT OR UPDATE
-- ============================================================================
select pg_get_triggerdef(t.oid) as definition
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where c.relname = 'org_memberships' and not t.tgisinternal;

-- Re-run sql/2026-09-04_verify_can_act.sql after this. It inserts officer rows during setup
-- while impersonating nobody in particular, so it exercises the new INSERT branch. If it
-- still reports ALL TESTS PASSED, the guard is discriminating rather than simply refusing
-- everything — which is the failure mode a guard like this actually has.
