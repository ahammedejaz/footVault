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

**The repository is public, so no token is needed for a full verdict** — the
card asks GitHub's API unauthenticated. (The check shipped on 2026-08-20
believing the repo private and demanding `GITHUB_REPO_TOKEN`; that premise was
false, and would have left the card saying `unverified` until somebody minted a
token for a fact anyone can read.) The one limit of the tokenless call is
GitHub's unauthenticated rate cap — 60 requests/hour per IP, shared across
whoever else exits Vercel through the same address. If the card starts showing
"GitHub answered 403", set `GITHUB_REPO_TOKEN` in the Vercel project's
environment variables — a fine-grained token with read-only Contents access to
this repository raises the cap to 5,000/hour. `VERCEL_GIT_REPO_OWNER` and
`VERCEL_GIT_REPO_SLUG` come from Vercel automatically.

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
