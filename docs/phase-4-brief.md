# Foot Vault — Phase 4 Brief

> Save as `docs/PHASE_4.md` and tell Claude Code: *"Read docs/PHASE_4.md and begin."*

---

## Standing rules — add these to `PROJECT_BRIEF.md` now, they apply to every remaining phase

**1. Execution reports.** Every phase produces a report at `claudeExecutionReport/phase-<n>-<slug>.md`. Create the folder if it doesn't exist. Each report must contain:
- What was built, feature by feature, with the file paths that changed
- Every decision you took autonomously, with a one-line rationale
- Every bug you found and fixed — including bugs in your own earlier phases — with root cause, not just symptom
- Every measurement, with the actual number: Lighthouse, axe, overflow audit, query counts, test results
- **What you got wrong and caught during self-review**
- **Known imperfections** — an honest list. If it's empty you didn't look hard enough; write what you're least confident about instead
- What is deliberately deferred, and to which phase
- Anything blocked on me, with the exact steps I need to take

Write it for a reader who wasn't watching you work.

**2. Documentation stays current.** No phase is complete until the docs match the code. Every phase updates, as applicable:
- `README.md` — setup steps, env vars, scripts, current feature status, how to run and test
- `.env.example` — every key, no values
- `docs/architecture.md` — create it if absent; keep the data flow and folder conventions accurate
- `docs/database.md` — schema, tables, RLS policy summary, regenerated after any migration
- `docs/admin-guide.md` — written for a non-technical shop owner, grown as admin features land
- `docs/rls-tests.md` — extended whenever a policy changes
- Inline comments where a decision is non-obvious

A stale doc is a bug. Treat it as one.

**3. Authority.** You have full authority to fix any bug anywhere in the repo, refactor what's in your way, add migrations, change dependencies, and adjust tokens where measurement justifies it — including in code from earlier phases. What still comes to me: business policy changes (pricing, shipping, returns, sizing, currency, payment approach), destructive operations on data or git history, and scope beyond the current phase.

**4. Skills.** Check which skills are available in your environment at the start of every phase and use every one that applies. Load **frontend-design** before any UI work.

---

## Preflight — before any Phase 4 code

### A. Land the branch stack

PRs #1, #2 and #3 are stacked and unmerged; `main` is behind. Retarget and merge them in order (0 → 1 → 3), confirm `main` builds green, and branch Phase 4 from `main`. No more stacking — every future phase branches from `main`.

### B. Fix the three live bugs blocking the homepage

These are breaking the site right now. Root-cause them, then sweep for the same class elsewhere.

1. **`src/components/storefront/announcement-bar.tsx:57` — inline `<script>` never executes.** A `<script dangerouslySetInnerHTML>` rendered from a Client Component is inert; React does not execute it. The pre-paint trick only works in server-rendered HTML. Don't reach for `next/script` here — **replace the mechanism**: store the dismissal in a cookie, read it server-side in the layout, and render the bar only when it isn't dismissed. Zero flash, zero inline script, no localStorage, and Safari private mode stops being a special case. Then grep the repo for any other inline-script-in-component pattern.

2. **`src/components/storefront/home-sections.tsx:75` — `<Image>` receives both `width` and `fill`.** The shared props object and the art-direction override are being merged so both layout strategies arrive together. This is what's actually taking the homepage down. Pick one strategy per rendered image and make the types enforce it — a discriminated union on the hero props so `fill` and `width`/`height` are mutually exclusive at compile time, not discovered at runtime. Audit every other `<Image>` in the repo for the same spread-merge shape.

3. **`src/app/(storefront)/error.tsx:28` — `[storefront] unhandled error {}`.** Two problems. It's almost certainly a cascade from bug 2, so it should resolve — but it logged an **empty object**, which means the boundary's error serialisation is broken. An error boundary that can't tell you what it caught is worse than none. Fix the logging so message, digest, stack and route always come through, and verify by deliberately throwing in a page.

After these, load the homepage and confirm it renders clean, with no console errors at all.

### C. Confirm what isn't a bug

The cart buttons not working is **correct behaviour** — Phase 3 shipped them disabled with a visible note, by design. Phase 4 is where they come alive. Confirm the disabled state is still intentional and hasn't drifted into a broken-looking control.

---

## Part A — Authentication (Phase 2, folded in)

Cart-merge-on-login cannot be built or tested without auth, so it lands first. **Email confirmation is now disabled in Supabase.**

**Google sign-in only.** No email/password, no registration form, no password reset, no forgot-password flow. Remove any scaffolding for those rather than leaving dead routes.

- Supabase Google OAuth provider, with the redirect URLs configured for localhost, Vercel previews, and production.
- `/auth/callback` route handler exchanging the code for a session; correct cookie handling in middleware so Server Components see the session.
- Sign-in entry points: header, and contextual prompts (saving a wishlist item, checking out).
- After sign-in, return the user to where they were — not to the homepage.
- Sign out, everywhere it needs to be.
- **Guest checkout must remain possible.** Sign-in is for saved carts, wishlists and order history, never a wall in front of buying.

**Roles and security — the part that matters most:**

- The `handle_new_user` trigger hardcodes `role = 'customer'`. It must never read role from `raw_user_meta_data`, and Google's profile payload must not influence it.
- **Admin bootstrap:** write a migration or documented SQL that promotes a specific email to `admin`, and put the exact command in `docs/admin-guide.md`. I need to be able to make myself admin without you.
- `/admin` middleware returns **404**, not a redirect — the route's existence shouldn't be discoverable.
- **Re-run the escalation test through real HTTP now that it's unblocked.** Phase 3 could only run it at the database level, which was an honest substitution but not the real attack surface. Sign in with Google, attempt `update profiles set role='admin'`, show it failing, show `is_admin()` returning false. Update `docs/rls-tests.md` and mark §6b resolved.

---

## Part B — Cart

**The server is the only authority on price and stock.** The client holds identifiers and quantities and nothing else. Never trust a price that arrived from a browser.

- Guest carts keyed by an httpOnly `guest_token` cookie, persisted in the `carts` table — not localStorage. A cart must survive a phone restart and a browser tab crash.
- **Merge on sign-in.** Guest adds three items, signs in with Google, all three are still there, combined with anything already in their account cart. Quantities sum, capped at available stock. This is the single most important behaviour in this phase — test it explicitly and show me the result.
- Add to bag from the product page and from the quick-add on cards where it exists. Requires a size selection; if none is chosen, focus and highlight the size-run strip rather than showing an error toast.
- Cart page and a slide-over bag drawer, sharing one source of truth. Quantity stepper, remove, and an undo on remove.
- **Revalidate on every load.** Prices and stock re-read from the database. If a price changed or stock dropped below the held quantity, say so in plain language and adjust — never silently, never with a stale total.
- Free-shipping progress against the ₹1,999 threshold, from `site_settings`, not hardcoded.
- Coupon input field present and styled; validation is Phase 8 — wire it to a clear "coming soon" or hide it behind a flag, but don't ship an input that silently does nothing.
- Header badge count, live, with `aria-live`.
- Empty state that routes back into the catalogue.

**Concurrency:** two sessions adding the last unit of a variant. The cart may hold it optimistically, but the reservation is not real until checkout — make sure the cart's promise and Phase 5's behaviour won't contradict each other. Document the model you chose in the report.

---

## Part C — Wishlist

- Requires sign-in. Tapping the heart while signed out prompts to sign in and **completes the save afterwards** — the intent must survive the round trip.
- Toggle from product cards and the product page, optimistic with rollback on failure.
- `/wishlist` page with move-to-bag, requiring a size choice inline.
- Header badge, empty state.

---

## Part D — Polish

- One toast system, consistent copy. "Added to bag" with an undo, not a bare confirmation.
- Optimistic UI everywhere, with rollback and a visible failure message when the server disagrees.
- Every new surface meets the Phase 3 bar: 44px targets, keyboard operable, focus-trapped overlays, `prefers-reduced-motion` honoured, no layout shift.

---

## Quality gates

Everything from Phase 3 still applies, plus:

- Lighthouse mobile ≥ 90 across all four categories on `/`, `/shop`, a product page, and `/cart`. **Measure on a Vercel preview deploy, not localhost** — the simulated-mode discrepancy from Phase 3 needs settling on real infrastructure.
- axe clean, including the bag drawer, the sign-in prompt, and every new modal.
- Zero overflow, zero sub-44px targets, across all routes × six widths.
- Full keyboard path: browse → select size → add to bag → open drawer → change quantity → sign in → confirm the cart merged.
- No `any`, no `@ts-ignore`, no disabled lint rules without a justifying comment.
- The Phase 3 `no-unchecked-supabase-error` rule stays green — no new swallows.

---

## Out of scope — note and move on

Checkout, orders and **Razorpay** are Phase 5. Do not start them. Keep the payment interface swappable as designed, and note in the report anything Phase 4 does that Razorpay will need to build on. Admin panel is 6–7. Coupon validation and reviews are 8.

---

## Done when

A customer can browse on a phone, add three items in different sizes, close the browser, come back, still have their cart, sign in with Google, keep everything, save a shoe to their wishlist, and reach the checkout button — with no console errors, nothing broken at any width, and every document in the repo describing what actually exists.
