# Phase 9 · The overnight run, 2026-08-10

**Status: every task on the list is done, deployed and verified, except the
items that need you — those are in MY MORNING LIST with exact steps.**

Six PRs (#25–#30), four production migrations in two snapshot-protected
batches, six production deploys, zero failed smoke checks, zero reverts. Three
bugs found and fixed along the way, one of them mine and caught in
self-review before it shipped. Everything below was read back from the live
system after the fact, not inferred from the command that caused it.

---

## 1 · Where the task list actually started

The list said "finish the durable dedupe fix, then merge PRs #20, #22, #23."
All of that had already landed before this run began: #20, #22, #23 **and**
#24 (the durable dedupe fix itself — "a claim records having succeeded, not
having been seen") were merged and deployed when I picked the tree up. What
was genuinely in flight was **PR #25** (reply-to → inquiry@footvault.in, plus
the serviceability limiter fail-closed fix), sitting open with green checks.

**The webhook dedupe check you asked for: both guards are already right.**
`recordAndApply` (payments) and `recordAndApplyRefund` (refunds) both follow
claim → apply → *release the claim on every failing path*, so a transient
failure is retried rather than tombstoned. Verified by reading both paths end
to end (`src/lib/payments/apply.ts`, `src/lib/orders/refunds.ts:557`); the
release-on-`not_found` branch is there too, so a dashboard resend can be
reprocessed. No fix was needed and none was made.

## 2 · Task A — reply-to, everywhere it was asked for

- **PR #25 merged** (`50f7f3a`), deploy verified READY + aliased to both
  hostnames, all routes 200, `/admin` anonymous 404. The diff was server-side
  only, so the serving check was deployment identity (commit SHA on the
  aliased deployment) rather than a content discriminator — said here because
  it is the one deploy tonight without a byte-level proof of serving.
- **site_settings.contact** already carried inquiry@footvault.in.
- **Contact page and returns policy** updated in the database (application
  writes, old bodies backed up first — see §9). The returns policy now names
  the address inside the 24-hour instruction while keeping call/WhatsApp
  first: with a one-day window, a synchronous channel is the safe advice.
- **Verified live on production**: footer mailto is inquiry@, the contact
  page names it, the returns page names it. These sat behind the hourly Data
  Cache for a while (my direct DB write bypasses the admin panel's tag
  revalidation — a known and accepted staleness), and all four surfaces were
  re-checked at the end of the night: all current.

**Bug found on the way**: the CMS page renderer displayed `**` and `- `
literally — the live returns policy had been showing raw asterisks to
customers since it was written. Root cause: the renderer splits paragraphs
and renders plain text with no emphasis or list handling, while the seeded
body was written in markdown-ish. Fixed in PR #26 with a minimal
bold+bullet renderer that builds React elements from split strings — still no
HTML path from the database into the page. Verified live: zero literal
asterisks on `/page/returns` now.

## 3 · Task B — the logo, and every place it changed

PR #26 (`b35a53b`). From `public/brand/logo-original.png`, three derived
assets (web transparent 512w, email flattened-on-white 320w, favicon on the
navy tile), all committed. Every place changed:

1. Storefront header (art + live wordmark text — at 40px the baked-in
   wordmark falls under 5px, so the name stays live text)
2. Mobile nav panel
3. Storefront footer (full lockup at 176px; its glow keeps it legible on navy)
4. Admin sidebar rail
5. Admin small-screen bar
6. Favicon — `src/app/icon.png` replaces `icon.svg`
7. Default social card (`/opengraph-image`)
8. Product social cards (per-product OG route)
9. All six order emails via `emailLogo()` — and `audit:emails` now asserts
   the logo per template the same way it asserts the reply-to

Verified: Playwright screenshots of header/footer/returns, both OG images
rendered and inspected, build clean, and the production deploy proven serving
by a chunk filename (`logo.262bt7namxm9m.png`) that exists only in this build.
The decorative tread-mark on error pages was deliberately left: it is a
watermark, not a brand placement.

**CI fix that rode along**: the repo gitignores `next-env.d.ts`, so CI's tsc
had never seen `next/image-types/global` — invisible until the first image
import. A committed `src/types/next-image.d.ts` carries the reference;
reproduced the CI failure locally (tsc with next-env removed) before and
after to prove it.

## 4 · Task C — coupons, the night's main build

**PR #27** (`9449f17`), three migrations applied to production first behind a
verified snapshot, then the code. §9F complete:

- **Schema**: `coupon_customers`, `coupon_redemptions` (unique per order,
  `released_at` explicit), `per_user_limit`, `audience`,
  `orders.coupon_discount` with the CHECK
  `discount_total = prepaid_discount + coupon_discount` (validated against
  all 16 existing orders before applying), `carts.coupon_code`.
- **Atomic redemption** inside `create_order_with_stock`: coupon row locked
  `FOR UPDATE`, all eight rules re-checked against the subtotal computed
  under that lock, discount recomputed from the coupon's own terms, ledger
  written, counter moved — one transaction with the stock claim.
- **Release on cancel** inside `cancel_order_with_restock`, idempotent, so
  the thirty-minute sweep gives codes back.
- **/admin/coupons**: list with state chips (live / off / not started /
  expired / used up), create/edit with **IST** windows, per-customer limits,
  audience picker with customer search, per-coupon redemption ledger showing
  released rows, enable/disable, delete only when never redeemed.
- **The cart field is live** on production — verified in a real browser
  against www.footvault.in: field appears with a bag, a bogus code gets the
  generic refusal.
- **scripts/audit/coupons.ts — 47 checks, all green**, including the one
  that matters: two orders fired at one remaining use *simultaneously*
  (`Promise.all`, two backend transactions racing the row lock) — exactly one
  wins, the loser is told "limit", `used_count` is exactly 1, exactly one
  ledger row. Plus: every refusal reason, rounding (up to the rupee, cap
  after), release-on-cancel idempotency, re-use after release, per-user
  limits, guest/audience refusals, RLS unreadability for anon *and* signed-in.

Decisions you had already made, implemented as stated: no stacking (larger
of coupon vs prepaid, named on screen — ties go to the coupon the customer
typed); release on cancel; specific reasons for expired/minimum/limit/used
and one generic sentence for no-such-code and not-for-you; goods only.
Decisions that were mine, recorded: **disabled and not-yet-started codes also
read as the generic "did not work"** (a disabled code should act like it never
existed; a pre-launch code should not confirm itself early), and **guests are
not refused by per-user limits** (a cookie cannot be counted; the honest
guest should not pay for that, and `usage_limit` still bounds the spend).
Also: `%`/`_` are escaped before the `ilike` lookup, so the coupon field
cannot be used as a wildcard probe.

**The bug I caught in self-review, and what now guards it**: the function's
first version referenced `v_coupon.code` inside the orders INSERT. PL/pgSQL
parses that expression whether or not its CASE branch runs, and an unassigned
record has no tuple structure — so **every couponless order failed with
SQLSTATE 55000 while every coupon test passed**. Caught because
`audit:checkout` runs the couponless path; fixed with mirrored scalar
variables; and `audit:coupons` now *opens* with a couponless order so the
"new feature broke the shop for everyone not using it" shape can never hide
again. This is the single most important near-miss of the night.

**CI caught me once more**: twelve reads in the new gate dropped their query
errors (`footvault/no-unchecked-supabase-error`) — my local lint predated the
file. Fixed; every read in the gate now throws or logs.

## 5 · Task D — running the shop

### Add to bag: 822 ms → the same frame as the tap (PR #28, `8d47c5f`)

Root cause as the plan suspected: `revalidatePath("/", "layout")` re-rendered
the category tree, brand list and settings on every route to move one number.
Now: an optimistic **delta** in the bag store (never a count of its own — the
Phase 4 rule about client-held counts stands), shown as `server + delta`,
retired before paint the moment any navigation delivers a fresh server count.
Every move pairs with its rollback: add, add-undo, quantity steppers
(including the capped answer), remove, remove-undo, wishlist move-to-bag. The
screen-reader announcer follows the same displayed count. `refreshBag()` now
revalidates `/cart` alone.

**Measured**: staged production build, click → visible badge change, five
runs: 17/21/22/25/41 ms — **median 22 ms** (from 822 ms). On production
itself a MutationObserver shows the badge label mutating within the same
frame as the tap on every run. (An earlier production "median 811 ms" I
measured was an artifact — Playwright's click stalling on the toast overlay,
not UI latency; recorded here because I briefly believed it.)

### /admin/health (PR #29, `b09cb49`)

One screen for everything that fails silently, every section degrading to an
honest "could not read": Razorpay key mode + last real (non-callback)
webhook; Shiprocket sign-in state including the auth-failure latch that
blocks shipping, and the wallet with its low line; **stuck orders** in the
three shapes you named — captured-not-confirmed past 15 min (FV-2026-00623's
shape), confirmed-untouched past 48 h, shipped with no tracking (or an
unpolled tracker) past 72 h — thresholds are operational judgment, written
down as such, none touches what a customer pays; stock drift via
`reconcile_inventory()`; and the pg_cron schedule via a new
`cron_health()` SECURITY DEFINER (service_role only), because `cron.job` is
invisible to PostgREST and a dead sweep is invisible until it does damage.

Production cron read back after the migration: all four jobs active, all
last runs `succeeded`. The page found its own first bug before merge —
`integration_tokens` grants no browser role anything (it holds a bearer
token), so the RLS read rendered 42501; it now goes through the admin client
behind the page's double admin lock.

### Gate coverage (PR #30)

`audit:refunds` and `audit:rto` already held their corners (read and
confirmed, not rewritten). What nothing covered was **order transitions**
and the **inventory ledger's balance claim** — `audit:transitions` (26
checks) now does: the matrix's structural promises (terminal states stay
terminal; `returning` can neither deliver nor cancel), one history row per
fulfilment step, refusals, **two simultaneous presses both reporting success
while the order moves exactly once** (the CAS under its real race),
delegated cancellation restocking exactly once, the ledger naming
`order:-1` / `cancellation:+1`, and `reconcile_inventory()` at zero drift
over the run's variants. Registered in `run-all` and `package.json`.

## 6 · Production migrations, snapshots, and their verification

Two batches, each behind a fresh snapshot taken immediately before and
verified **by content**:

| Snapshot | Verified | Protected |
|---|---|---|
| `backup-20260810-0258-*` | 33 tables / 58 policies / 29 functions / 60 indexes; 2,071 data rows incl. `auth` (11 users); per-table counts diffed against live — orders 16=16, variants 403=403, movements 709=709; newest order FV-2026-00623 present; ends `RESET ALL;` | coupons batch (3 migrations) |
| `backup-20260810-0315-*` | 35 tables (the two new coupon tables present), 36 insert blocks, same shape checks | `cron_health` |

Both batches were **dry-run first** (exactly the expected migrations pending,
nothing else), drop targets resolved via `to_regprocedure` with exactly one
overload each before and after, and the coupons batch was gated the Batch A
way: PostgREST accepts the new `p_coupon_code` shape (A), **the deployed
23-parameter call still resolves** (B — the live shop was safe during the
window), cancel resolves (C), anon refused 42501 (D). Staging was rebuilt
from empty with all 94 migrations green before production was touched, and
the full migration set + seed verification passed.

Backup files are on disk in the repo root, correctly gitignored.

## 7 · Every deploy, in order

| # | PR | Commit | What | Smoke check |
|---|---|---|---|---|
| 1 | #25 | `50f7f3a` | reply-to + limiter | routes 200, admin 404, deployment identity |
| 2 | #26 | `b35a53b` | logo everywhere + CMS renderer | routes 200, `logo.262bt7namxm9m.png` serving, icon.png 200, OG 84,651 B |
| 3 | #27 | `9449f17` | coupons | routes 200, coupon field live in a real browser, generic refusal verified |
| 4 | #28 | `8d47c5f` | optimistic badge | routes 200, badge mutation traced in-frame on production |
| 5 | #29 | `b09cb49` | /admin/health + cron_health | routes 200, /admin/health anon 404 |
| 6 | #30 | `736815a` | transitions gate (scripts only) | routes 200, admin 404 |

Zero failed smoke checks; the two-consecutive-failures stop rule never armed.

## 8 · What I got wrong and caught

1. **The unassigned-record bug** (§4) — mine, would have broken every
   couponless order; caught by running the neighbouring gate before shipping.
2. **Local checks that lagged my edits, twice**: the coupons gate went up
   with a stale lint pass, and the transitions gate with a stale typecheck
   pass — both caught by CI/Vercel, both fixed within minutes, neither
   reached main. The lesson is procedural: the *last* edit gets the full
   local battery, not the second-to-last.
3. **The markdown asterisks I nearly added**: my first page-content edit
   used `**bold**` before I read the renderer and found it plain-text — which
   is also how the pre-existing customer-facing bug was found. Self-caught.
4. **A wrong production latency reading** (§5) believed for about ten
   minutes, then disproved with a MutationObserver trace.
5. **An early misreading of the logo's alpha channel** as broken; compositing
   properly showed it was fine. Cost: a few minutes, no code.

## 9 · Autonomous decisions, one line each

- Returns-policy wording keeps call/WhatsApp first, email second, inside the
  24-hour window — a synchronous channel is the safer advice for a deadline.
- Disabled and not-started coupon codes collapse into the generic refusal —
  refusing to confirm a code exists beats a marginally more helpful message.
- Coupon ties (coupon == prepaid) go to the coupon — it is the name the
  customer typed and expects on the receipt.
- Guests bypass `per_user_limit` (uncountable for a cookie), bounded by
  `usage_limit` — never punish the honest guest for the shop's blindness.
- Stuck-order thresholds 15 min / 48 h / 72 h — operational judgment,
  changeable in one constant, charging nobody anything.
- Old page bodies backed up to the session scratchpad before editing, not
  into the repo — content backups are operational artifacts, not source.
- The decorative error-page tread mark kept as-is — it is a watermark, and
  the task named brand placements.

## 10 · Known imperfections, honestly listed

- **Coupon preview vs authority duplication**: the eight rules live twice
  (TypeScript preview in `validate.ts`, binding SQL in the function). They
  are gate-held in agreement, but a ninth rule added to one and not the
  other would drift; a single SQL "preview" RPC would remove the twin.
- **`audit:admin-pages` carries one unrelated red**: "a Pay-on-Delivery
  order exists to inspect — none found" — a fixture gap from tonight's
  staging rebuild (fresh staging has no COD order), not a product defect.
- **Staging's `reconcile-abandoned-orders` cron fails** with "vault is
  missing cron_secret or cron_target_origin" — staging's Vault was never
  given the two secrets. Production's runs fine. Either set them in the
  staging Vault or accept staging has no reconciler.
- **Order confirmation emails**: `order-confirmation.ts` still has private
  copies of `escapeHtml`/`addressLines` beside the shared module's — working,
  asserted, but duplicated.
- **The optimistic badge can under-count for one frame** in a rare race
  (navigation request racing a just-fired add), self-corrects on the next
  navigation; the layout-revalidate approach had the same window.
- **The health page's drift check on staging** reads "0 sizes" because
  seeded variants carry no opening-balance movements there;
  `reconcile_inventory` only reports variants with ledger rows. On
  production (709 movements) it is meaningful.
- **`/admin/health` was verified on staging as an admin and anon-404 on
  production**, but not driven as a signed-in admin on production tonight —
  I have no production admin session and did not create one.
- **Migration files edited in place during development** (the 55000 fix)
  after staging had applied them — staging was re-synced by hand and the
  final file replays clean from empty, but the intermediate state briefly
  diverged from the file of record. Production only ever saw the final file.

## 11 · MY MORNING LIST — exactly what needs you

1. **Replay the three stuck inbound messages** (Resend dashboard → Inbound →
   the three 2026-08-09 messages recorded in `inbound_emails` with
   "could not fetch the message body" → Resend's *resend/replay* action on
   each). The claim-release fix (#24) means replays will now be processed
   and forwarded. Two minutes.
2. **Set the Shiprocket wallet low-balance line**: /admin/settings →
   shipping → wallet low-balance. The health page and dashboard both say
   "nothing is watching this number" until you pick it. Your number, per the
   standing rule — I built nothing that invents it.
3. **Create your first real coupon** when you want one: /admin/coupons →
   Add coupon. Everything is live and gate-proven; there are deliberately
   zero coupon rows in production because a discount value is a number that
   changes what a customer pays.
4. **Glance at /admin/health once signed in** — first human look at the new
   page against production data (see §10, seventh bullet).
5. **Optional, staging only**: put `cron_secret` + `cron_target_origin`
   into the staging project's Vault if you want staging's reconciler cron
   green (Supabase dashboard → staging project → Vault; copy the shape from
   production's entries).

## 12 · Current production state — live now that was not at 21:30

- Reply-to on all order and incident email is inquiry@footvault.in; the
  address is named on the contact page, the returns policy, the footer, the
  damage message and the order templates.
- The serviceability limiter fails closed (in-memory ceiling) so a database
  blip cannot let a scraper spend Shiprocket quota.
- The real logo everywhere (§3), including favicon and both social cards.
- The returns policy renders bold and bullets properly for the first time.
- Coupons: schema, atomic redemption, release-on-cancel, admin screen, live
  cart field — mechanism complete, zero codes defined.
- Add to bag responds in the same frame as the tap.
- /admin/health, backed by `cron_health()` in the database.
- `audit:coupons` (47 checks) and `audit:transitions` (26 checks) in the
  gate suite; `audit:emails` grew per-template logo assertions.
- Four production migrations, two content-verified snapshots on disk.
- Database rows: `pages.contact` and `pages.returns` updated; **no other
  production data written** beyond normal application writes (two throwaway
  guest carts from browser verification, both emptied).
