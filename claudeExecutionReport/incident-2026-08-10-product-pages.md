# Incident: every product page a 500, from a build that passed

**2026-08-10, 17:23–~17:55 UTC.** Deployment `dpl_GnN8dNCo2frbEe3U3XBDhyEXodVr`
(the fa2e60a merge of PR #39, C5+C6) served 500 on every `/product/[slug]`
request — document and `.rsc` alike — from its first customer request at
17:23:19 until the owner rolled the alias back to ef2ff65
(`dpl_7L3LN6BtWGkRaGqiVf8vuoeiM9HH`). Digest: `DYNAMIC_SERVER_USAGE`. The
homepage, shop, cart and checkout served normally throughout.

The commit got the blame; the commit was innocent. The more useful finding —
the one this report is really about — is why no check we ran, or could have
run locally, was capable of seeing the failure.

## The bisect that dissolved

The working boundary looked like: fa2e60a (merge) broken, 687098f (branch
head) fine. But `git diff 687098f..fa2e60a` is **empty** — the merge tree is
byte-identical to the branch head. Two identical trees behaving differently is
not a code fault, so the file-group revert bisect planned against the diff was
abandoned: there was no file to find.

What actually differed was the *build event*:

| Build | When (UTC) | Route table | Fate |
|---|---|---|---|
| Production, fa2e60a | 17:21 | `● /product/[slug]` (SSG) — everything else ƒ | every product page 500s |
| Preview, 687098f | 17:16–17:20 | `● /collection/[slug]`, `● /page/[slug]` — product ƒ | collection + page routes 500 (seen 17:49, testing "687098f works") |
| Production, ef2ff65 (rollback target) | 13:59 | everything ƒ | healthy |
| Local, same fa2e60a tree, production env + data | 18:0x | everything ƒ, 78/78 pages | healthy — the repro that "failed" |

The preview deployment the owner verified as working was broken too — on the
routes they didn't click. Each build was poisoned on exactly the routes whose
slug query happened to fail during that build, and nowhere else.

## Root cause, each link proven

1. **A Supabase outage during the Vercel build.** The fa2e60a build log at
   17:21:40 contains a full Cloudflare *522 Connection timed out* page from
   `ahumjhwqgmskjsitctcj.supabase.co`, caught by `staticParamsOr("products")`:
   `[static-params] products: listProductSlugs: <!DOCTYPE html>… Falling back
   to on-demand rendering for this route.`

2. **The fallback is not what its comment believed.** `staticParamsOr`
   returned `[]` on the theory that an empty list means "a slower first
   request and nothing worse." In fact a route with `generateStaticParams` is
   classified SSG by the manifest regardless of what the list contained. With
   zero paths, zero pages render at build time — so the build never executes
   the page, never hits `cookies()` (the per-customer wishlist read in
   `getSavedProductIds`), and never reclassifies the route as dynamic the way
   every healthy build of this app does. The 43-vs-78 static page counts in
   the two build logs are this: the missing 35 are the product pages.

3. **Runtime cannot un-bake a manifest.** Every request to an SSG route with
   no prerendered path is an on-demand *static* generation. The page reads
   `cookies()`; a static generation may not; Next throws. Real message,
   surfaced locally (production builds strip it to the digest):
   `Dynamic server usage: Route /product/[slug] couldn't be rendered
   statically because it used 'cookies'` — thrown from `await cookies()` in
   `src/lib/supabase/server.ts`'s `createClient`, reached from the page's
   wishlist read. `connection()` can rescue a page body (see
   `src/lib/prerender.ts`); nothing can rescue a baked manifest.

Reproduced end-to-end on this machine: a build with
`STATIC_PARAMS_SIMULATE_OUTAGE=products` produces the identical broken layout
(`●`, 43/43), and serving it with a fully healthy runtime 500s every product
slug with the production log lines verbatim.

## Why local production builds kept saying 200

Task: *"explain why local and production disagreed before trusting any local
result again."* The answer is that both results were correct. The fault was
never in the tree, the environment, or the data — all three were identical in
the failing and passing cases. It was in a **network event during one
particular execution of `next build`**. A local build whose slug query
succeeds produces an honest artifact; so does a Vercel build on a good minute.
The original hypothesis (generateStaticParams returning a different set
locally) was right in mechanism but wrong in direction: the failing paths
weren't "never prerendered locally" — they were never prerendered *anywhere*;
locally the route wasn't prerender-classified at all, which is the safe shape.
No amount of local building can reproduce a remote build-machine timeout, and
no gate that only inspects *this* build's output can vouch for *that* build.
Hence both halves of the fix.

## The middleware 500s

All 25 `/_middleware` 500s in the log export share request IDs with
`/product/[slug]` function 500s (25 of 25; the export shows the same request
logged at both hops, plus function retries). No middleware error groups exist
in the runtime error aggregates. One fault, surfaced twice. `src/proxy.ts` is
not implicated.

## The fix

- `src/lib/static-params.ts` — the contract is now *retry, then fail the
  build*: three attempts with backoff, then a thrown error naming the route
  and the reason. A build that cannot read the catalog keeps the previous
  deployment serving instead of replacing it with a landmine. Error messages
  are trimmed to one line so a Cloudflare HTML page can never bury a build log
  again. Proven: the simulated-outage build exits 1; the clean build is
  byte-for-byte the healthy layout.
- `.github/workflows/ci.yml` — CI builds with placeholder credentials by
  design and its artifact never serves traffic, so CI alone declares
  `STATIC_PARAMS_ALLOW_EMPTY=1` and keeps the old fallback (single attempt, no
  pointless retries). Vercel builds must never set it.
- `STATIC_PARAMS_SIMULATE_OUTAGE=<label|all>` — the incident on demand, for
  the gate below.

## The gate: `npm run audit:build-smoke`

The deploy-sequence check this incident demanded, documented in
`docs/staging.md` §4.4: the outage drill (a build with simulated outage must
*fail*), a real production build against production data, a manifest assertion
(no slug route SSG with zero prerendered paths), and a served smoke — one real
URL per slug-route family taken from the artifact's own sitemap, fetched as
document and as RSC. First full run: 15/15 PASS. It runs before merging to
main, which is this repo's "before it becomes production."

Residual, stated honestly: the artifact Vercel serves is built on Vercel's
machines, and this gate cannot observe a network failure there. That half is
covered by `staticParamsOr` failing the build — a poisoned artifact can no
longer exist to be promoted. If a second line is ever wanted, it is a Vercel
deployment check (post-deploy smoke against the deployment URL before
aliasing), which is an owner decision about deployment protection settings,
not code.

## Standing tension, recorded not fixed

These slug routes declare `revalidate = 3600` and collect params, but every
healthy build reclassifies them dynamic because the pages read `cookies()` on
every render. The static-product-page aspiration in the page's own comments
has never been what production served; all live performance numbers (warm
TTFB 0.58–1.20s, LCP 1.94–2.65s) were measured on the dynamic reality. Either
the per-customer reads move out of the first render (making the pages actually
static) or the `generateStaticParams`/`revalidate` declarations should go
(making the honesty structural). That is a design decision for its own change,
not a rider on an incident fix.

## C5 and C6

Exonerated. Any commit deployed at 17:21 would have shipped the same
landmine. fa2e60a is already main; once this fix merges, the next production
deployment carries both safely.
