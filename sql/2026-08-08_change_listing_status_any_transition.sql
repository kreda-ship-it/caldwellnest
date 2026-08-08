-- ============================================================================
-- The listing lifecycle RPC — any status may move to any other
-- Serves: public.listings AND public.book_listings   Applied: 2026-08-08
-- ============================================================================
--
-- WHAT THIS FUNCTION IS FOR
--   Students hold no direct UPDATE grant on `listings` or `book_listings`. This
--   SECURITY DEFINER function is the single door through which an owner may
--   change their own listing's lifecycle state. It checks who you are, then
--   writes. Callers: lifecycleAction(), setListingDeadline(),
--   clearListingDeadline(), renewListing() in js/listings.js, and
--   bookLifecycleAction(), relistBook() in js/books.js.
--
-- WHAT CHANGED ON 2026-08-08
--   The old version carried a hard-coded transition matrix:
--       active       -> pending_sale, sold, withdrawn
--       pending_sale -> active, sold, withdrawn
--       sold         -> active                      <-- dead end
--       withdrawn    -> active                      <-- dead end
--       expired      -> active, sold, withdrawn
--
--   sold and withdrawn were dead ends. A seller who marked something sold by
--   mistake, or whose withdrawn item sold offline anyway, could only bounce back
--   through 'active' to correct it. That matrix is now replaced by a whitelist
--   of legal VALUES — any state may move to any other, but a typo or a buggy
--   client can still never write a status the app cannot render.
--
--   Two further things that rewrite fixed, both deliberate:
--
--   1. A NULL lifecycle_status used to slip through unchecked. Every branch of
--      the matrix compared against NULL, so the whole expression evaluated to
--      NULL — and in SQL, NOT NULL is still NULL, which is not `true`, so the
--      IF never fired. Rows predating the column were silently unguarded.
--
--   2. Admins can no longer write nonsense. The old check ended in `OR v_is_admin`,
--      which let an admin set lifecycle_status to any string at all.
--
-- 'expired' is deliberately NOT settable. It is derived at read time from
-- expires_at (see isListingLive() in js/data.js and the visible_listings view),
-- so storing it would create a second, drift-prone source of truth.
--
-- SAFE TO RE-RUN. If you are unsure whether this was ever applied, run it again.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.change_listing_status(
  p_listing_id bigint,
  p_new_status text,
  p_table      text        DEFAULT 'listings'::text,
  p_expires_at timestamptz DEFAULT NULL::timestamptz,
  p_set_expires boolean    DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_poster  uuid;
  v_current text;
  v_is_admin boolean;
BEGIN
  v_is_admin := EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid());

  IF p_table = 'book_listings' THEN
    SELECT poster_id, lifecycle_status INTO v_poster, v_current FROM book_listings WHERE id = p_listing_id;
  ELSE
    SELECT poster_id, lifecycle_status INTO v_poster, v_current FROM listings WHERE id = p_listing_id;
  END IF;

  IF v_poster IS NULL THEN RAISE EXCEPTION 'Listing not found'; END IF;

  IF NOT v_is_admin AND v_poster != auth.uid() THEN
    RAISE EXCEPTION 'Not authorized to change this listing';
  END IF;

  -- Only the VALUE is policed, not the path between values. See the header note.
  IF p_new_status NOT IN ('active','pending_sale','sold','withdrawn') THEN
    RAISE EXCEPTION 'Unknown lifecycle status: %', p_new_status;
  END IF;

  IF p_table = 'book_listings' THEN
    UPDATE book_listings SET
      lifecycle_status  = p_new_status,
      status_changed_at = now(),
      expires_at        = CASE WHEN p_set_expires THEN p_expires_at ELSE expires_at END
    WHERE id = p_listing_id;
  ELSE
    UPDATE listings SET
      lifecycle_status  = p_new_status,
      status_changed_at = now(),
      -- A "renewal" is specifically: an expired listing given a future deadline.
      -- Re-saving a deadline on a live listing must not inflate this counter.
      renew_count = CASE WHEN p_set_expires AND p_new_status = 'active'
                              AND expires_at IS NOT NULL AND expires_at <= now()
                              AND p_expires_at > now()
                         THEN renew_count + 1 ELSE renew_count END,
      expires_at        = CASE WHEN p_set_expires THEN p_expires_at ELSE expires_at END
    WHERE id = p_listing_id;
  END IF;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Both UPDATE branches above write status_changed_at, and the listings branch
-- writes renew_count. Any BEFORE UPDATE guard trigger on either table must
-- therefore allow those columns to change, or every owner action fails with the
-- trigger's own error. That is exactly the bug fixed in
-- 2026-08-08_fix_owner_lifecycle_guard.sql — and the reason
-- 2026-08-08_check_book_listings_guard.sql exists.
-- ---------------------------------------------------------------------------

NOTIFY pgrst, 'reload schema';
