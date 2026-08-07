-- =============================================================================
-- 0018 · Take the event-trigger function off the API surface
--
-- `rls_auto_enable()` is an event-trigger function: Postgres calls it when a
-- table is created, and nothing else can. Calling it outside an event-trigger
-- context raises, and PostgREST does not expose a function returning
-- `event_trigger` — so the security advisor's finding on it is conservative
-- rather than exploitable.
--
-- Revoking is free and removes the finding, which is the point: an advisor list
-- with known-benign entries on it is an advisor list nobody reads. What is left
-- there afterwards is the four policy helpers (0008 documents why they keep
-- their grant) and `discontinued_product_hint`, which is deliberate and written
-- up in docs/rls-tests.md §7.
-- =============================================================================

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
