-- A book that was shared in a chat can be deleted (and so can its poster's account)
-- 2026-10-05
--
-- Run in: Supabase Dashboard -> SQL Editor. Run PART 1 (the change), then PART 2 (the self-test)
-- as a separate run — the editor shows only the last result, and the self-test's result is its
-- error message. Safe to re-run.
--
-- WHY
-- messages.book_id points at book_listings with no ON DELETE rule ("no action"), unlike
-- messages.listing_id, which is SET NULL. So a book that had ever been shared in a chat could not be
-- deleted — and neither could its poster's account, because deleting an account deletes their books
-- (2026-10-01_account_deletion.sql). The account-deletion self-test passed only because the student
-- it used had never had a book shared. Found 2026-10-05 while preparing the pre-launch cleanup.
--
-- WHAT CHANGES
--   messages.book_id -> ON DELETE SET NULL. The chat keeps the message; the shared-book card becomes
--   "no longer available", exactly as a deleted listing's card already does.
--   A final check refuses to commit if ANY link to listings or book_listings is still "no action" or
--   "restrict", so no other hidden link can block a deletion.
--
-- UNDO: alter the constraint back to no action; ask Claude.


-- ============================================================================
-- PART 1 — the change
-- ============================================================================

begin;

do $$
declare v_con text;
begin
  select c.conname into v_con
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
  where c.contype = 'f' and c.conrelid = 'public.messages'::regclass and a.attname = 'book_id'
    and c.confrelid = 'public.book_listings'::regclass
  limit 1;
  if v_con is null then
    raise exception 'No link messages.book_id -> book_listings was found, so nothing was changed. Send Claude this message.';
  end if;
  execute format('alter table public.messages drop constraint %I', v_con);
  execute format('alter table public.messages add constraint %I foreign key (book_id) references public.book_listings (id) on delete set null', v_con);
end
$$;

-- Nothing may still block deleting a listing or a book.
do $$
declare v_left text;
begin
  select string_agg(c.conrelid::regclass::text || '.' || a.attname, ', ') into v_left
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
  where c.contype = 'f'
    and c.confrelid in ('public.listings'::regclass, 'public.book_listings'::regclass)
    and c.confdeltype in ('a', 'r');
  if v_left is not null then
    raise exception 'These links would still block deleting a listing or book, so NOTHING was changed: %. Send Claude this message.', v_left;
  end if;
end
$$;

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- PART 2 — self-test (run on its own). Shares a real book in a test message, then deletes the book,
-- inside a test that is thrown away. THE ERROR MESSAGE IS THE REPORT; nothing is saved.
-- ============================================================================

DO $verify$
DECLARE
  v_book  bigint;
  v_owner uuid;
  v_other uuid;
  v_msg   uuid;
  v_n     int;
  r       text := E'\n';
  ok      boolean := true;
BEGIN
  SELECT b.id, b.poster_id INTO v_book, v_owner FROM public.book_listings b WHERE b.poster_id IS NOT NULL ORDER BY b.id LIMIT 1;
  SELECT p.id INTO v_other FROM public.profiles p WHERE p.id <> v_owner ORDER BY p.created_at LIMIT 1;
  IF v_book IS NULL OR v_other IS NULL THEN
    RAISE EXCEPTION 'Needs one book with a poster and one other account to test with.';
  END IF;

  INSERT INTO public.messages (sender_id, receiver_id, content, message_type, book_id)
  VALUES (v_other, v_owner, 'verify-book-share', 'text', v_book) RETURNING id INTO v_msg;

  BEGIN
    DELETE FROM public.book_listings WHERE id = v_book;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 1 THEN r := r || E'TEST 1  a book shared in a chat can be deleted ...... PASS\n';
    ELSE r := r || E'TEST 1  a book shared in a chat can be deleted ...... *** FAIL — not deleted ***\n'; ok := false; END IF;
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 1  a book shared in a chat can be deleted ...... *** FAIL — %s ***\n', SQLERRM); ok := false;
  END;

  SELECT count(*) INTO v_n FROM public.messages WHERE id = v_msg AND book_id IS NULL;
  IF v_n = 1 THEN r := r || E'TEST 2  the chat message stays, without the book .... PASS\n';
  ELSE r := r || E'TEST 2  the chat message stays, without the book .... *** FAIL ***\n'; ok := false; END IF;

  r := r || E'\n' || CASE WHEN ok THEN 'ALL TESTS PASSED. Nothing was saved — the book and the chat are as they were.'
                           ELSE '*** SOME TESTS FAILED — read the lines marked FAIL. Nothing was saved. ***' END;
  RAISE EXCEPTION '%', r;
END
$verify$;
