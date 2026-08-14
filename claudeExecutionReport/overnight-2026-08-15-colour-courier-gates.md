# Overnight run — the colour write path, the courier's voice, and the gates that go red

**Ran:** 2026-08-15, 00:35 → 03:00 IST, unattended.
**Branch:** `main`, six commits, `1398c25 → 0a31249`. 49 files, +5,085 / −161.
**Deployed:** four times to production, each verified by alias.
**Migrations:** two, both additive, both proven by `rebuild:stage` from empty and pushed to production after a content-verified dump.

---

## 0 · The one-paragraph version

The owner's uploaded photograph is now on the live shop — it went from **0 to 2
`<img>` tags inside the Asics gallery**, which is the actual defect, fixed and
verified on production. Uploads can now carry a colourway, existing rows can be
retagged, and renaming a colourway takes its photographs with it inside the same
transaction. A courier webhook receiver exists at
`https://www.footvault.in/api/parcel/inbound`, and it is already earning its
keep: within 20 minutes of deploying, the reconciliation sweep asked Shiprocket
about **FV-2026-00668** and was told **"Canceled"** — from the source of truth,
unprompted — and raised it, alongside **FV-2026-00571** stalled 7 days with ₹349
held. Neither order was touched, neither rupee moved. Three new gates and four
red-control proofs; nine harnesses that could have written to the live shop are
now guarded; `audit:focus` is green for the first time.

---

## 1 · Decisions

Every one of these was mine to take. What I rejected is here too, because that
is the part you cannot reconstruct from the diff.

### 1.1 Option A, not Option B — string colourways, finished

**Chosen: A.** The column, its index and the storefront's per-colourway
selection have existed since Phase 3. Only the write half was missing. B is a
new `product_colorways` table, FK backfill of 403 variants and 124 images, RLS,
restated grants, a shapes re-record, a `literals` classification and a full
production migration procedure — for a benefit the audit itself calls
theoretical, on a catalogue of 35 products.

**What I did with B's one real advantage.** B is rename-safe by construction;
A is not. That was the strongest argument for B and it cost one trigger to
neutralise, so it is no longer an argument. See 1.2.

**What I gave up.** Per-colourway image *ordering* is still derived from the
product-global `sort_order`, and "main image" is still product-global. Neither
has been asked for. B stays available; it is strictly easier to do later against
a model where the column is actually written than against one where it is not.

### 1.2 The rename cascade is a database trigger, not a line in `saveVariant`

Two reasons, and the second is the one that decided it.

It has to be in the *same transaction* as the rename, and two PostgREST calls
are two transactions with a window in between.

And a rule that lives in one Server Action holds only for callers who used that
action. The seed renames colourways. A SQL fix-up renames colourways. Whatever
writes variants next year will rename colourways. `product_variants_colour_follows_images`
fires for all of them.

The hard part was distinguishing a **rename** from a **split**. A colourway
rename arrives as N separate row updates — one per size — so a row-level trigger
sees intermediate states where some sizes say "Navy" and some say "Midnight".
The guard is *"does any other variant of this product still carry the old
string"*: every update but the last is a no-op, the last one moves the images.
That gives statement-level correctness from a row-level trigger, and it happens
to be exactly the predicate that separates a rename from a genuine split.

**A merge moves the photographs.** Renaming the last "Navy" variant to an
existing "Midnight" merges Navy's gallery into Midnight's. The alternative is
leaving them tagged with a colourway that no longer exists, where they are shown
on no page at all. The admin now prints where every photograph is shown, so a
merge nobody intended is visible in the place they made it.

### 1.3 The gallery fallback: **always show untagged**

Three readings were available.

| reading | what it does | verdict |
|---|---|---|
| **always** *(chosen)* | untagged means every colourway | an upload that names no colour is visible everywhere; the owner cannot make a photograph invisible by forgetting a field |
| *fallback only* (what it did) | untagged shown only when a colourway owns nothing | **the bug**: the same untagged row is visible on Woodland and invisible on Asics, and the difference is seed data rather than anything the owner did |
| *never* | a colourway with no photography renders an empty gallery | worst outcome on a page whose entire job is to show the shoe |

"Always" is also what the column has meant since the migration that added it —
that migration says, in as many words, *"NULL means 'applies to every
colourway'"*. The reader simply never implemented it. The cost is that a shot
belonging to one colourway has to say so, which is precisely the control this
deploy adds.

### 1.4 The upload picker defaults to "Every colourway", not to the first colour

Defaulting to the first colourway is tidier and wrong. **A photograph filed
under the wrong colour is invisible on the page the owner was looking at; one
shown on all of them is wrong where they can see it and fix it.** The expensive
mistake is the silent one.

The colour is also deliberately *not* carried across shots the way the crop is.
Two photographs in a row are as often the next colourway as the same shoe from
another angle, and inheriting a colour would file the second under the first's
name without anybody choosing it.

The picker is hidden on single-colourway products: one real option plus "every
colourway" asks the owner for a distinction with no consequence — both render
identically on every page. The per-photograph select in the manager *always*
renders, because that list is where an already-tagged row gets corrected,
including one tagged with a colourway that has since been deleted.

### 1.5 `SHAPE_VERSION` v8 → v9, with no type change

The first bump where the shapes gate could see nothing. `ProductColor.images` is
the same `ProductImage[]` it always was; *which* images are in it changed.
`unstable_cache` keys on its key parts and never on the code that produced the
value, and a deploy calls no `updateTag` — so without the bump every
already-cached product page would have served the old gallery until the hour ran
out. **A value changing meaning is as much a reason to bump as a field
appearing.** The gate refuses a bump with no shape change until the snapshot is
re-recorded, which is the correct friction; `npm run shapes:write` settled it.

### 1.6 The poller **stays**, narrowed to a reconciliation sweep

You asked me to choose between keep, narrow, and delete, and you were right that
two inbound paths which disagree are worse than one. So I made it impossible for
them to disagree rather than deleting one of them.

The webhook, the sweep and the admin's "Refresh tracking" button all parse into
one `CourierSignal` and call one `applyCourierSignal`, and they deduplicate
**against each other** on an `event_key` derived from the *transition* — the
parcel, the status text, the courier's own timestamp — rather than from the
body. A sweep that rediscovers half an hour later what the webhook already
reported writes nothing and raises nothing. One interpreter, three doors.

Given that, the sweep earns its place as the backstop, because every part of the
push path can fail silently and none of it is ours: the subscription lives in
Shiprocket's portal where it can be deleted or disabled by their retry policy,
there is no HMAC and therefore no delivery receipt, and a token rotated in one
place and not the other turns every event into a 401 nobody is watching for. A
pull every thirty minutes notices all of that within thirty minutes.

It also reaches what the webhook structurally cannot: a shipment with **no
AWB**, which produces no courier events because no courier is involved. That is
FV-2026-00571.

**The candidate filter was the actual bug.** It was `status = 'shipped'` — a
status no order in this shop's history has ever reached — so the poller examined
nothing, forty-eight times a day, for six days. It took *our* workflow status as
a precondition for asking *the courier* a question. An AWB is the real
precondition; our status is what the answer might change.

### 1.7 No status map. An unknown is raised.

The sample payload you gave me carries exactly one status — `Delivered`, id 7.
So the vocabulary is `delivered` and `RTO` (the existing regex), and everything
else is recorded with `needs_attention` and waits for a person. `status_id` is
stored on every row and **dispatched on by nothing**, and there is a gate check
asserting that, so a future edit that yields to the temptation has to delete a
check that says why.

This is not a shortcut around writing the map. It is the only behaviour under
which the next thing we have never seen gets noticed — and it is the behaviour
whose absence cost FV-2026-00668. It also means the payloads accumulate, so when
"Canceled" has arrived enough times to be understood, the evidence to write the
map from is all there.

### 1.8 AWB: the **inbound** side is normalised

Shiprocket sends `"awb": 59629792084` — a JSON number. `shipments.awb_code` is
text, written verbatim from the same courier's own AWB-assign response.

I normalised **inbound to text**, for two reasons: our stored value is the
authoritative record of what the courier gave us, and rewriting it would be a
migration over live rows for a formatting concern; and text is the only
representation that survives a leading zero.

There is a trap behind the trap. A 20-digit AWB is past
`Number.MAX_SAFE_INTEGER`, so `JSON.parse` destroys it *before any of our code
runs* — silently, matching no shipment, forever. So the receiver keeps the raw
body and reads the AWB digits out of it with a regex, falling back to the parsed
value only if that fails. The gate proves both halves: the digits come back
exact, and `JSON.parse` really does return `12345678901234567000`.

### 1.9 Matching precedence: AWB → channel_order_id → order_id (both sides)

1. **AWB.** The event is about a *parcel*. It is the courier's own identifier
   for exactly one, we hold it verbatim, and it stays correct on the day a
   Shiprocket order is split into two shipments — at which point the order-level
   ids identify the order and say nothing about which half moved.
2. **`channel_order_id` → `orders.order_number`.** The id *we* chose and sent at
   creation. Unique by construction. Second because it is order-level.
3. **`order_id`, against both sides.** Genuinely ambiguous, and the ambiguity is
   ours: `createShipment` sends `order_id: order.orderNumber`, and Shiprocket
   returns *their* id under the same key in the response we store as
   `shiprocket_order_id`. Theirs is tried first — on an inbound message the
   sender's own identifier is the likelier meaning — and whichever hits is
   recorded in `matched_by`.

**A miss is recorded, raised, and answered `200`.** Not 4xx: Shiprocket retries
non-2xx and eventually disables a subscription that keeps failing, and a
disabled subscription is this whole feature silently gone. The event is durably
stored and on the dashboard before the response is written.

### 1.10 The URL, the header, the token

`https://www.footvault.in/api/parcel/inbound` — clean of `shiprocket`,
`kartrocket`, `sr` and `kr` in **both host and path**. `sr` as a bare substring
is the sharp one; it rules out "courier-status" ... no, it rules out
"shipping-response", "sr-hook", and a great many obvious names. A gate check
asserts all four against the full URL so a future rename cannot quietly break
the portal configuration.

Auth Token Type: **`Authorization`** (the portal's default). The endpoint accepts
the token bare *and* as `Bearer <token>`, because the second is what a person
pastes when the header is called `Authorization` and they have seen an API
before — and refusing it would fail at 2am in a portal with no error detail.

### 1.11 Security: what containment is possible without an HMAC

There is no HMAC. Anyone with the URL and the token can post arbitrary courier
state. That cannot be designed away, only contained:

- **constant-time compare**, so the endpoint is not an oracle for guessing the
  token a byte at a time. Both candidate spellings are always compared — no
  early return — so the number of comparisons does not depend on a match;
- **unset means closed.** An absent `COURIER_WEBHOOK_TOKEN` refuses everything.
  "Unset means open" is how a route quietly becomes public the first time a
  variable fails to copy across;
- **identical `401` for a wrong token and an unreadable body.** The token is
  checked *first*, before the body is touched — ordering, not decoration: an
  unauthenticated caller must not be able to make this function parse anything,
  and checking auth first makes the identical response cost nothing;
- size cap, rate limit, every field optional, nothing required;
- and the containment that matters most: **a forged status cannot move an order
  unless it is one of the two this shop understands, because a real one cannot
  either.**

### 1.12 The money queue computes and points. It does not pay.

`refundPanelState(orderId).refundablePaise` — captured, less refunded, less
in-flight. Read **live** rather than stamped onto the event row, so a refund
issued in the Razorpay dashboard between the alert appearing and somebody
reading it makes the figure go *down* rather than making the shop pay twice.
That sentence is about FV-2026-00623.

Three render states, and the middle one is load-bearing: an amount, "nothing is
refundable", and **"the refundable amount could not be read"**. Null is not zero.
Rendering an unreadable amount as ₹0.00 tells an operator to close the tab.

The only control is *"I have dealt with this"*. The obvious objection is that a
queue you can only dismiss is a queue that gets dismissed. The alternative is a
button on the dashboard that returns a customer's money on the strength of a
courier status string this shop has, by its own admission, never successfully
interpreted. **Whether a parcel is actually dead is a fact that lives in the
Shiprocket portal.** So the mechanism computes the amount, names the order, and
puts a person in front of the decision. Resolving is not destructive — the event
stays, with a resolver and a timestamp.

### 1.13 `STALLED_HOURS = 72`, and why not sooner

A queue with false positives is a queue nobody reads. A normal parcel gets its
AWB in the same sitting as its shipment — the panel's five steps are pressed one
after another. Three days is outside any plausible working pattern including a
weekend, and it is deliberately *not* tuned to catch things sooner: **a parcel
with an AWB has tracking, and evidence beats a clock every time.** The clock is
only for the case with no courier at all.

### 1.14 `audit:focus` — the check was measuring the wrong thing

Diagnosis before fix, as asked. The `/search` input **is** reachable by Tab — at
roughly stop **127**, because the header carries the whole mega-nav and a
brute-force walk crosses every category and every brand. Worse, the count is not
stable: focusing a nav trigger opens its panel and inserts more stops, so the
total drifts either side of the 150 budget. A 150-stop budget is not a property
worth asserting — it degrades every time you add a category, and it measures a
path no keyboard user takes on a page that offers a skip link.

**But there was a real defect underneath, and the old check could never have
found it.** `<main id="main">` had no `tabindex="-1"`. Following `href="#main"`
moves the sequential focus navigation *starting point* in Chrome and Firefox
even when the target cannot hold focus, so the next Tab works and
`document.activeElement` is quietly left as `<body>` — measured, it is. **Safari
moves neither.** A VoiceOver user who presses "Skip to content" then Tab goes
straight back to the top of the header, one category at a time. Your customers
are on phones and a large share are on iOS.

So the gate now measures **keystrokes**: the skip link is first, it puts focus
*inside* main, and the search box is within five presses. Measured: **Tab, Enter,
Tab.**

**The same shape elsewhere:** every storefront overlay and dialog — search panel,
mobile nav, bag drawer, filter sheet — is a Radix `Dialog`/`Sheet` and traps
focus by construction, so none can strand a keyboard user the way a fragment
link can. **The admin shell has neither a `<main>` landmark nor a skip link.**
That is real and I did not fix it: it needs its own gate, and the admin is one
signed-in person on a tablet. It is on the morning list as a finding, not a task.

---

## 2 · What I did NOT do, and why

- **No refund, no order-state change, on either order.** FV-2026-00668 and
  FV-2026-00571 are byte-for-byte as I found them — `updated_at` still 14 Aug
  and 8 Aug, shipment rows untouched, `tracked_at` still null. The mechanism is
  built; the button is left.
- **Nothing in Vercel or the Shiprocket portal.** Both are yours, as instructed.
  §7 is the click-list.
- **No Option B.** See 1.1.
- **No status map from memory.** See 1.7.
- **No `<main>` or skip link in the admin shell.** See 1.14 — a finding, not a
  half-finished piece.
- **No `audit:image-upload` rewrite.** Its §7 card assertion is satisfiable by
  any product's card, which the audit already recorded. It is now superseded by
  `audit:image-colour` rather than patched, because two gates asserting the same
  weak thing is worse than one gate and one strong one.
- **Did not exclude `/api/parcel/inbound` from the session proxy.** It costs one
  Supabase round trip per event and the matcher regex in `src/proxy.ts` is
  load-bearing. Considered and rejected as a micro-optimisation with real risk.

---

## 3 · Gate outputs — red control **and** green, for everything claimed

### 3.1 `audit:image-colour` — new. 20 checks.

**Green** (production build via `build:stage`, `next start` :3210):

```
0 · what this run is scanning
  · scanned 35 active products
  · scanned 24 products with ≥2 colourways that each own photography
  using Adilette Comfort Slide (adidas-adilette-slide-unisex)
    colourways: Black (2 tagged), Navy (2 tagged)
    uploading against "Black", asserting absence on "Navy"
...
4 · the CACHED product page is fresh, and the gallery has it
  ✓ the cached product page serves the new photograph
  ✓ the gallery on "Black" renders it
5 · and the other colourway does not
  ✓ the gallery on "Navy" does not render it
6 · retagging to every colourway puts it on both
  ✓ untagged means every colourway, not a fallback — Black: true, Navy: true
7 · renaming a colourway takes its photographs with it
  ✓ renaming one size out of several moves no photographs — 0 moved
  ✓ renaming the last one moves them all — 2 of 2 followed the rename
  ✓ and renaming back restores them — 2 of 2

image-colour: 20 checks, all green.
```

**Red control A — remove `color` from the insert** (the control you asked for):

```
  ✗ the row carries the colourway the owner chose — stored "(null)", chose "Black"
  ✗ the gallery on "Navy" does not render it
  ✗ and it shows the colour the row actually holds
  ✗ and it did not exist on the page before the upload
image-colour: 4 of 20 checks failed.
```

**Red control B — delete `revalidateCatalog()` from `addProductImage`.** This is
the one `audit:image-upload` cannot do, because `/shop` is uncached:

```
  ✗ the cached product page serves the new photograph
  ✗ the gallery on "Black" renders it
image-colour: 2 of 20 checks failed.
```

**Red control C — restore the fallback-only gallery reading:**

```
  ✗ untagged means every colourway, not a fallback — Black: false, Navy: false
image-colour: 1 of 20 checks failed.
```

Three controls, three disjoint sets of failures. That is what tells you the
checks are measuring different things rather than one thing three times.

> **Red control A also found two bugs in my own gate**, which is what a red
> control is for. The fixture was deterministic, so its derivative content hash
> collided with the previous run's — and cleanup deletes rows with the service
> client, which revalidates nothing, so a stale cached page still carried the
> old photograph at the identical hash. And the colourway order came off
> PostgREST unsorted, so two runs uploaded against different colours and would
> have reported different failures for identical code. Both fixed.

### 3.2 `audit:courier-inbound` — new. 51 checks.

**Green** — full output in the repo; the load-bearing lines:

```
1 · IST, stated in code and provable from outside
  ok  a bare Shiprocket timestamp resolves through +05:30 — 2026-08-14 16:41:59 → 2026-08-14T11:11:59.000Z
  ok  and is NOT read as UTC, which is the 5½-hour bug
  ok  a timestamp that already carries a zone is not shifted twice
2 · awb arrives as a JSON number
  ok  it is normalised to the string our column holds — got "59629792084"
  ok  a long AWB is taken from the raw body, not from the parsed float — 12345678901234567890
  ok  and the parsed float really would have been wrong — JSON.parse gives 12345678901234567000
3 · matching, and the miss that must not be silent
  ok  an event matching no order is RECORDED, not dropped
  ok  and it is raised for a human — unmatched, needsAttention=true
4 · a status we do not understand is raised, never dropped
  ok  "Canceled" — the exact word that started this — is raised — unknown/raised
  ok  and it changes nothing about the order — status shipped
  ok  the id is recorded beside the text, and decided nothing — id 8, made of it: unknown
5 · retries, and events that arrive backwards
  · scanned 5 replays of the identical payload
  ok  every replay is a duplicate, not a second application
  ok  and exactly one row exists for it — 1 rows
  ok  the delivery timestamp is the courier's own — 2026-08-14T06:38:00+00:00 (12:08:00 IST = 06:38:00Z)
  ok  an older event arriving late is recorded as stale
  ok  and the order does not move backwards — delivered, stamp unmoved
6 · the endpoint, as a stranger finds it
  ok  and the refusal is identical to the one for no token — 401:{"ok":false} vs 401:{"ok":false}
  ok  a malformed body answers exactly what a wrong token answers — HTTP 401
  ok  nor wrote a courier event — 0 events
7 · a real POST, end to end
  ok  a correct token in a bare Authorization header is accepted — HTTP 200
  ok  and so is the same token written as a Bearer — HTTP 200
  ok  the POST left exactly one row, not two — 1
8 · the raised event is on an owner's screen
  ok  the dashboard carries a courier strip a person can read
  ok  it names the order the courier was talking about — FV-2026-00041
  ok  and quotes the courier's own word rather than paraphrasing it
  ok  and says something definite about the money
  ok  pressing it records who cleared it and when — resolved_at …, by this admin
  ok  and changes nothing about the order or its money — shipped / paid

courier-inbound: 51 checks, all green.
```

**Red control A — delete the token check:**

```
  FAIL  no token is refused
  FAIL  a wrong token is refused
  FAIL  and the refusal is identical to the one for no token
  FAIL  a malformed body answers exactly what a wrong token answers
  FAIL  and none of it touched the order
  FAIL  nor wrote a courier event
```

Six red — including *"an unauthenticated caller did not touch the order"*, which
means the control proves the endpoint is actually load-bearing rather than
decorative.

**Red control B — change the offset from `+05:30` to `+00:00`** (this is the
"test that would fail if the offset were wrong" you asked for):

```
  FAIL  a bare Shiprocket timestamp resolves through +05:30
  FAIL  and is NOT read as UTC, which is the 5½-hour bug
  FAIL  the delivery timestamp is the courier's own, resolved through IST
```

The third one is the important one: it is the `delivered_at` **actually written
to an order**, not a unit test of the parser.

> **This gate found two real bugs on its first run.** `matchOrder` used
> `.maybeSingle()` on `awb_code`, which has no unique constraint — two shipments
> sharing one AWB *threw*, which inside the receiver is a 500 and a retry loop
> into a disabled subscription. It is an answer now: recorded, raised, nothing
> changed. And §8 went red because the strip lists every raised event
> newest-first, so pressing the first button cleared a different parcel and
> reported the button as broken — the same shape that produced "the loader is
> not wired" twice in `audit:image-upload`.

### 3.3 `audit:focus` — red → green

**Before** (the state you described):

```
  FAIL  the /search input is reachable by Tab  — never focused in 150 stops
1 check(s) FAILED — the focus indicator is not what globals.css says it is.
```

**Red control — the new gate against the unfixed `<main>`:**

```
  PASS  the skip link is the first thing a keyboard reaches
  FAIL  and it puts focus inside main, not merely near it
        — without tabindex=-1 this is <body>, which Chrome recovers from and Safari does not
  PASS  the /search input is 5 keystrokes or fewer past the skip link — reached at 1
```

**Green:**

```
  PASS  the skip link is the first thing a keyboard reaches
  PASS  and it puts focus inside main, not merely near it
  PASS  the /search input is 5 keystrokes or fewer past the skip link — reached at 1 — Tab, Enter, Tab
  PASS  the /search input carries the 4px halo
  PASS  no component switches the focus outline off without a reason — 3 allowed, each with a reason

The indicator paints: outline present, 2px, orange, on a halo, on every primitive.
```

### 3.4 `guard:client-imports` — widened, red → green

The old guard named three server-only paths by hand. A Client Component
value-importing `@/lib/payments/health` sailed past it and was caught by the
*build*, minutes later, with a stack trace.

**Red control — the exact import it missed:**

```
Client components importing a server-only module (value import):
  src/components/admin/shipping/courier-alert.tsx
exit=1
```

**Green, with the list derived from the tree:**

```
98 "use client" files scanned against 76 server-only modules, none value-imports one.
```

### 3.5 `audit:literals` — the untracked blind spot, red → green

**Red control — an untracked component with `₹2,499` in it:**

| discovery | files scanned | untracked offender found |
|---|---|---|
| `git ls-files` (before) | 182 | **no** |
| `--cached --others --exclude-standard` (after) | 183 | **yes** |

The fix immediately caught a real offender — **mine**, added in this session's
courier commit and hidden by this exact blind spot when I ran the gate an hour
earlier. It turned out to be a *false positive*: the comment stripper knew `/*`
and not `{/*`, so a rupee figure inside a JSX comment was reported as copy. A
false positive on this rule is worse than a gap, because it is the reason
somebody eventually deletes the rule. Both fixed; gate green at 182/377 files.

### 3.6 `audit:fixtures-guard` — the "all 19" claim was not true

The new rule — *every file that calls `chromium.launch(` carries **both**
guards* — went red on **six** harnesses:

| harness | missing |
|---|---|
| `bag-flow.ts` (`audit:bag`) | **both** |
| `gallery.ts` | **both** |
| `links.ts` | **both** |
| `screenshots.ts` (`audit:shots`) | **both** |
| `address-book.ts` | server guard |
| `hero-media.ts` | server guard |

`bag-flow` is the harness that walks the entire purchase path in a browser and
can leave an order behind. Pointed at a production build it would do precisely
what happened on 2026-08-14. Plus the four the brief named or implied — `a11y`,
`admin-pages`, `keyboard`, `keyboard-checkout` — that had no *credential* guard
because they do not write.

**Green: `PASS — 68/68 checks`, 24 browser-driving harnesses checked.** The
check refuses to report a pass if it matches zero harnesses.

### 3.7 Neighbouring gates, unbroken

```
audit:images          76 checks, all green   (· scanned 6 awkward source photographs
                                              · scanned 4 canonical widths)
audit:gallery         PASS                   (· scanned 2 viewport widths)
audit:delivery-poll   PASS — 26/26 checks
audit:rto             PASS — 35/35 checks
audit:literals        No policy number is typed anywhere.  (182 / 377 files, 37 tables classified)
audit:links           122 pages, 1833 links, no broken links
```

---

## 4 · All six CI jobs, at `0a31249`

| # | job | command | exit | scan count |
|---|---|---|---|---|
| 1 | Typecheck | `npm run typecheck` | **0** | — |
| 2 | Lint | `npm run lint` | **0** | — |
| 3 | Cached shapes match SHAPE_VERSION | `npm run shapes` | **0** | `16 cached shapes unchanged at v9` |
| 4 | Build | `npm run build` (CI env) | **0** | 21 routes emitted |
| 5 | `use server` exports async only | `npm run guard:use-server` | **0** | `28 "use server" files scanned` |
| 6 | Client → server-only imports | `npm run guard:client-imports` | **0** | `98 "use client" files scanned against 76 server-only modules` |

Run in full before **every** commit tonight, not typecheck-and-lint. Job 4
earned its place: it is the only one that caught the `server-only` import in
`courier-alert.tsx`.

---

## 5 · Deploy record

| commit | what | promotion | verified by |
|---|---|---|---|
| `f5ff280` | colour write path + rename cascade | Production, Ready 50s | **the Asics gallery on `www.footvault.in` went from 0 → 2 `<img>` tags carrying the owner's upload** |
| `3686628` | courier inbound | Production, Ready 1m | `POST /api/parcel/inbound` → `401 {"ok":false}`; `POST /api/parcel/definitely-not-a-route` → `404 {"error":"Not found"}` — the new route is live and distinguishable from the API catch-all |
| `65ecb17` | audit guards | Production, Ready 51s | (no runtime surface) |
| `1e17865`, `0a31249` | a11y + gate | Production, Ready 44s | `<main id="main" tabindex="-1" class="flex-1">` on `www.footvault.in/search` — a string that cannot exist in the previous tree |

Always `www.footvault.in`; the apex 308s and `*.vercel.app` is SSO-gated.

**Migrations.** Both pushed following the full procedure:

1. `npm run rebuild:stage` — 116 migrations replayed from empty, seed, 8/8
   verification checks green.
2. Production dump, **content-verified**: 36 tables / 62 policies / 37 functions
   in the schema dump ending in the default-privileges block; 124 `product_images`,
   403 `product_variants`, 35 products, 25 orders, 2 shipments in the data dump,
   newest order `FV-2026-00668` present, ends `RESET ALL;`.
3. Dry run listed exactly the two expected files, then pushed.
4. **Post-push gates:** trigger present ×1; function ACL
   `{postgres=X/postgres,service_role=X/postgres}` — no PUBLIC, matching the
   house pattern; `courier_events` table + 1 policy + 4 indexes; **data
   unchanged** (124 / 4 / 403); PostgREST reloaded on its own — `service_role`
   `200`, `anon` `401 permission denied` (not a 404, which is what a stale cache
   looks like).

---

## 6 · Things that turned out not to be what we believed

**The reconciliation sweep confirmed the cancellation from the source of truth,
by itself, on its own schedule.** Twenty minutes after deploy, at 20:30 UTC:

```
source  interpretation  outcome  status_text  matched_by  order          order_status
sweep   unknown         raised   Canceled     awb         FV-2026-00668  packed
sweep   stalled         raised   —            stalled_sweep FV-2026-00571 packed
```

We *believed* FV-2026-00668 was cancelled because you told us. Shiprocket now
says so in our own database, matched by AWB `19041948084873`. **Both orders are
untouched** — `orders.updated_at` still 14 Aug 15:52 and 8 Aug 17:48,
`shipments.updated_at` unchanged, `tracked_at` still null. The unknown-status
path returns *before* it touches the shipment, so even the cached courier status
was left alone.

**And the idempotency is proven on production, not only on staging.** Two real
cron ticks have run since the deploy (20:30 and 21:00 UTC). The second re-asked
Shiprocket about the same parcel, was told "Canceled" again, derived the same
`event_key`, and wrote nothing:

```
now_utc                        total_rows  distinct_keys  ticks_since_deploy  the_two_orders
2026-08-14 21:01:53.809765+00  2           2              2                   FV-2026-00571 packed/paid | FV-2026-00668 packed/paid
```

Two rows, two keys, two ticks, no duplicate alert about one parcel — which is
the property the whole shared-`event_key` design exists for, measured against
the live shop rather than a fixture.

**`audit:image-upload` was not merely weak — it was written around the defect.**
Its own header explains that asserting on the product page "would fail for a
reason that has nothing to do with this pipeline". That reason *was* the bug.
The upload appears **four times** in a production product page — JSON-LD, RSC
`heroImage`, RSC product-level `images` — and **zero** times in the gallery a
customer looks at. Any `html.includes()` check was always going to be green.

**"All 19 browser-driven harnesses are guarded" was not true.** Six were not.
Four had no guard at all, one of them `audit:bag`. See 3.6.

**`guard:client-imports` had a hole the size of 73 modules.** It knew three
server-only paths; there are 76.

**`audit:literals` §1 hid one of my own defects from me, tonight**, in the exact
way the brief predicted it would.

**The `/search` input is not unreachable.** It is reachable in three keystrokes
via the skip link, and in ~127 without it. The gate's failure was real but its
message was wrong, and the defect underneath it was a missing `tabindex` that
only bites Safari.

---

## 7 · Waiting for you in the morning

1. **Vercel → `foot-vault` → Settings → Environment Variables → Add.**
   `COURIER_WEBHOOK_TOKEN`, scope **Production** (and Preview if you want
   previews to accept it). Generate the value with:
   `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`
   **Then redeploy** — env vars are read at boot. Until this is set the endpoint
   refuses every request, deliberately, and that is its current state.
2. **Shiprocket portal → Settings → API → Webhooks.**
   - Webhook URL: `https://www.footvault.in/api/parcel/inbound`
   - Auth Token Type: **`Authorization`** (leave the dropdown on its default)
   - Auth Token: the *same* value you set in step 1
   - Method: POST
   Do **not** paste a `*.vercel.app` URL — it is SSO-gated and every event 401s.
3. **Press "Test Webhook", then look in this order.**
   - `/admin` — a red strip reading *"A courier said something about a parcel
     that this shop did not act on."* Shiprocket's test payload names a parcel
     we have never heard of, so the expected row is *"A courier update arrived
     for a parcel this shop cannot find. AWB …"*. **That is a success** — URL
     resolved, token matched, body parsed, row written.
   - Vercel → Logs, filtered to `/api/parcel/inbound`. Success logs
     `[parcel-inbound] recorded — NEEDS ATTENTION` at **error** level with the
     AWB, status, parsed timestamp and interpretation. A rejection logs
     `[parcel-inbound] refused: bad or missing token` and answers 401.
   - The payload itself: `select * from courier_events order by received_at desc limit 5;`
   - Clear it with **"I have dealt with this"** on the strip.
4. **The two money decisions.** Both are already on `/admin` waiting for you.

   | order | held | what is known | what is not |
   |---|---|---|---|
   | **FV-2026-00668** | **₹13.50** (Razorpay, fully prepaid; `advance_amount` = `grand_total` = 1350 paise) | Shiprocket says **"Canceled"** on AWB `19041948084873`, confirmed from their API into our database at 20:30 UTC | whether you want it refunded or the parcel rebooked |
   | **FV-2026-00571** | **₹349.00** (Pay-on-Delivery advance; ₹1,499 balance never collected, of ₹1,848) | shipment created 8 Aug, **no AWB ever assigned**, 7 days stalled | **whether that shipment is dead** — that answer is in the Shiprocket panel, not in this repo |

   Neither order has been touched and no money has moved. If you decide to
   refund: cancel the order here first (it will refuse and show you the exact
   outstanding), then refund from the order's own panel or the Razorpay
   dashboard — `refund.processed` settles our row either way.
5. **Retag the four untagged photographs, if you want to.** There were **four**
   `product_images` rows at `color = null` — one Asics upload (yours, 14 Aug)
   and three Woodland. They are all now shown on *every* colourway, which is the
   correct default; the per-photograph select on each product's Photographs
   panel narrows one to a colourway if you want it narrowed.
6. **A finding, not a task: the admin shell has no `<main>` landmark and no skip
   link.** Real, low-priority (one signed-in person), and it needs its own gate.
   Say the word and it is a twenty-minute piece.
7. **Nothing else is pending.** Working tree clean, `main` pushed, production
   deployed and verified, all six CI jobs green at `0a31249`.

---

## 8 · What went wrong, and what I had to undo

- **I corrupted `.env.local` for about four minutes.** The file had no trailing
  newline, so `echo "COURIER_WEBHOOK_TOKEN=…" >>` appended onto the end of
  `RESEND_WEBHOOK_SECRET=`, silently joining the two. Caught by the gate failing
  on a token it could not read. Repaired by splitting the line and restoring the
  trailing newline; `RESEND_WEBHOOK_SECRET` verified intact. `.env.local` is
  gitignored, so nothing reached the repository — but it is exactly the kind of
  shell mistake that would have been much worse against a file that ships.
- **I served the wrong build to a harness and misread the result.** `npm run
  build` (the CI battery, with placeholder Supabase credentials) overwrites the
  same `.next` directory as `npm run build:stage`, so `start:stage` cheerfully
  served a build pointed at `placeholder.supabase.co` and every page 500ed. Lost
  about ten minutes to diagnosing a "staging outage" that was a stale artifact.
  **The battery and the staging server cannot share a build directory; run
  `build:stage` after any battery run.**
- **Three gates went red on their own first runs, each for a bug in the gate
  rather than the code** — the colliding content hash, the unsorted colourways,
  the wrong button in the strip. All three were found by red controls or by the
  gate itself, which is the argument for running the control rather than
  trusting the green.
- **One real production-code bug shipped and was caught before anyone used it:**
  `matchOrder`'s `.maybeSingle()` on a non-unique column. Fixed in the same
  session, before the webhook was ever configured.
- **Nothing was reverted.** Every red control was restored and re-proven green,
  and both restorations were confirmed by re-running the gate rather than by
  reading the diff.
