# Overnight scan and fix — 2026-08-20, ~01:55–03:30 IST

Full-repository scan organised by the six failure classes, plus the eleven
specific items in the brief. Six commits shipped and verified serving on
production; the seventh (this report + README) follows the same battery.

**TL;DR for the first coffee:** the "missing" Deployed-build card was on the
page the whole time — rendered third with a comment claiming it was first; it
is now first and needs **no token, ever**, because the repository turned out to
be public. The image pipeline **FLATTENS transparency onto #ffffff** — but
your originals are kept, so it is reversible; read item 10 before uploading
the 122 photographs. Two of your "still broken" items were already fixed on
the 15th. The phone sweep you asked for found four more built-but-unreachable
bugs on its first run; all four are fixed. `payment_methods` is deleted, with
the row snapshotted first. NEW10 is worse than you think: 5%, **no cap at
all** in the row, no usage limits, no expiry.

---

## 1 · Decisions, what was rejected, and why

**D1 — The Deployed-build card: moved, not rebuilt.** It shipped and it
renders; it was placed third (below the key cards and Stuck orders) while its
own comment said "first section on the page, above everything else". You saw
Razorpay keys first and reasonably concluded the card was absent. Rejected:
treating this as a deploy failure (production serves the code; `/api/version`
proved it) or as a rendering bug (a staging browser run showed it rendering).
The fix is one move plus a comment that now sits beside code that actually
holds the position it claims.

**D2 — The card's verdict: tokenless, because the repo is public.** The check
shipped believing the repository private and demanding `GITHUB_REPO_TOKEN`.
`gh repo view` says `"visibility": "PUBLIC"`. So the GitHub call now runs
unauthenticated — verified from here returning the exact tip
(`9c2aa63b…`) — and a token is only rate-limit headroom (60/hr shared per
Vercel egress IP vs 5,000/hr). Rejected: writing you click-by-click token
instructions as the *path* to a verdict, because that would have made you do
work the facts don't require. **You need to do nothing.** If the card ever
says "GitHub answered 403", the message itself now names the remedy; the
optional clicks are in docs/operations.md.

**D3 — Chip vocabulary: the word is the condition, severity is only the
colour.** `Panel` derived every bad card's word from tone, so a low wallet
said WRONG. Rejected: changing tones or thresholds (the ₹500 line untouched,
as instructed), and rejected a generic "alert" word — a word that overstates
teaches the same lesson as a tick that understates. Each card now passes its
own word: wallet `low`, webhook `behind`/`silent`, sign-in `locked out`,
pickup `missing`/`wrong`, could-not-read everywhere is `unread`. `wrong` is
reserved for things that are wrong (key mismatch, pin mismatch).

**D4 — The pickup card's Cuddapah: stop echoing Shiprocket, don't chase their
data.** The string never lived in this repo or its database — Shiprocket's own
pickup record maps PIN 516360 to city "Cuddapah" (I called their API
read-only and confirmed: `{nickname: warehouse, postcode: 516360, city:
"Cuddapah"}`). Rejected: asking you to edit the address in the Shiprocket
panel (their pincode gazetteer may re-derive it, and nothing operational keys
off their city field), and rejected substituting "Proddatur" parsed from our
contact row (fragile parsing to decorate a card whose real assertions are the
nickname and the PIN). The card now states exactly its two load-bearing facts
and prints nobody's gazetteer. Sibling sweep across /admin: the only other
`city`/`state` render is the order detail page showing the **customer's**
address — correct by definition. The health card was the one and only sibling.

**D5 — payment_methods: deleted, not wired.** Your instruction was decide.
Wiring was the one forbidden option in disguise: the row says `online: false`,
so connecting it to checkout would have switched off live online payments —
"do not touch money" — and flipping the value first is a payment-settings
change by another name. The row had zero readers (its own seed description
admitted it), was public, and was false. Deleted everywhere at once so
audit:settings-visibility stays green in both directions: production row
(snapshot first — see §5), both seeds, the classification entry (now a
comment recording the decision), plus a new rebuild:stage check that fails if
a reseed resurrects it. If you want an online-payments kill switch, it should
be designed against checkout's real gate, deliberately.

**D6 — audit:security's six reds: the checks were wrong, not the shop.** All
six expected 404 from routes that have deliberately answered "200 carrying
the not-found body" since 2026-08-10 — the order page documents the contract
at length and *names this file as the thing to bring up to date*. Two
replacement oracles were tried and rejected **with measurements** (see §7,
"what went wrong"): the status line, and a marker attribute in the not-found
body — the App Router serialises that template into every page's flight
payload, found pages included, so a marker matches everything and a marker
*count* measures boundary nesting, not outcome. What discriminates is
disclosure: every fixture order ships to "Security Runner", which renders
only for an authorised viewer and cannot be derived from the URL (the order
number can — it echoes into the router payload for everyone). Strangers,
neighbours, and imaginary orders must not carry it; the owner's page must,
which is the positive control that keeps every "withheld" honest. Also
rejected: "fixing" the 200 by deleting loading.tsx — that trades every real
customer's skeleton for a tidier status code on a noindex page, and buys no
secrecy the body isn't already keeping.

**D7 — audit:security's exclusion reason was a lie, replaced not promoted.**
run-all EXCLUDED said "superseded by audit:security-advance" — false exactly
the way audit:actions' old reason was false, and run-all's own audit:actions
entry says so at length: they test different layers (data layer with a
customer JWT vs page/webhook layer over HTTP). Rejected: adding it to GATES —
its later sections read `.next/static`, so under the suite's dev server its
positive control fails and every refusal would mean "the request never
arrived". It is now a named deploy gate beside audit:actions in staging.md
§4.4, with the true reason in EXCLUDED.

**D8 — Categories on a phone: responsive placement, not a kebab menu, not
sticky columns.** The sweep found eleven buttons per screen of rows at
x=473–741 on a 360px viewport. Rejected: `stickyEnd` on both action columns
(~340px of pinned buttons on a 360px screen leaves ~20px of data); rejected
collapsing the arrange buttons into a dropdown — CategoryRowActions documents
at length why four buttons beat drag-and-drop *and* beat hiding things behind
menus for this owner. Chosen: below `sm` the same controls render inside the
first cell (always at x≈0), and the action columns exist from `sm` up.
`display:none` keeps the hidden copy out of the tab order and the
accessibility tree, so nothing is announced twice.

**D9 — Appearance previews: `inert`, not restyled.** The clipped "Save
Gel-Nimbus 27" buttons are storefront wishlist hearts inside the "Live now"
homepage render — a picture of the homepage that happens to be built from
live components. Rejected: widening the container or making it scroll (you'd
be "operating" a preview whose actions half-work), and rejected removing the
render (it is load-bearing for Preview — the action-returned-JSX/route-manifest
trap). `inert` makes both renders what they claim to be: something you look
at. Bonus: ~30 decorative tab stops vanish from between you and the editor.

**D10 — images.ts WELLS: hand list kept as a floor, derived tripwire added on
top.** Pure derivation was rejected after checking the tree: several wells
render the (already-square) variants without `object-contain`, so once
`bg-photo` is removed from one of them it has **no lexical signature left** —
a derived-only check would un-cover exactly the regression the list exists to
catch. The hand list cannot see a *new* well, so a derived rule covers that:
every `object-contain` component must pad with `bg-photo` or be exempted with
a reason (brand marks are, with the reason). The gate's comment now states
plainly what neither half can see: a well that neither contains nor pads.

**D11 — Free delivery ₹6,499 vs ₹1,599: the row is the truth; prose loses the
right to state it.** The live row reads `free_above_paise: 159900` (₹1,599),
the announcement bar prints it correctly, checkout charges by it. Every
₹6,499 was prose: docs/admin-guide.md's "Today" column (also wrong about the
prepaid discount — it said "none", the row holds flat ₹20 = 2000 paise),
plus four code comments claiming currency. Rejected: updating the Today
column to ₹1,599 — that re-arms the same drift. The mechanism that makes
re-drift impossible is that **the number is no longer stated anywhere**: the
guide describes each control and sends you to the screen, and audit:literals
§3 now fails any committed document that grows a "Today" column (red control
proven — see §4). Comments claiming a current value were date-scoped or
reworded.

**D12 — emails "every email": widen to actually-every, plus a tripwire.** The
tree exports 7 builders; the audit exercised 5 under a header saying "every
email". The two operator alerts are now built and asserted on what they must
name (the directive/URI, the path/method), and exempted **by name with the
reason** from order-email properties they cannot have (no order number, no
storefront logo on a pager message). A derived check greps `src/lib/email`
for `build*Email` exports and fails on any this file never calls. "all five
agree on one reply-to" became "all ${built.length}" — a count in a label is a
claim too.

**D13 — Temp proof harness placed inside scripts/audit/, then deleted.** My
first standalone probe hung on env bootstrap; the working version had to live
in scripts/audit/ to use the house `./clients` guards — which also meant an
untracked file sat inside gate-scanned territory for its lifetime. It ran
both credential guards, restored the brand it nulled (gate proofs must
restore data), deleted its probe account, and was removed before any commit.

## 2 · Findings that contradict what we believed

1. **The repository is public.** The entire GITHUB_REPO_TOKEN requirement
   rested on "the repository is private". It isn't. (This also means the
   *code and docs are world-readable* — worth being deliberate about, see
   morning list #4.)
2. **The brief's literals.ts and keyboard.ts items were already fixed** —
   commit `65ecb17` (2026-08-15) gave literals §1 `--cached --others
   --exclude-standard` and keyboard.ts both credential guards. Verified in
   the tree tonight, not just in the log. The brief was working from a stale
   picture; the *same class* did still exist elsewhere — focus-ring.ts and
   customer-copy.ts carried plain `git ls-files` — and those are now fixed,
   with scan counts printed and zero-scan refusal.
3. **`npm run audit` has been red on drift since PR #47 landed** — three new
   audits (admin-mobile, permanent-delete, deploy-drift) were in package.json
   and in neither GATES nor EXCLUDED. The suite's own drift check was doing
   its job; nobody had run the suite since.
4. **audit:images had two reds against a correct pipeline** — both checks
   held private copies of the *old* CARD_SURFACE (a fixture built on fog
   claiming to be built on the pad colour; an inline `0xee/0xf1/0xf5`
   expectation). The white-pad change was right; the checks were asserting
   the past. Both now derive from the `CARD_SURFACE` import.
5. **NEW10 has no cap.** The brief said "capped at ₹500". The row:
   `type: percent, value: 5, max_discount: NULL, min_order: 0,
   usage_limit: NULL, per_user_limit: NULL, expires_at: NULL, audience:
   everyone, used_count: 0`. It is also advertised nowhere — no page,
   homepage section, or setting mentions it. Reported only, per your
   instruction; nothing touched.
6. **The not-found template is in every page's flight payload** (and the
   swap arrives as flight rows, never server-rendered markup) — which
   killed the "obvious" body-marker oracle for the enumeration checks and
   is recorded in security-checkout.ts and in memory.

## 3 · The specific items, one by one

1. **Deployed-build card** — was on the page, third; now first (D1). Verdict
   is real without any configuration (D2). Verified on staging by a browser
   run reading the H2 order: `["Deployed build", "Stuck orders", "Stock
   ledger", "Scheduled jobs"]` with the key cards between the first two.
2. **Status vocabulary** — done (D3). Staging render shows
   `Razorpay keys [wrong]` (staging's keys genuinely mismatch), `Pickup
   address [wrong]` (staging's seeded PIN vs Shiprocket), `wallet [ok]`,
   `webhook [ok]`, `parcels [ok]`. The wallet's low state now reads `low`.
3. **Admin `<main>` + skip link** — added, storefront idiom including the
   Safari `tabIndex={-1}` note. Staging: exactly 1 main landmark, 1 skip link.
4. **literals.ts §1 untracked blind spot** — already fixed 2026-08-15
   (`65ecb17`); §1 additionally widened tonight from components/+app/ to all
   `src/**/*.tsx`, and the summary claim narrowed to match coverage.
5. **keyboard.ts credential guard** — already present since `65ecb17`: both
   `assertNotProduction` (line 37) and `assertServerNotProduction` (in main).
   Nothing to add.
6. **audit:security 6 reds** — settled (D6); whole gate green, exit 0.
7. **payment_methods** — deleted with snapshot (D5).
8. **Brand deleted under products** — FK is `ON DELETE SET NULL`; all five
   render paths null-guard (card renders an empty brand slot that keeps the
   row for the heart button; PDP/wishlist/search omit the line; JSON-LD omits
   `brand`). Proven live on staging: brand nulled on Air Max 90, PDP and
   listing rendered with **no "undefined" anywhere**, then the brand was
   restored and verified restored.
9. **Free delivery ₹6,499 vs ₹1,599** — reconciled + drift made structurally
   impossible (D11).
10. **Image pipeline and your 122 transparent cutouts — READ THIS ONE.**
    **The pipeline FLATTENS. Alpha does not survive.** `normaliseProductImage`
    runs `flatten({ background: CARD_SURFACE })` — CARD_SURFACE is `#ffffff` —
    before the resize, and every stored variant is WebP with the transparency
    composited onto white. A transparent 2000×2000 cutout becomes a shoe on
    an opaque white square, permanently, in every displayed size. **Two
    things keep this from being irreversible:** (a) your original upload is
    stored untouched in the bucket and `original_path` is on the row, and
    (b) `npm run images:reprocess` rebuilds every derivative from originals —
    so a future decision to preserve alpha (or pad with a different colour)
    is a pipeline change plus a reprocess, **not** a re-upload of 122 files.
    The flatten is deliberate (consistent card surfaces; the pad colour
    hashes into the storage path). Upload away — just know the displayed
    pixels will be flat white-padded, and keep the originals bucket intact.
11. **NEW10** — reported in §2.5. Decision is yours; the row is riskier than
    the brief believed (uncapped, unlimited, non-expiring) even at 5%.

## 4 · The failure classes

**Class 1 — verification that cannot discriminate.** Mechanical pass over all
80 audit scripts + 2 CI scripts: every gate has a real failure path (the
apparent exceptions are libraries and capture tools: action-post.ts,
screenshots.ts, routes.ts/states.ts/fixtures.ts/clients.ts/scanned.ts).
Literal-`true` `check()` calls were reviewed: all are narration after a
`waitFor`/insert that throws on failure — enforced, if inelegant. The night's
two live class-1 catches: audit:security's six checks red against a contract
the shop was honouring (a red that cannot go green is the mirror image of a
green that cannot go red — both stop discriminating), and audit:images' two
stale-constant reds. I did **not** re-derive "what would broken look like"
for all ~80 files at full depth; the ones I changed are proven in §7, and the
class has had four prior hardening passes. Honest residual: unreviewed-tonight
gates are at yesterday's assurance level, not tonight's.

**Class 2 — hand-maintained lists.** Found and converted/tripwired:
run-all's undeclared trio (the list *policing* worked; the list *membership*
had rotted), emails' 5-of-7 builders (derived tripwire added), images' WELLS
(floor + derived rule, D10), literals §1's two-directory scope (widened).
Reviewed and deliberately kept as reasoned allowlists (house pattern, each
entry carries its reason): focus-ring's ALLOWED_OUTLINE_OFF, literals'
ALLOWED map, settings-visibility's classification (the gate cross-checks it
against the DB in both directions — that is a *specification*, not a rot-prone
list), fixtures-guard (derives from `readdirSync`), admin harnesses (derive
from ADMIN_NAV). All derived checks print scan counts and refuse zero:
188 sources (focus-ring), 38 (customer-copy), 25 documents (literals §3),
6 contain-fit components (images), 7 builders (emails), per-page control
counts (admin-mobile sweep).

**Class 3 — scope vs claim.** The Cuddapah card (D4) — the sweep that said
"zero everywhere" was true of everything it could reach; the card echoed a
third party the sweep could never see. Fixed at the card, and the sibling
sweep found no others. Also fixed: literals' "No policy number is typed
anywhere" (now names its four scopes), emails' "every email" (now true by
force), "all five agree" (now a computed count), images' "every well" (now
states what it cannot see). audit:security's claims got the same treatment —
each check names the observable it actually measures.

**Class 4 — local patches that belong in the primitive.** The named example
(CouponForm's dialog overflow) was already in the primitive since PR #47 —
dialog.tsx's comment tells the story. Tonight's finds: `stickyEnd` existed on
`Th` but not `SortableTh`, so a sortable actions column couldn't be pinned
(now it can, and inventory uses it); `min-w-0` was every grid's job instead
of `Panel`'s (now the primitive owns it — the dashboard bug could have
recurred on any future grid).

**Class 5 — built but unreachable.** The sweep you specified now exists as
audit:admin-mobile §4: every ADMIN_NAV page × {360, 390}px, every interactive
element, boundingBox against the viewport, with three failure kinds —
off-screen with no scroll path, clipped by overflow-hidden, and *button
beyond the viewport inside a scroller* (an action you discover by dragging a
table sideways is the brands bug, scroller or not). `inert` subtrees are
skipped: unreachable by design is the opposite finding. First run: **8
failures, 4 distinct bugs** — dashboard (Panel min-w-0), inventory
(stickyEnd), categories (responsive actions, D8), appearance (inert, D9).
Second run: **43/43 green at both widths.** Known limit, stated: detail pages
(`/admin/orders/[id]`, `/admin/products/[id]`, `/admin/coupons/[id]`) are not
in ADMIN_NAV and are not swept.

**Class 6 — shell and exit-code traps.** No live `grep -P`, no piped gate in
CI or docs (the references found are all historical narration in comments).
The last two plain `git ls-files` are fixed (class 2 overlap). package.json
scripts use sh-safe constructs. **And I fell into the trap myself tonight**:
read `$?` after `npm run audit:images | grep …` and got grep's 0 while the
gate was exiting 1 — the exact pattern the brief names. Re-ran pipe-free;
every exit code in this report was read directly (§6).

## 5 · Database changes and their snapshots

One production write: `delete from site_settings where key =
'payment_methods'` (D5).

- **Proven first** on staging from empty: `npm run rebuild:stage` replayed
  all **119** migrations including the new one, reseeded, and passed every
  verification including the new "payment_methods has not been reseeded"
  check. Exit 0.
- **Snapshotted before production**: `DB_Backups/backup-20260820-0228-schema.sql`
  (193K) and `-data.sql` (522K), both content-verified non-empty and the data
  dump verified to contain the row it protects. The migration header also
  quotes the exact row for a one-line restore.
- **Applied** via the migration path (recorded in schema_migrations), then
  verified: 12 rows remain, 0 named payment_methods. The delete is idempotent.
- PostgREST: DML only, no DDL, no schema-cache implications.

The staging DB was also rebuilt from empty as a side effect (the standard
proof); QA fixtures were re-seeded by the same run. One staging product's
brand was nulled for the render proof and **restored, with the restoration
verified** (gate proofs restore data).

## 6 · The six-job battery — exit codes read without a pipe

Each job ran as `npm run <job> > log 2>&1; echo $?` — the status is the
job's own, not a filter's. Run at the final tree (commit `9c2aa63`):

| # | Job | Exit | Scan count |
|---|-----|------|-----------|
| 1 | typecheck | 0 | — |
| 2 | lint | 0 | — |
| 3 | shapes | 0 | cached shapes match SHAPE_VERSION |
| 4 | guard:use-server | 0 | 28 "use server" files scanned |
| 5 | guard:client-imports | 0 | 98 client files × 76 server-only modules |
| 6 | build | 0 | production build, real data |

## 7 · Red control and green result, per gate built or changed

| Gate | Red control | Green result |
|---|---|---|
| audit:security (6 settled checks) | The original run: 6 FAIL on stale 404s. Plus two *rejected oracles proven wrong by measurement*: body-marker run failed its own positive control ("marker PRESENT — vacuous", owner page), count-based run failed it again (owner page ×2). The positive control — the owner's page must render "Security Runner" — is the standing red path: if disclosure ever leaks, the stranger checks print LEAKED; if rendering breaks, the control prints MISSING and calls every "withheld" unproven. | Full gate: "All checks passed", exit 0, against the staging build |
| audit:admin-mobile §4 (new) | First run against the pre-fix build: **8 failures** with kinds and coordinates (that run *is* the discriminance proof — it found four real bugs) | Second run: 43 passed, 0 failed, both widths |
| audit:literals §3 (new) + §1 widened | Untracked `docs/__red-control.md` with a Today column → exit **1** (also proves untracked coverage); removed → exit 0 | Full gate green: 25 documents, "No policy number is typed in code, documents, or owner content", exit 0 |
| audit:emails (2 builders + tripwire + operator split) | Mid-fix run: **4 failures** (operator emails failing order-email properties — the properties fired on new inputs). Tripwire red path: any exported builder absent from the file fails by name | 78 passed, 0 failed |
| audit:images (2 stale reds + contain tripwire) | Pre-fix run: 2 FAIL, exit **1** (pipe-free) — stale constants condemning a correct pipeline | 85 checks all green, exit 0; tripwire lists 6 contain-fit components, 2 exempt with reasons |
| audit:focus-ring / customer-copy (untracked + scanned) | Zero-scan refusal is `scanned()`, whose exit-1-on-empty behaviour is the shared property (proven above by the literals §3 control being an *untracked* file) | Exit 0; "scanned 188 component sources", "scanned 38 customer-facing sources" |
| run-all declarations | Pre-fix: drift computation named `admin-mobile, permanent-delete, deploy-drift` undeclared (suite exits 1 on drift) | Post-fix computation: "(none)" |
| audit:settings-visibility (after the row delete) | The gate itself is unchanged; its red path (orphaned classification / unclassified row) is what forced the delete to land atomically | 16 checks all green against production |
| audit:deploy-drift (unchanged, exercised) | `--expect <sha>` override exists and announces itself | serving 9c2aa63 = origin/main 9c2aa63, exit 0 |

## 8 · Deploy record

- Commits, in order: `45f30c8` (health), `e69070b` (a11y shell), `997e7dc`
  (sweep + 4 fixes), `4039374` (audit hardening), `6cfcc17`
  (payment_methods), `9c2aa63` (docs). Pushed to origin/main 03:10 IST.
- One production deployment, created 03:11:09 IST, `target: production`,
  `status: Ready` — and, separately from READY, **verified by content**:
  waited out the build window polling `GET /api/version` until it reported
  `9c2aa63…` (no single immediate curl), then `npm run audit:deploy-drift`
  → serving == origin/main, exit 0. No blocked deployments tonight.
- The report/README commit that follows this file will be verified the same
  way.

## 9 · What went wrong (including reverts)

1. **Two wrong oracles for the enumeration checks, both reverted.** I added a
   `data-not-found` attribute to NotFoundBody and asserted on it — the
   gate's own positive control caught it matching the owner's page (the App
   Router ships the template in every flight payload). I then tried marker
   *counts* — the positive control caught that too (counts measure boundary
   nesting). The attribute was removed from the component, with a comment
   recording why, and the disclosure oracle replaced both. The lesson is in
   memory: status and body-marker are both dead oracles for streamed
   not-found; assert content disclosure.
2. **I read an exit code through a pipe** — `audit:images | grep` showed
   "exit 0" over a failing gate, the exact class-6 trap. Caught within a
   minute because the printed "2 of 85 failed" contradicted it; re-ran
   pipe-free. Every code in §6/§7 was read directly.
3. **My first proof harness hung** (5-minute timeout) — standalone script
   without the house env bootstrap. Rewritten inside scripts/audit/ using the
   `./clients` guards, then deleted after use (D13).
4. **A red-control attempt was blocked by the permission classifier** (it
   included a `git checkout` restore step). Redesigned as an untracked
   control file + `rm` — which turned out to be the *better* control, since
   it also proved untracked coverage.

## 10 · What was NOT fixed, and why

1. **NEW10's terms** — yours to decide, per the brief. Report in §2.5.
2. **The Shiprocket-side "Cuddapah" record** — their data; nothing
   operational reads their city field; our surface no longer echoes it.
3. **The pipeline's flatten** — deliberate behaviour, loudly reported (item
   10); changing it is a product decision about how the catalogue should
   look, not a defect. Reversible via reprocess if you decide.
4. **Sweep coverage of admin detail pages** — §4/class 5; the sweep walks
   ADMIN_NAV. Extending to representative detail pages needs fixtures per
   page type; a night could be spent there alone.
5. **Full-depth class-1 re-derivation of all 80 gates** — the mechanical
   pass ran over all of them; deep re-derivation covered the gates touched
   tonight. Stated plainly rather than claimed.
6. **`npm run audit` full suite end-to-end** — the six-job battery shipped
   every piece per the brief's own bar, and every gate I changed ran
   individually green, but the full 60-gate suite (~an hour of browser time)
   was not run tonight. The drift check inside it is proven clean, so the
   next run starts from a declared roster.
7. **Coins/loyalty numbers, wallet threshold, refunds FV-2026-00668 /
   FV-2026-00571** — explicitly yours; untouched.
8. **The `[wrong]` chip on staging's Razorpay keys card** — correct behaviour
   on staging (test keys), nothing to fix; noted so the screenshot doesn't
   read as a defect.

## 11 · Waiting for you in the morning

1. **Nothing to configure for the Deployed-build card.** Open /admin/health:
   it is the first section and should read `in sync with main` with no token.
   If you ever see "GitHub answered 403", *then* add `GITHUB_REPO_TOKEN`
   (fine-grained PAT, read-only Contents on footVault) in Vercel → Project →
   Settings → Environment Variables; the card's own message will remind you.
2. **NEW10 decision**: rename to NEW5, or set value=10 — and in either case
   consider `max_discount`, `usage_limit`/`per_user_limit`, and `expires_at`;
   the row currently has none of them. One SQL update or the coupons admin
   page; say the word and I'll queue it.
3. **Decide whether the free-delivery threshold is meant to be ₹1,599.** The
   row is authoritative and everything prints it consistently now — but the
   brief remembered ₹6,499, so confirm the *value* is intentional, not just
   consistent.
4. **Confirm the repository being public is intentional.** Code, docs (with
   operational detail), and this report directory are world-readable. If
   deliberate, fine; if not, flipping it private will require the
   GITHUB_REPO_TOKEN path from item 1 for the health card.
5. **122 uploads**: proceed knowing the pipeline flattens onto white (report
   item 10). If you'd rather see them alpha-preserved on `--fv-photo`, say so
   *before* is cheapest — but even after, it's a reprocess, not a re-upload.
6. **Categories on your phone**: the arrange/edit controls now sit under each
   category name below 640px. Worth 30 seconds of your thumbs to confirm the
   layout feels right, since I chose placement over a menu (D8).
7. Optional: extend the sweep to detail pages (not-fixed #4) and/or run the
   full `npm run audit` suite when the machine is free.
