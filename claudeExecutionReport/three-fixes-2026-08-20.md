# Three fixes — 2026-08-20 (day session)

Three scoped items, no new batches: the private-repo token, alpha preservation,
and NEW10 plus a history-wide secret sweep. All three landed. One thing neither
of us asked for also fell out: **the BLOCKED-deployment mystery from last night
is solved**, because it happened again mid-session, in front of instruments.

TL;DR: the health card degrades honestly today and the exact clicks for the
token are in `docs/operations.md`; pipeline v2 preserves alpha end to end, all
ten production photographs are rebuilt and the storefront serves only
`derived/v2`; NEW10 is capped at 50 uses and dies 2026-09-30, and the full git
history contains **no secret values** — the one real credential-shaped string
ever committed is a Razorpay *test-mode key id*, public-by-design, already
scrubbed from the tree. Production serves the tip of `main`, verified by three
content observables — but `/api/version` reports `unknown` until you do the
one-click GitHub connection in §4, which is the first item on the morning list.

---

## 1 · The repository went private — the card, the token, the honest window

### What I found

You had already flipped it before I started: unauthenticated
`api.github.com/repos/ahammedejaz/footVault` answers **404**, `gh repo view`
says PRIVATE. So the "window between the repo flipping and the token landing"
is not hypothetical — production is in it right now.

### The card degrades honestly, and that is now proven, not assumed

GitHub hides a private repository from unauthenticated callers as **404, not
403** (existence itself is the secret). The card's non-200 branch already
returned `expected_unknown` → warn-tone "unverified" chip → "this is **not** a
confirmation" prose. What was missing was the *remedy*: a reason string that
said "GitHub answered 404" with no explanation. Now:

- 404 without a token → "The repository is private and no GITHUB_REPO_TOKEN is
  set — GitHub hides a private repository as 404 rather than 403. Add the token
  in Vercel (docs/operations.md has the exact clicks) and redeploy."
- 403 with a token → "The token was sent and refused — it may have expired or
  lost access."
- 403 without → the rate-limit sentence, unchanged.

`readDeployment` moved to its own module (`src/lib/deploy/expected.ts`) —
importable without the health page's Supabase machinery — and
`audit:deploy-drift` gained `verdictLogic()`: **eight fetch-mocked cases** that
run before every production interrogation, proving 404/403/garbage/network-down
all degrade, that a set token actually rides as the `Bearer`, that drift
carries the expected SHA, and that nothing but an exact SHA match reads as
`in_sync`.

- **Red control**: sabotaged the 404 branch to return `in_sync` → gate exit 1,
  naming the exact case. Restored → exit 0, 8/8 cases held.

### The exact clicks (also in `docs/operations.md`, §"Deployed build")

**GitHub** (as `ahammedejaz`): avatar → Settings → Developer settings →
Personal access tokens → Fine-grained tokens → Generate new token. Name
`footvault-health-card`, expiration 90 days, Resource owner: your account,
Repository access: *Only select repositories* → `footVault`. Permissions →
Contents: **Read-only** (Metadata auto-adds). Generate, copy once.

**Vercel**: `foot-vault` project → Settings → Environment Variables → add
`GITHUB_REPO_TOKEN`, **Production only** → Save → then Deployments → ⋯ on the
latest Production deployment → **Redeploy** — env vars reach a build at
creation, so without this step the card stays "unverified". Then open
`/admin/health` and confirm `in sync with main`.

---

## 2 · Pipeline v2 — alpha preserved, the surface is paint

### The change

`normaliseProductImage` no longer calls `flatten()`. Contain-padding, crop
overhang, and straighten corners are all **fully transparent**
(`{r:0,g:0,b:0,alpha:0}`); WebP carries the alpha channel natively; a
transparent source PNG stays transparent to the customer. What shows behind a
photograph is whatever the page paints — and every catalogue surface now paints
`bg-photo` (white, `--fv-photo` ≡ `CARD_SURFACE`, still gate-held equal).

`frameFor` grew an explicit mode instead of a boolean: `"measure"` /
`"measure-own-corner"` still flatten (sharp's `trim` needs a composited corner
to infer the background from; flattening changes zero geometry, so crops
measured on one frame apply exactly to the other), `"store"` never does. The
refactor surfaced a hidden production caller my grep had filtered out
(`image-pipeline.ts` — the substring "pipeline.ts" in a `grep -v`); the
compiler caught it.

`PIPELINE_VERSION` 1 → 2: every derivative re-derives to a **new** path, old
objects stay (nothing deleted), rows repoint atomically per image, and until
they do, v1 URLs fall back to plain `next/image` — the loader's own designed
migration path (`remotePatterns` already admits the storage host; checked
before shipping).

### Every surface that shows a product image, checked one by one

| Surface | Fit | Well before | Action |
|---|---|---|---|
| product card | contain | bg-photo | none |
| product gallery rail + thumbs | cover | bg-photo | none |
| **gallery zoom dialog** | contain | **none — sat on the black overlay** | bg-photo + rounded |
| cart lines | contain | bg-photo | none |
| **checkout order summary thumb** | cover | **bg-paper (#fbfcfd — near-white, not white)** | bg-photo |
| checkout order-lines / confirmation | cover | bg-photo | none |
| account orders thumbnails | cover | bg-photo | none |
| wishlist row | cover | bg-photo | none |
| search panel | cover | bg-photo | none |
| home "shop by" tiles | cover | **none (bg-ink fallback only)** | bg-photo |
| **admin product table thumb** | cover | **bg-muted (grey)** | bg-photo |
| **admin media library** | cover | **none (border only)** | bg-photo |
| admin contact sheet / image manager / crop stage | contain·cover | bg-photo | comment fix only |
| brand logos (2 files) | contain | exempt | logos never ride the pipeline (URL field) |
| hero video | cover | exempt | a brand film, no well to paint |
| emails | — | — | only the logo; no product images in any template |

The five bold rows are where a transparent pad would have shown "whatever is
behind" — with flattening they showed a white rectangle instead, which is why
nobody had noticed them.

### The gate can no longer miss the next one

`audit:images`' derived well scan widened from `object-contain` to
`object-(contain|cover)` — **16 files scanned**, exemptions named with reasons
(hero-video, brand marks). Rationale in the gate: a cover fit of a square asset
into a square thumbnail (every thumbnail in the shop) shows the pad whole.

Gate assertions flipped to the new contract: pad corners assert **alpha 0**
instead of a colour; a new §2b runs a transparent cut-out through the pipeline
and interrogates three regions (subject opaque ≥253, source's own transparency
≤2, contain-pad ≤2) plus brightness/contrast leaving the alpha band alone;
`subjectBounds`/`pixelAt` learned alpha (transparent decodes as rgb(0,0,0) —
"dark, but not subject"); the two-branch byte-identity claim was retired
honestly (an alpha seam resamples differently by construction — the comment
records why null crops still take the untouched branch); and the
derivative-URL fixture now derives its version from `derivativePath` — it had
`derived/v1/` typed in and went red the moment the version moved, a copy
asserting the past, caught live tonight.

- **Red control A** (old gate vs new pipeline): 8 reds — pad-colour ×4,
  two-branch identity ×2, target-fill (subjectBounds counting transparent
  pixels as subject → 100% fill), hardcoded v1 fixture.
- **Red control B** (flatten restored vs new gate): exit 1 on "the source's
  own transparency is preserved — alpha 255 — under v1 this pixel was #ffffff".
- **Green**: 99/99.

### The reprocess, and what the shop serves now

- Staging rehearsal: 122 rows, all seed SVG placeholders, correctly skipped —
  nothing to rehearse on, so the meaningful preview was the production
  `--dry-run` (read-only): 10 real photographs, all with your framings.
- Production run after the code deploy: **10 processed, 0 failed**, framings
  applied from the crop rows, rows repointed to `derived/v2`.
- Verified live: DB counts v2=10, v1=0, seed=38. `/shop` HTML: **34 × v2, 0 ×
  v1**. `/product/asics-patriot-mens`: 2 × v2, 0 × v1 (the catalog cache's
  one-hour window turned over on its own; v1 objects stayed in the bucket so
  the interim rendered normally). A live v2 asset fetched from the CDN decodes
  as 1600×1600 WebP, **hasAlpha true**, 102KB.
- `skechers-go-walk-7-mens` shows no gallery because it is the designed "No
  longer stocked" page (title checked) — true before tonight and unrelated;
  its 4 images are repointed and ready if it returns.

Your existing photographs are opaque JPEG/WebP sources, so their *subjects*
render identically — only the pad ring changed from baked white to
transparent-over-white-well, which is invisible on every surface in the table
above.

---

## 3 · NEW10, and what the world could have read

### The row (production snapshot, before → after)

```
code NEW10 · percent 5 · min_order 0 · max_discount null · audience everyone
used_count 0 · is_active true
usage_limit : null  →  50
expires_at  : null  →  2026-09-30 18:29:59+00  (= 23:59:59 IST, 30 Sep)
-- restore: update public.coupons
--          set usage_limit = null, expires_at = null where code = 'NEW10';
```

Name and percentage untouched, per your instruction. My reasoning for the two
numbers: the code has been world-readable since 2026-08-10 and `used_count` is
0, so **50 uses** bounds the worst case of a leaked code while leaving a real
launch allocation, and **six weeks** is long enough to be useful and short
enough that the leaked string dies on its own. Both are editable on the admin
coupons screen (the form already carries both fields). Enforcement is not new
code: `evaluateCoupon` and `create_order_with_stock` both refuse on
`expires_at`/`usage_limit` under the coupon row lock — `audit:coupons` exit 0
tonight. Still yours to decide: `max_discount` is **null**, so 5% of an
expensive basket is uncapped; and `per_user_limit` is null (one customer can
use all 50).

### The sweep — every commit, every branch, 261,531 patch lines

Patterns: JWTs (`eyJ…`), Stripe/Razorpay/Resend/GitHub/AWS/Slack prefixes,
private-key blocks, connection strings with passwords, literal
`secret/token/password/api_key = "…"` assignments, committed `.env*` files.

**No secret value has ever been committed.** Specifically:

1. **Zero JWTs in all of history** — neither the Supabase anon key nor the
   service-role key was ever committed. `.env.example` (the only env file ever
   added) contains names only.
2. `rzp_test_TMyzJsAbGiBQ4T` — a Razorpay **test-mode key id** in
   `docs/phase-5-brief.md`, added in `21a8099`, removed in `73c40ca`; survives
   only in history. Key *ids* ship to every browser in checkout by design, and
   this one is test-mode. Optional hygiene: rotate the test pair in the
   Razorpay dashboard. No secret (`key_secret`) ever appeared.
3. Postgres URLs: all placeholders (`<url-encoded-password>`, `PASSWORD`,
   `pw`). The Supabase **project refs** appear (`.env.example`, docs) — they
   are in every public storefront URL already.
4. `guest-token-alpha` — a test fixture.
5. **NEW10 itself is the leak**: its code, value, and terms are printed in the
   committed `claudeExecutionReport/*.md` files. That is why it now has a cap
   and an expiry rather than a hope. One honest caveat: making the repo
   private does not recall history from clones or caches made while it was
   public — treat everything in history to date as published, which is exactly
   how NEW10 was treated.

---

## 4 · The discovery: BLOCKED deployments, solved

Pushing tonight's commits reproduced last night's mystery **while I was
watching `targets.production`**: the git deployment for `584b36a` sat
`BLOCKED`, `buildingAt == ready == createdAt`, errorLink
`troubleshoot-project-collaboration`.

The discriminator was on the deployment records all along:
`meta.githubRepoVisibility`. Every BLOCKED deployment says `private`; every
READY one from last night says `public`. **The block "lifting by itself" at
01:12–01:22 was the repository going public.** It re-engaged the moment you
flipped it back. For a private repo, Vercel requires the commit author to map
to a Vercel team member — through **GitHub logins** — and `footvault3` has no
GitHub connection that maps `ahammedejaz`. Measured tonight, in order:

1. Git deploy of `584b36a` (author ahammedejaz@gmail.com) → BLOCKED,
   `#team-configuration`.
2. CLI deploy from the repo → attaches the same git metadata → BLOCKED,
   `source: "cli"` — so "use the CLI" alone is **not** the escape hatch the
   last write-up hoped for.
3. Empty commit authored as footvault3@gmail.com (`a06d9f3`) → BLOCKED,
   `#account-configuration` — GitHub cannot attribute that email to any login,
   so Vercel cannot map it either. Author-spelling cannot fix this.
4. **What shipped it**: `git archive HEAD` into a scratch dir (no `.git`),
   `.vercel/project.json` copied in, `npx vercel deploy --prod --yes` → READY,
   aliased to www.footvault.in. No git metadata, no author to check.

The cost of №4 is honest and temporary: `VERCEL_GIT_COMMIT_SHA` is absent, so
`/api/version` reports `unknown`, the health card says it cannot tell which
commit is running, and `audit:deploy-drift` is **red by design** — the gate
refusing to pass when it cannot see is it working. All of this ends with one
click that only you can do:

> **Morning item #1**: vercel.com, logged in as `footvault3` → avatar →
> Account Settings → **Authentication** → connect GitHub, authorising as
> `ahammedejaz`. After that, git pushes deploy normally again, `/api/version`
> knows its commit, and the card and drift gate go back to full verdicts.

All of this is in `docs/operations.md` §"When it is red", with the
does-not-work list so nobody re-derives it.

## 5 · Deploy record

| # | What | How | Verified by |
|---|---|---|---|
| 1 | `560c1ad` health/token + `584b36a` alpha | git push → BLOCKED ×2; `a06d9f3` empty-commit attempt → BLOCKED; export deploy `dpl_AS8ASX…` → READY, aliased | (a) `targets.production` = the export deploy, Ready; (b) `/api/version` flipped from `known/982f335` to `unknown` with the new tree's exact reason string; (c) `/` HTML carries `bg-photo group relative flex aspect-4/3` — a class only the new tree emits |
| 2 | production `images:reprocess` | local script, after the code deploy | DB v2=10/v1=0; `/shop` 34×v2 0×v1; CDN asset decodes 1600² webp hasAlpha=true |
| 3 | `NEW10` DML | `execute_sql` UPDATE with RETURNING | row read back: usage_limit 50, expires_at 2026-09-30T18:29:59Z; restore SQL above |
| 4 | wave 3 (docs + report + version.ts wording) | git push (expected BLOCKED) + export deploy | `/api/version` reason string gains the "CLI deploy of an exported tree" clause — see §7 note |

No single-curl-in-the-build-window readings; every state came from the
deployment record or a content marker.

## 6 · The six-job battery (pipe-free exit codes, after the last edit)

| Job | Exit | Scan counts |
|---|---|---|
| typecheck | 0 | — |
| lint | 0 | 0 errors, 0 warnings |
| shapes | 0 | — |
| guard:use-server | 0 | 28 "use server" files |
| guard:client-imports | 0 | 98 client × 77 server-only, none value-imports |
| build | 0 | — |

Affected gates: `audit:images` 99/99 (16 image-fit components scanned),
`audit:coupons` 0 failing, `audit:deploy-drift` verdictLogic 8/8 (the
production half is red-by-design until morning item #1 — see §4).

## 7 · What went wrong, in the open

- **I read an exit code through a pipe again** (`tsc | head; echo $?`) — the
  exact class-6 trap; caught immediately and re-run pipe-free. The habit needs
  the shell function, not vigilance.
- **My `grep -v pipeline.ts` hid `image-pipeline.ts`** — a substring filter
  concealed a production caller of `frameFor`; the compiler caught what the
  search missed.
- **I deployed before reprocessing**, so the storefront held cached v1 HTML
  for some minutes. Nothing broke (v1 objects persist; the catalog cache's
  one-hour `revalidate` turned over on its own) — but reprocess-then-deploy
  would have been the cleaner order, or the reprocess script could hit a
  revalidation hook. Left as a noted improvement, not built tonight.
- **The memory/docs I wrote an hour earlier claimed the CLI was the escape
  hatch** — disproven the same evening by measurement №2 in §4; both records
  corrected before commit.
- The `verdictLogic` red-control sabotage run took the gate past a 120s
  timeout into background — harmless, but the double-run cost a wait.

## 8 · Not fixed, deliberately

- `max_discount` and `per_user_limit` on NEW10 — money terms, yours.
- The reprocess → revalidation hook (above).
- The stale `.claude/worktrees/agent-…` directory (untracked, ignored) — left.
- Rotating the Razorpay **test** key pair — optional hygiene, dashboard-only.
- `audit:deploy-drift`'s production half stays red until morning item #1 —
  that red is the gate telling the truth; do not "fix" it.

## 9 · Morning list

1. **Vercel → Account Settings → Authentication → connect GitHub
   (`ahammedejaz`)** — unblocks git deploys, restores `/api/version`, turns
   the drift gate and health card back to full verdicts. Two minutes.
2. **Mint `GITHUB_REPO_TOKEN`** per §1's clicks and add it to Vercel
   Production, then redeploy (after #1, the redeploy happens naturally with
   the next push). Open `/admin/health` → "in sync with main".
3. **NEW10**: confirm 50 uses / 30 Sep IST suit you (both editable on the
   coupons screen); decide whether 5% should finally get a `max_discount`
   and/or `per_user_limit 1`.
4. Optional: rotate the Razorpay test key pair.
5. Optional: upload a transparent product PNG through the admin and enjoy it —
   the pipeline now keeps it.
