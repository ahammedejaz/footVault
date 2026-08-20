# Operations

Things that need a decision while they are happening, and the reasoning that
should survive the person who worked them out. Not a description of the system —
`architecture.md` is that — but a record of what a given signal means, and what
it does **not** mean.

---

## Content-Security-Policy

The policy lives in `src/lib/csp.ts`, which carries the reasoning for every
directive in it. Two things about reading its output belong here instead,
because they are about interpreting a live signal rather than about the policy.

Enforcing since 2026-08-13 (`CSP_MODE = "enforce"`). Before that it ran
Report-Only from 2026-08-13, through one real UPI payment on production.

### A `[csp]` line naming `www.google.com` is the contact page's map

`frame-src` carries one non-payment origin: the Google map embedded on
`/page/contact`, so a customer can navigate to the shop. A violation naming it
means the map is being blocked and the page is showing an empty box — not a
Google outage, which is what it looks like. The cause is almost always that the
origin was dropped from `csp.ts`; `npm run audit:headers` fails on exactly that,
and the CSP header is baked into the build manifest, so restarting a server and
re-reading the header will _not_ show the change. Rebuild.

Google is a declared processor for this, not only for sign-in: loading that page
sends every visitor's IP address to Google whether or not they touch the map, and
the privacy page says so. `npm run audit:privacy` fails if the origin is in the
CSP and the policy stops naming its owner.

### A `[csp]` line naming a razorpay.com origin is a payments incident

Not a policy nit, not a tuning item, not something to file. **Treat a run of
them the way you would treat the Pay button being dead, because that is what it
is.**

The reasoning is about where Razorpay's code comes from and when:

- `checkout.razorpay.com/v1/checkout.js` is **fetched fresh at every checkout**.
  It is not vendored, not pinned, and not in our build. Razorpay can change what
  that file loads at any time, and it reaches customers with no deploy on our
  side and no review on anyone's.

- Our allowlist was derived by reading _that file, on one particular day_ — see
  the origin list in `csp.ts`. It is a snapshot of someone else's dependency
  graph. Nothing keeps it current.

- Under `enforce`, an origin that is not on the list is **blocked**, and the
  failure is the silent shape the whole staged rollout was built to avoid: the
  modal does not open, or opens and cannot complete. No error the customer can
  report. The order row already exists as `pending` with stock reserved, so the
  first server-side sign is a rising abandoned-order count from the sweep, hours
  later.

So a razorpay.com origin appearing in **our** violation log is specifically the
signal that this has happened. It is worth being precise about why it is that
specific:

> Razorpay's fraud stack — `sardine.ai`, `browser.sentry-cdn.com`, the
> `localhost` probe ports — runs inside the cross-origin `api.razorpay.com`
> iframe. **A document's CSP does not govern another origin's frame.** Those
> services are outside our policy by construction and cannot appear in our
> reports. Verified 2026-08-13 by reading `checkout.js`: `sardine` and the
> localhost ports appear nowhere in it, and the single `sentry-cdn` reference is
> a string literal inside an error-message filter array, never a script source.

Which means a razorpay.com origin in our log is not their iframe being noisy.
It is something that used to load inside their frame now loading **from our
document**, or a new origin they have started using. Either way our allowlist is
stale against the code customers are running _right now_.

**What to do.** Add the origin to the right directive in `csp.ts` and deploy —
this is one of the few changes worth shipping without waiting for a batch. If
several appear at once, or if you cannot tell which directive is right, set
`CSP_MODE = "report-only"` and deploy that first: it restores payments
immediately while keeping the signal, and the flip back is one word. A dead Pay
button costs more per hour than an unenforced policy does.

### Silence at the sink is not evidence of a clean run

`/api/csp-report` receiving nothing does **not** mean there were no violations.

Browser-to-sink delivery has never been demonstrated. The endpoint is proven to
work when something posts to it — `audit:headers` §9 covers both wire formats,
malformed bodies, oversized bodies, extension-noise classification, and the
`[csp]` log line — but that is the sink's half. The browser's half is unproven:
Chromium driven by Playwright detects violations, logs them to the console, and
sends nothing. Checked headless, headed, with `--disable-background-networking`
removed, watching at CDP level for ninety seconds. Zero report requests every
time.

That is most likely the harness rather than the browser — report delivery is
background networking, which automation environments routinely suppress, and
Chrome prefers the batched `report-to` path when a policy offers both. It is
written down as unproven rather than explained away, because a sink nobody has
watched receive is exactly the kind of thing that gets trusted by default.

**So when you need to know whether a flow is clean, the browser console is the
primary instrument.** A violation always logs there, in every browser, with no
delivery step in between. The endpoint is the secondary one, listening
afterwards for what real customers hit.

The asymmetry is the whole point, and it only runs one way:

| Observation          | What it means                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `[csp]` lines arrive | Real violations, **and** delivery works — the console can be retired as primary                               |
| Nothing arrives      | Nothing. Could be a clean run; could be that browsers never deliver here. Not distinguishable from this side. |

A "zero violations" claim is therefore only as good as the console it was read
from. The first deploy report made exactly this mistake in a different form — it
recorded zero violations from a session run against `next dev`, whose policy
carries `'unsafe-eval'`, so the one real violation on `/checkout` could not have
appeared. **Measure against a production build, and say which instrument you
used.**

## Is production serving what was merged?

`main` moving and production not following is a failure with **no natural
signal**. Nothing goes red: CI passes on the commit, the merge succeeds, and the
shop keeps answering 200 with older code. On 2026-08-20 that ran for 23 minutes
across four refused deployments and was caught by a person noticing the colour
behind a photograph.

Two things now answer the question.

### `/admin/health` → "Deployed build"

The first card on the page, because it can invalidate every card below it: if
the build answering the request is not the build that was merged, the rest of
the page is reporting truthfully about the wrong code.

| Chip | Meaning |
|---|---|
| `in sync with main` | the deployed commit is the tip of `main` |
| `behind main` | **merged work is not live** — both SHAs are printed |
| `unverified` | it could not check, which is *not* a pass |

`unverified` appears when the build has no `VERCEL_GIT_COMMIT_SHA` (any build
that is not a Vercel build — `next dev`, `start:stage`, CI) or when the tip of
the branch could not be read.

**The repository is private (since 2026-08-20), so the card needs
`GITHUB_REPO_TOKEN` for a full verdict.** Without it, GitHub answers the card's
unauthenticated request with 404 — GitHub hides that a private repository
exists at all — and the card shows `unverified` with that exact explanation. It
never guesses: in the window between the repository going private and the token
landing, the card says it cannot tell, which is the honest state. (History, for
whoever reads the diffs: the check shipped on the morning of 2026-08-20
believing the repo private, was corrected that night when it turned out to be
public, and the repo was then *made* private the next day. The tokenless path
now exists only as the degraded state.)

**Minting the token — the exact clicks, on github.com logged in as the
repository owner:**

1. Click your avatar (top right) → **Settings**.
2. Left sidebar, bottom: **Developer settings**.
3. **Personal access tokens** → **Fine-grained tokens** → **Generate new
   token**.
4. **Token name**: `footvault-health-card`. **Expiration**: 90 days is the
   longest that does not become a forgotten credential — put a reminder where
   you will see it, because when it lapses the card degrades back to
   `unverified` (honestly, with the reason named) until you mint a new one.
5. **Resource owner**: your account. **Repository access**: *Only select
   repositories* → pick `footVault` and nothing else.
6. **Permissions** → *Repository permissions* → **Contents**: *Read-only*.
   (Metadata: Read-only is added automatically.) Leave every other permission
   on *No access*.
7. **Generate token**, and copy it — it is shown once.

**Putting it where the card reads it — on vercel.com:**

1. Open the `footvault` project → **Settings** → **Environment Variables**.
2. **Add**: key `GITHUB_REPO_TOKEN`, paste the token as the value.
3. Environment: tick **Production** only — the card only renders a verdict on
   production builds, and a token in Preview is a copy that exists for no
   reason.
4. **Save**, then — this is the step that is easy to skip — go to
   **Deployments**, open the **⋯** menu on the latest Production deployment,
   and **Redeploy**. Environment variables reach a build when it is *created*;
   the running deployment keeps the environment it was built with, so until a
   redeploy the card stays `unverified`.
5. Open `/admin/health` and confirm the Deployed-build card reads
   `in sync with main`.

`VERCEL_GIT_REPO_OWNER` and `VERCEL_GIT_REPO_SLUG` come from Vercel
automatically. The card's degradation logic — 404 names the private repo and
this remedy, 403 names the token being refused, and no non-200 answer can ever
read as `in sync` — is held by `npm run audit:deploy-drift`, which proves every
branch against a mocked GitHub before it interrogates production.

### `npm run audit:deploy-drift`

The loud version, and the one to run after any deploy:

```
deploy drift  https://www.footvault.in
  serving   317839ed602b496c59a3faafe9ee86b4dcd75607  (main)
  origin/main 317839ed602b496c59a3faafe9ee86b4dcd75607

✓ production is serving the tip of main
```

It compares `GET /api/version` on the live site against `git rev-parse
origin/main`, and **exits non-zero whenever it cannot establish either side** —
an unreachable site, a 404, a build that does not know its own commit. "Could
not read" is not "in sync"; a check that goes quiet when it cannot see is the
same shape of bug as the one it exists to catch.

To exercise the failure path deliberately:

```bash
npm run audit:deploy-drift -- --expect b87d81741cd48352df9e6a362691aee7f79276e7
```

It announces the override, so a control run can never be mistaken for a real
green one. `DRIFT_BASE_URL` points it somewhere other than production.

**It is deliberately not a PR gate.** Between merging and the deployment going
live, production is legitimately behind `main` — wiring this into CI would make
every merge red for two minutes and teach everyone to ignore it.

### When it is red

The usual cause is a deployment that never built. Vercel reports those as
`readyState: BLOCKED` with `buildingAt == ready == createdAt`, so the inspector
shows no logs, and `gh pr checks` renders it as a plain `fail` on a "Vercel"
check — indistinguishable from a compile error. Read `readyStateReason` on the
deployment rather than the check name:

```bash
curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v13/deployments/<id>?teamId=<team>" \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('readyStateReason'))"
```
