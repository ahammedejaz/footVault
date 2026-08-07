-- =============================================================================
-- 0014 · Edit distance, for short brand names
--
-- Trigram similarity collapses on short strings: similarity('Nike','nkie') is
-- 0.111 and similarity('Crocs','crcos') is 0.200 — a transposition inside a
-- four-letter brand is invisible to it, and no threshold low enough to catch
-- those is high enough to reject everything else.
--
-- Edit distance sees both as two operations. Brands are a closed vocabulary of
-- twelve rows, so an edit-distance pass over that list is cheap and cannot run
-- away the way one over product names would.
-- =============================================================================

create extension if not exists fuzzystrmatch with schema extensions;
