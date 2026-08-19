# Deploy record · admin usability + permanent delete

**2026-08-20** · `main` @ `6cbb7b2` (PR #47, merged)

## Status in one line

**The database half is live on production. The code half is not, and it is not
my code that stopped it — Vercel is refusing every git-triggered deployment,
production included, before any build starts.** The shop is healthy and serving
the previous build. Nothing is broken and nothing is half-applied.

| | State | Evidence |
|---|---|---|
| Production DB migrations | ✅ **live** | both functions resolve through PostgREST |
| Code on production | ❌ **not deployed** | `/shop` still serves `card-media bg-fog` |
| Live shop health | ✅ **200 everywhere** | `/`, `/shop`, `/cart` |
| Git | ✅ merged to `main` | `6cbb7b2` |
| CI | ✅ green | typecheck · lint · build · service_role guard |

---

## 1 · What was done, in order

### 1.1 Full battery before touching anything

Re-run immediately before the deploy, all six CI checks:

```
typecheck              tsc --noEmit                                    clean
lint                   eslint .                                        clean
shapes                 16 cached shapes unchanged at v9
guard:use-server       28 "use server" files, all export async only
guard:client-imports   98 "use client" files vs 76 server-only modules, none imports one
build                  ✓ Compiled successfully
```

### 1.2 Production snapshot — taken first, verified by content

Per `docs/admin-guide.md` §12, and not started until the files existed.

```
DB_Backups/backup-20260820-0053-schema.sql   188K   37 tables · 38 functions · 63 policies
DB_Backups/backup-20260820-0053-data.sql     519K   ends "RESET ALL;"
```

Verified against live rather than by file size, because a dump that connects and
returns nothing is also a non-empty file:

| table | in dump | live | |
|---|---|---|---|
| orders | 25 | 25 | ✅ |
| products | 13 | 13 | ✅ |
| product_variants | 147 | 147 | ✅ |
| order_items | 25 | 25 | ✅ |
| profiles | 13 | 13 | ✅ |
| payments | 21 | 21 | ✅ |

Newest order in the dump is `FV-2026-00668`, which is the newest order live.
The schema dump contains **zero** references to the two new functions, confirming
it is a genuine pre-change snapshot. Trigger coverage (28 `set_updated_at`
references) matches the last known-good snapshot exactly.

### 1.3 Dry run

```
Would push these migrations:
 • 20260820090000_admin_purge_product.sql
 • 20260820090100_admin_delete_order.sql
```

Exactly the two expected files, nothing else. Staging had already been rebuilt
from empty beforehand — all 118 migrations replay in order, seed and checks green
— so the set was proven to apply before it went near production.

### 1.4 Push, and the gates after it

Both applied. Then, with a **nonexistent uuid** so nothing could be destroyed:

```
admin_purge_product · service_role   HTTP 400  FVADM  not_admin
admin_delete_order  · service_role   HTTP 400  FVADM  not_admin
admin_purge_product · anon           HTTP 401  42501  permission denied
admin_delete_order  · anon           HTTP 401  42501  permission denied
admin_purge_product · wrong arg name HTTP 404  PGRST202
```

Four things proved at once:

- **the signatures resolve** — PostgREST reloaded its schema cache on the DDL
- **the admin guard fires before any work** — `FVADM` is `is_admin()` refusing
- **the grants landed** — `42501` for anon means the `revoke … from public, anon`
  took, which is the trap where a re-created function silently keeps its default
  `PUBLIC` execute
- **the cache is current, not stale** — a wrong argument name 404s rather than
  resolving an older signature

### 1.5 Code

Branch `fix/admin-mobile-and-permanent-delete`, PR #47, merged to `main` as
`6cbb7b2`. GitHub Actions green: *Typecheck, lint, build* (2m33s) and *Guard the
service_role key* (20s).

---

## 2 · Why the code is not live

### What Vercel says

```
state              BLOCKED
readyStateReason   The Deployment was blocked because the commit author
                   does not have contributing access to the project on Vercel.
errorLink          .../troubleshoot-project-collaboration#team-configuration
buildingAt == ready == createdAt   → no build ever started
```

Both the PR preview **and the production deployment for the merge commit** are
blocked, identically.

### It is not the commit

`b87d817` deployed successfully to production on **2026-08-14** with author
`ahammedejaz@gmail.com`. A commit with that *same* author was blocked on
**2026-08-20**. The team reads `plan: hobby`, `blocked: null`, `status: active`.
Something changed in the Vercel↔GitHub account linkage; nothing changed in the
repository that could cause this.

**This is worth knowing for its own sake:** a merge to `main` no longer ships.
Any future work will land in git, report green CI, and silently keep serving the
old build. `gh pr checks` renders it as a plain `fail`, which reads exactly like
a broken build — the real reason only appears in `readyStateReason`.

### What I tried and stopped

`npx vercel deploy --prod` is the standard escape hatch, because a CLI deploy is
authored by the Vercel account rather than by the git author. **The auto-mode
classifier denied it.** This project's standing rule is that a blocked call is a
stop-and-report and never a tool-switch, so I did not reach for the Vercel MCP
deploy tool to get around it. It is handed to you below instead.

---

## 3 · Is production in a safe state right now?

**Yes, and deliberately so.** The database is ahead of the code, which is the
correct order and not a half-applied state:

- both migrations are **purely additive** — two new functions, no table, column,
  constraint or enum change, and no existing function altered
- **nothing in the deployed build calls them.** The code that does is in
  `6cbb7b2`, which is not serving
- they are unreachable to anyone who is not an admin: anon is refused at the
  grant, and `is_admin()` refuses everyone else

Confirmed live, just now:

```
200  https://www.footvault.in/
200  https://www.footvault.in/shop
200  https://www.footvault.in/cart
/shop serves: card-media bg-fog        ← the old build, as expected
```

Had this gone the other way — code first, functions later — the admin panel
would be showing Delete buttons that 404 at the database. It did not.

---

## 4 · What you need to do

### 4.1 Unblock deployments (the real fix, ~2 minutes)

Vercel → **Account Settings → Login Connections / Emails**, and make sure both
commit-author addresses are connected to the `footvault3@gmail.com` account:

- `ahammedejaz@gmail.com` — your normal commit author
- `syedejaz8470@gmail.com` — the address GitHub used for the merge commit

Or, on the project: **Settings → Git → Contributing access**, and grant those
authors access.

### 4.2 Then ship `6cbb7b2`

Once 4.1 is done, either push any commit to `main`, or — faster — open the
blocked deployment in the Vercel dashboard and press **Redeploy**. Your history
shows you have used Redeploy before (`action: redeploy` on two production
deployments), and a redeploy is authored by the account rather than the git
author, so it will go through even before 4.1 is fixed.

Blocked production deployment:
`https://vercel.com/foot-vault/foot-vault/A9XgjXrER2NzPNzbfAnMcwsqVzn8`

### 4.3 Verify it actually shipped

`READY` is a build state, not proof of serving. Check by content — this string
does not exist anywhere in the old tree:

```bash
curl -s https://www.footvault.in/shop | grep -o "card-media bg-[a-z]*" | sort -u
# want: card-media bg-photo      (old build says bg-fog)
```

Measure against **www**, not the apex.

### 4.4 Optional, whenever you like

```bash
npm run images:reprocess
```

Re-pads photographs uploaded before today from their originals so the older ones
match the new white wells. Not required — it is only a visual inconsistency, and
it writes new objects so the catalogue keeps rendering throughout.

---

## 5 · Rollback

Not needed, but for completeness.

**Code:** nothing to roll back — the old build is what is serving.

**Database:** the two functions are additive and unreferenced by the live build,
so leaving them costs nothing. To remove them anyway:

```sql
drop function if exists public.admin_purge_product(uuid);
drop function if exists public.admin_delete_order(uuid);
```

Neither `admin_delete_product` nor `cancel_order_with_restock` was modified, so
nothing existing depends on them.

Full pre-change snapshot: `DB_Backups/backup-20260820-0053-{schema,data}.sql`.

---

## 6 · What went wrong, for the record

- **I read the blocked preview as a project setting and was half right.** Every
  prior deployment on this project was `target: production` and this was the
  first preview ever attempted, so "previews are not enabled here" was a
  reasonable reading of a `BLOCKED` preview — and the GitHub Actions battery was
  green, which is the check that matters. It was still an assumption, and the
  production deploy afterwards proved it wrong. I should have read
  `readyStateReason` on the preview *before* merging rather than after. Merging
  did no harm — the migrations were already live and the code is inert until it
  deploys — but I would have known the deploy could not succeed.
- **`gh pr checks` was actively misleading.** It renders a pre-build account
  block as `fail` against a "Vercel" check, indistinguishable from a compile
  error, with a link to an inspector page that shows no logs because no build
  ran.
