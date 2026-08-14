# The social links, the harness guard, and why CI was red

2026-08-14, fourth message of the day.

---

## 1 · CI was red on all four of my commits, and it was mine

It was green before today and failed on every commit since. One cause, in
`npm run shapes`:

```
SHAPE_VERSION moved from v5 to v7 but no cached
shape changed. Either the bump is unnecessary, or the snapshot is stale —
run `npm run shapes:write` to settle it.
```

`scripts/shape-snapshot.ts` hashes the structural return type of every
`cached*` binding and records it next to the current `SHAPE_VERSION`. I bumped
that version twice — v6 for the launch copy, v7 for the town — for **cache
invalidation**, which moves no type. The snapshot then disagreed and CI failed.

The bumps were right; the snapshot needed re-recording. Fixed with
`npm run shapes:write` — the hash is byte-identical (`4a4cd643093e3250`), only
the version field moved, which is itself the proof that no shape changed.

The file's own header listed three outcomes and not this one, so it read as
though a bump without a shape change were an error. It now documents the fourth
case and says why it is legitimate, pointing at `cached.ts` for the reason
`SHAPE_VERSION` is the only lever that clears Vercel's Data Cache.

**The process failure is the more useful half.** My "final battery" was
typecheck and lint. CI runs six things: typecheck, lint, **shapes**, a build on
placeholder credentials, a `"use server"` export check, and a secrets job with
three greps. I was declaring a battery complete that was missing two thirds of
the gate, which is how four red commits landed on main without my noticing.
All six now run locally and pass.

One of them cannot be run faithfully on this machine: the client-component
guard uses `grep -P`, and BSD grep has no `-P`. Run verbatim it errors on every
file and the loop concludes "clean" without testing anything — a check that
passes because it failed. I re-ran it through Node's regex engine instead: 97
`"use client"` files scanned, none value-imports a server-only module.

---

## 2 · Social links

| | |
|---|---|
| `social.instagram` | `https://www.instagram.com/_footvault/` — stored without `?hl=en` |
| `social.facebook` | **key removed entirely**, not blanked |

Measured on a production build, `/`:

```
  <li> social entries: 1
  total rel=me links:  1
  instagram hrefs:     href="https://www.instagram.com/_footvault/"
  facebook anywhere:   0
```

Exactly one icon, opening the Instagram profile. `audit:contact` is **fully
green**, and no assertion in it was altered — `social.facebook` reads as
`· not set`, which the gate already treated as a note rather than a failure.

### The cleared state is now deliberate in two ways

The footer built its list with `Object.entries(social).filter(([, href]) =>
Boolean(href))` and then rendered `{Icon ? <Icon/> : null}` inside the link. A
network with a value but no known glyph therefore produced an `<a>` containing
only screen-reader text: **a focusable, invisible link** a keyboard user lands
on and cannot see. `renderableSocials()` now requires both a href and an icon,
so an entry that cannot be rendered is not rendered.

The icons stay in `SOCIAL_ICONS`. Deleting the Facebook glyph would mean that
adding a Facebook account later produced exactly the invisible link above. The
account's absence is data; the ability to render one is code.

**A latent bug came out of this.** Typecheck failed with *"This condition will
always return true since this function is always defined"* — because
`iconFor` was `SOCIAL_ICONS[name as keyof typeof SOCIAL_ICONS]`, and the cast
asserts the key exists. The compiler believed the icon was always present, so
the `{Icon ? … : null}` guard was **dead to the type checker and load-bearing at
runtime**. `iconFor` now returns `| undefined` honestly and checks with
`Object.hasOwn`. `site_settings.social` is owner-edited jsonb; any key can
appear in it.

`SHAPE_VERSION` v7 → v8. The footer reads `social` through
`cachedSiteSettings` on every route, so a v7 entry written before the row
changed still holds the Facebook URL — the deploy that removes the icon would
have gone on rendering a link to an account that does not exist until the hour
ran out.

No `sameAs` was added anywhere.

---

## 3 · The guard already existed, and my last report was wrong about it

I reported `audit:settings-controls` as unguarded. **That was incorrect and I
should have read the file rather than the symptom.** Line 58 calls
`assertNotProduction("run settings-controls")` at module scope, and
`scripts/audit/clients.ts` documents the exact principle asked for here:

> the guard is no longer a property of the *file* — it is a property of the
> *credential*.

Proven, both directions:

**Production credentials — refuses**

```
$ AUDIT_TARGET=env-local npx tsx scripts/audit/settings-controls.ts
Error: Refusing to build QA fixtures against the production database.

  NEXT_PUBLIC_SUPABASE_URL points at ahumjhwqgmskjsitctcj, which is the live shop.
  These harnesses create QA accounts, carts and real orders. Running them here
  would put test data next to real customers, and nothing would undo it.
```

**Staging credentials — runs**

```
$ npx tsx scripts/audit/settings-controls.ts     # against dev:stage
  ✓ all 40 controls were located, changed and checked
  restored every settings row this run touched
52 passed, 0 failed
```

---

## 4 · So what actually happened on 2026-08-14, corrected

The credential guard passed, because the credentials **were** staging. The two
guest carts still landed in production because the *browser* was pointed at
`AUDIT_BASE_URL=http://localhost:3213` — a `next start` serving a production
build against the live database.

Every write the admin client made went to staging. Every write the browser made
went to production. The crash was `no active cart to convert`: the cart existed,
in the other database.

**`AUDIT_BASE_URL` moves the browser, the credentials move the client, and a
guard on either says nothing about the other.** That is the hole, and it is the
inverse of what I reported.

`assertServerNotProduction(baseUrl, action)` closes it for this harness, called
first in `main()` before an account is created or a row is read. It reads the
project ref out of the served markup, because production serves every catalogue
image from Supabase storage.

**Production-backed server — refuses**

```
$ AUDIT_BASE_URL=https://www.footvault.in npx tsx scripts/audit/settings-controls.ts
Error: Refusing to run settings-controls: https://www.footvault.in is serving
the production database.

  The server there is backed by ahumjhwqgmskjsitctcj, the live shop.
  This harness types QA values into real forms, so the browser writes them
  wherever that server points — no matter what credentials this process
  holds, and this process's credentials are pblgpvcdappfpoxdascd.
```

**Staging-backed server — runs**: the full 52-assertion pass quoted in §3.

### What this guard cannot see, stated rather than discovered

It is **positive evidence only**. Staging serves its seeded images from local
static media (`/_next/image?url=%2F_next%2Fstatic%2Fmedia%2F…`) — no Supabase
host appears in its markup at all. My first version refused on "cannot
determine", which would have blocked every legitimate staging run; I found that
by running the positive control, which is the argument for running it.

So absence means "found nothing" and the run proceeds. A production server with
no Supabase-hosted image would pass. That is not the shape of this production —
122 product images, all in the storage bucket — and the limit is written into
the function's header rather than left to be discovered.

---

## 5 · The rest of `scripts/audit/` — report only, nothing fixed

43 harnesses write, or drive a form that writes. Of those, **19 are
browser-driven through `BASE_URL` with no server-side check**, which is the
shape that produced the incident.

**Neither guard — 2:**

| Harness | |
|---|---|
| `interactions.ts` | Clicks **"Add to bag"**. Pointed at a production-backed server it creates carts in the live shop, exactly as happened. No credential guard, no server check. |
| `keyboard.ts` | A false positive of my detector — it matched `.press(`, which is navigation. I read it: no writes. |

**Credential-guarded, server side unguarded — 17:** `a11y`, `admin-pages`,
`appearance`, `checkout-discount`, `customer-reachability`, `delivery-poll`,
`fixtures`, `focus-ring`, `homepage-tokens`, `hydration`, `image-editor`,
`image-upload`, `keyboard-checkout`, `loyalty`, `overflow`, `reviews`,
`signed-in`.

These are safe from the credential half and exposed on the browser half. The fix
is one line each — `await assertServerNotProduction(BASE_URL, "run <name>")` at
the top of `main()` — and `interactions.ts` needs `assertNotProduction` as well.
Not done, per your instruction.

`customer-reachability.ts` is the one that actually fired, so it is the one I
would do first.
