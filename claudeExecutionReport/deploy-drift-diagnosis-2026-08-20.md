# Diagnosis: production was not stuck, and both hypotheses were wrong — including the third

**2026-08-20** · `main` @ `2e2e87f` · production serving `2e2e87f` ✅

---

## The finding, before anything else

**Production was already running the new code when you wrote to me, and had been
for about fifteen minutes.**

`317839e` was created at 01:22:46, started building at 01:22:48, and went
`READY` at **01:23:51** — `target: production`, `aliasAssigned: true`, holding
`www.footvault.in`. It was never blocked.

The `curl` that showed `bg-fog` was run inside the 65 seconds the build was
still running, or in the CDN propagation just after. **This is the third
hypothesis in a row to be wrong, and it is mine as much as yours** — the first
report also diagnosed from a `curl` rather than from the deployment record, and
it reached a confident conclusion the data does not support.

So the premise "production is running old code" was already stale. What follows
is the evidence, then the thing that actually needed building.

---

## 1 · The five questions

### 1.1 Author emails, compared literally

```
317839e   author ahammedejaz@gmail.com     committer ahammedejaz@gmail.com
e8bc351   author ahammedejaz@gmail.com     committer ahammedejaz@gmail.com
2e0527b   author ahammedejaz@gmail.com     committer ahammedejaz@gmail.com
b87d817   author ahammedejaz@gmail.com     committer ahammedejaz@gmail.com
6cbb7b2   author syedejaz8470@gmail.com    committer noreply@github.com
```

**Four of the five are byte-identical.** You were right that `6cbb7b2` is the
first commit ever authored by GitHub's web-merge identity — PR #47 was the first
pull request on this project. But that fact explains one refusal out of four, so
it is not the cause of anything.

### 1.2 Is there a deployment for `317839e`?

Yes, and it is the opposite of blocked.

```
dpl_BNKx5he3B5txvwFdCnDvVK12cFDT
  sha        317839ed602b496c59a3faafe9ee86b4dcd75607
  state      READY          target production
  created    01:22:46   building 01:22:48   ready 01:23:51
  alias      www.footvault.in, footvault.in, foot-vault.vercel.app, …
  aliasAssigned true       aliasError null
```

### 1.3 What is production serving?

From the deployment record — the project's `targets.production`, which is the
authoritative pointer:

```
sha 317839ed602b496c59a3faafe9ee86b4dcd75607   READY   created 01:22:46
```

That is the tip of `origin/main` at the time. Confirmed independently by
content: `/shop` served `card-media bg-photo`, and a real product page
(`/product/asics-patriot-mens`) served `rail bg-photo` seven times.

*(Two red herrings I chased and dismissed: `data-dpl-id` in the HTML is not a
deployment id — the API returns `not_found` for it. And the `project-created`
event on 08-17 is an unrelated project called `peace-education-services` with no
repo attached.)*

### 1.4 Git integration

```
link.type          github
link.repo          ahammedejaz/footVault      repoId 1326554303
productionBranch   main
deployHooks        0
```

Connected, correct repo, correct branch. Unchanged.

### 1.5 Build settings

```
commandForIgnoringBuildStep   None
buildCommand / installCommand None
rootDirectory                 None
framework                     nextjs      nodeVersion 24.x
gitForkProtection             True
gitComments                   onCommit false, onPullRequest true
```

**Nothing has been changed.** No ignored-build-step, no branch override, no
disabled auto-deploy.

---

## 2 · What actually happened, and the honest gap in it

```
01:00:09  deployment-creation-blocked   2e0527b  ahammedejaz@gmail.com  (preview)
01:05:06  deployment-creation-blocked   6cbb7b2  syedejaz8470@gmail.com
01:12:04  deployment-creation-blocked   e8bc351  ahammedejaz@gmail.com
01:22:46  deployment  → BUILDING        317839e  ahammedejaz@gmail.com
01:23:51  aliases-assigned                        ← live from here
```

All four refusals carried the same `readyStateReason`, verbatim:

> The Deployment was blocked because the commit author does not have
> contributing access to the project on Vercel.

**`e8bc351` and `317839e` have the identical author.** One was refused at
01:12:04, the other built ten minutes later. `b87d817` also shipped under that
address on 14 August. So the same email was accepted, refused three times, then
accepted again.

**Your empty commit is therefore not what fixed it** — that is hypothesis #2
confirmed dead, and its replacement ("the author is an address Vercel accepts")
does not survive either, because `e8bc351` proves that address was being refused
ten minutes earlier.

**I cannot tell you what lifted it.** `GET /v3/events` shows no configuration
change between 01:12:04 and 01:22:46 — only the three `deployment-creation-blocked`
entries, then the successful deployment. The team audit log is Pro-only
(`404`). If you changed something in the dashboard in that window, that is the
answer; if you did not, it was transient at Vercel's end. Either way it is now
clear: the deploy at 01:39 for this batch went straight to `BUILDING`.

I have written it up in memory as *cause never established* rather than
inventing a third theory.

---

## 3 · The real gap, which is what you actually asked for

For 23 minutes `main` was three commits ahead of production and **nothing in
this project could tell**. CI green on the merged commit. Every route 200. The
only signal that existed was the colour behind a photograph.

Every check here asks whether the code is *correct*. None asked whether it is
*running* — and those questions have the same answer almost always, which is
exactly what makes the gap invisible until it matters.

### 3.1 `/api/version` — public, `no-store`

The served side has to come from the bytes on the wire. The Vercel API only
knows which deployment is *aliased*, and this whole incident is those two
disagreeing. `/admin/health` knows too, but it is behind the admin guard, and a
check that needs a login is a check that stops being run.

It publishes a commit SHA and a branch name. Against a private repository a SHA
is an opaque digest that grants no access to anything; Vercel already puts a
per-deployment id on every HTML response for the same reason.

### 3.2 `/admin/health` → "Deployed build"

**First card on the page**, because it can invalidate every card below it: if
the build answering the request is not the build that was merged, the rest of
the page is reporting truthfully about the wrong code.

| Chip | When |
|---|---|
| `in sync with main` | deployed commit **is** the tip of `main` |
| `behind main` | merged work is not live — **both SHAs printed** |
| `unverified` | it could not check — **not a pass** |

`unverified` is the one worth being careful about, and it follows the rule the
page already sets for itself: *"it never renders a guess: 'could not read' is
its own state, loudly, because a wrong 'fine' teaches the owner to stop opening
the page."*

To get the full verdict rather than `unverified`, set **`GITHUB_REPO_TOKEN`** in
Vercel (fine-grained, read-only Contents on this repo). Optional — without it
the card still shows which commit is running, it just will not claim it is
current.

### 3.3 `npm run audit:deploy-drift`

```
deploy drift  https://www.footvault.in
  serving   2e2e87f1e53cfbcad8aa88d17f8d27c3ca7a1b4d  (main)
  origin/main 2e2e87f1e53cfbcad8aa88d17f8d27c3ca7a1b4d

✓ production is serving the tip of main
```

Compares `GET /api/version` against `git rev-parse origin/main` (fetched first,
so a stale local ref cannot produce a meaningless tick). **Exits non-zero
whenever it cannot establish either side.**

**Deliberately not a PR gate.** Between merging and the deployment going live,
production is legitimately behind `main`; wiring this into CI would make every
merge red for two minutes and teach everyone to ignore it.

---

## 4 · Proved red by control — all four paths

| control | expected | result |
|---|---|---|
| A · served == origin/main | green | `exit 0` · `✓ production is serving the tip of main` |
| B · `--expect b87d817…` | red | `exit 1` · both SHAs printed |
| C · build with no `VERCEL_GIT_COMMIT_SHA` | red | `exit 1` · *"the live build does not know which commit it is"* |
| D · endpoint absent (run against production **before** this shipped) | red | `exit 1` · *"answered 404 … which is itself drift"* |

Control D is worth noting: the very first run of this gate went red against real
production, for a real reason, before a line of it had been deployed.

**Exit codes were verified without a pipe.** `npm run … | tail` reports `tail`'s
status, which showed `exit=0` on a run that had just printed a failure — a gate
that prints red and exits 0 is worthless, so I checked.

### The health card, in all four states

Driven in a real browser as a real admin, asserting the section is on screen:

```
in_sync           DEPLOYED BUILD  IN SYNC WITH MAIN | Serving 317839e… | main · production
drifted           DEPLOYED BUILD  BEHIND MAIN | Serving b87d817… | Tip of main 317839e… | …
expected_unknown  DEPLOYED BUILD  UNVERIFIED | Serving 317839e… | "…not a confirmation…"
unknown           DEPLOYED BUILD  UNVERIFIED | "Cannot tell which commit is running."
```

The `drifted` control is the incident reproduced exactly: a build stamped
`b87d817` — the 14 August build that really was live — against a `main` at
`317839e`.

---

## 5 · Verification, as specified

```
$ curl -s https://www.footvault.in/shop | grep -o "card-media bg-[a-z]*" | sort -u
card-media bg-photo

$ curl -s https://www.footvault.in/api/version
{"state":"known","commit":"2e2e87f1e53cfbcad8aa88d17f8d27c3ca7a1b4d","ref":"main","environment":"production"}

$ npm run audit:deploy-drift
✓ production is serving the tip of main        (exit 0)
```

Production target: `2e2e87f1e53cfbcad8aa88d17f8d27c3ca7a1b4d`, `READY`, created
01:39:00. Region pin intact — `x-vercel-id: bom1::bom1::…`.

This deployment went straight to `BUILDING`. No block.

---

## 6 · Full six-job battery

```
typecheck              tsc --noEmit                                    clean
lint                   eslint .                                        clean
shapes                 16 cached shapes unchanged at v9
guard:use-server       28 "use server" files, all export async only
guard:client-imports   98 "use client" vs 76 server-only, none imports one
build                  ✓ Compiled successfully
```

---

## 7 · Nothing needed from you

No plan change, no new project, no relink — none of those were the problem, and
§1.4/§1.5 show the configuration was never touched.

**Optional, one field:** add `GITHUB_REPO_TOKEN` to the Vercel project's
environment variables to upgrade the health card from `unverified` to a real
verdict.

1. Vercel → **foot-vault** → **Settings** → **Environment Variables**
2. Name `GITHUB_REPO_TOKEN`, scope **Production**
3. Value: a GitHub fine-grained token with **Contents: Read-only** on
   `ahammedejaz/footVault` (GitHub → Settings → Developer settings → Personal
   access tokens → Fine-grained)
4. **Save**, then redeploy once so the build picks it up

Until then `/admin/health` says `unverified`, which is honest, and
`npm run audit:deploy-drift` gives the full verdict regardless — it reads the
branch from local git and needs no token at all.

---

## 8 · What went wrong on my side

- **I diagnosed a deploy from a `curl` and a state field, twice.** The first
  report concluded the Vercel↔GitHub linkage had changed. The data never
  supported that — `e8bc351` and `317839e` share an author and got opposite
  answers ten minutes apart, which was visible at the time and which I did not
  check. The authoritative source is `targets.production` plus
  `readyStateReason`, and I now reach for both first.
- **I merged PR #47 on a reading of the blocked preview that I had not
  verified.** "Every prior deployment here was `target: production`, so previews
  must be disabled" was plausible and wrong; one call to `readyStateReason` on
  the preview would have said so before the merge rather than after. It caused
  no harm — the migrations were already live and the code was inert until it
  deployed — but it was a guess presented as a finding.
- **The `exit=0` trap.** `npm run … | tail` reports the pipe's last command.
  A gate can print a failure and appear to succeed. Worth remembering for any
  future check.
