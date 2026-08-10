# Phase 10 · Batch C — the homepage editor

**C1 (the editor), C2 (tokens and rich_text) and C3 (the announcement,
scheduled) are complete and proven. C4 — hero video — is queued at the owner's
instruction: real photography comes before a hero video over placeholder
product photos, and the video bucket does not exist yet.**

C2 was merged and deployed on its own, ahead of the editor, on the owner's
instruction — its bug was live. This report covers all three.

---

## The finding that reordered the batch

**`{{free_shipping_threshold}}` only ever worked in one of six section types.**
`audit:literals` fails the build on a rupee figure typed into
`homepage_sections`, so the owner is *required* to write the token — and the
homepage then printed the token. Substitution happened in `promo_strip` and
nowhere else. Measured on staging with a token in the hero: **three raw
`{{free_shipping_threshold}}` and two `{{return_window}}` served to the
customer**, on the same page whose promo strip rendered ₹6,499 correctly. The
seed uses tokens only in the promo strip, which is why nobody had ever seen it.

The two halves compound: the gate insists on a token, the page prints the
token, and the only way out an owner has is to type the number — the exact
thing the gate forbids. An owner following the rules correctly produced a
broken homepage.

**The fix is structural, not additive.** "Call `fillTokens` at every use site"
was already the arrangement and was already forgotten five times out of six, so
the sixth call site is not a fix. Substitution now happens once in
`HomeSection`, before dispatch, recursively over the whole section including
nested payload strings — renderers that do not exist yet get it for free, and
`tokens` is a required prop so the type checker asks the question a reviewer
kept not asking.

`audit:homepage-tokens` (new) builds one section of **every renderable type**,
each carrying a token in every string field that type displays, and reads the
*served page* — `audit:literals` reads the database and cannot tell a token
that works from one that renders as itself. Proven to fail: 11/4 on the old
renderer, naming 27 leaked tokens; 16/0 on the fix. A per-run nonce makes a
stale cache a loud failure rather than a silent grade of somebody else's
homepage — added after this gate's own first version passed while asserting
against rows it had not written.

Also in C2: `rich_text` had been in the enum since the first migration with no
renderer; it has one now, reusing `pages.body`'s prose conventions through an
extracted `ProseBlocks` (`components/storefront/prose.tsx`) so there is one
dialect of owner-typed text and still no HTML path from the database into the
page. The seed gained a `rich_text` section so the perceptual gates actually
render it.

---

## C1 · /admin/appearance

**Files.** `src/lib/content/section-payload.ts` (one Zod schema per type,
imported by both the form and the publish action so they cannot disagree),
`src/lib/queries/admin/appearance.ts`, `src/lib/actions/admin/appearance.tsx`,
`src/app/admin/appearance/page.tsx`,
`src/components/admin/appearance/appearance-editor.tsx`, a nav entry, and
`scripts/audit/appearance.ts`.

**Nothing writes until Publish.** Every control edits a working copy; Publish
sends the whole layout in one submission; closing the tab discards everything.
That is what makes Delete one click — the destructive step is Publish, and a
red line above it names exactly what will be removed. Publish computes
removals against the *table*, not against what the editor believed, so two
racing tabs end with one coherent layout.

**Reorder is buttons first, drag second.** WCAG 2.2 SC 2.5.7 requires a
single-pointer alternative to dragging and this panel runs axe at 2.2 AA; the
arrows are also what a keyboard user gets. Drag is native HTML5 — no new
dependency for a list of seven rows. The drag handle is deliberately not
driven by the gate: headless HTML5 drag proves the simulation, not the
control; the arrows drive the identical `move()`.

**Preview is the real renderer.** `previewHomepage` returns the actual
`<HomeSection>` elements across the action boundary, tokens resolved by the
same `contentTokens()` the homepage uses. There is no second renderer to
drift. The gate proves it renders the *unpublished* layout while the database
row and the live page provably do not change.

**Validation fails with a name.** Each section's payload is vetted against its
type's schema on the client (so the failure lands next to the field, section
opened) and again in the action. A type without a schema — `testimonials` —
can pass through a publish only if the row already exists: the editor cannot
create what it cannot edit, but a hand-made row must survive a publish
untouched.

**The hero owns its imagery now.** Its copy lived in the section payload while
its images came from a separate `banners` row — "edit the hero" was two rows
in two tables. The payload takes image URLs, wholesale-or-nothing (a payload
desktop image with the banner's mobile crop would be two unrelated photographs
presented as an art-directed pair), and the banner remains the fallback so
every existing homepage renders unchanged. No migration: `payload` was always
jsonb.

**Not one transaction, said plainly.** Publish is three statements (update,
insert, delete). A mid-way failure leaves a partial publish; the alternative
was an RPC, which is a production migration this batch deliberately avoids.
Every statement is repeatable and "press Publish again" fully repairs any
partial state. Order: updates, inserts, deletes — a late failure leaves extra
sections rather than a hole where the hero was.

---

## C3 · The announcement, scheduled

There was **no admin control at all** for the strip — it rendered from a row
only SQL could edit, and the admin guide said "ask your developer".

Now at Settings → The announcement bar: the words (with the token rule in the
hint), the link, the master switch, and a start and end. Times are edited as
IST wall clock and stored pinned to `+05:30` — a naive string would mean a
different moment on every machine that read it, and the round-trip assertion
in the gate checks the offset specifically. Cleared dates store as null:
empty is "no window", not the epoch. `ends > starts` is refused at save.
Malformed dates fail *open* (the strip shows): a wrongly visible strip is
reported within the hour; a strip silently withheld by a typo is not.

The dismissal key stays hashed from the **raw** text, so a scheduled window
reopening does not resurrect a strip a customer already closed — same words,
same key — while any edit to the words shows the new strip to everyone. That
property is why scheduling lives in the row rather than as a cron flipping
`is_active`.

No migration: the window fields ride in the existing `announcement` jsonb.

---

## What the production build caught that dev could not

This is the section worth reading twice.

**1 · A gate that cannot fail is not a gate, and dev made this one unfailable.**
With `updateTag`/`revalidatePath` deliberately deleted from the publish action,
`audit:appearance` against `next dev` stayed **18/0** — dev re-renders per
request, so a missing cache-bust is invisible. Against a production build
(`build:stage` + `start:stage`) the same sabotage went **14/4**, failing on
exactly the live-page assertions: stale order, hidden section still served,
added section absent. Restored, the production build runs 18/0. The gate now
documents that a production build is its meaningful environment, and the
stale-publish failure mode — the owner's "my edit did nothing", for up to an
hour, in production only — is the thing it guards.

**2 · The preview worked in dev and threw in production.** The returned tree
references client components (`Rail`, `ProductImage`, `SaveForLater`), and a
production build resolves those against the **admin route's** client manifest,
which is built from the route's import graph — the bundler does not trace what
an action returns. Dev holds one manifest for everything, so dev lied. Error,
verbatim: *"Could not find the module …rail.tsx#Rail in the React Client
Manifest."* A pure re-export "manifest" module was tried first and was
tree-shaken out. The fix is a real feature with a structural duty: the
appearance page renders the **live homepage** below the editor ("Live now"),
which registers every client leaf the sections use through a render path that
cannot be shaken, self-maintainingly. A failed preview is now also a sentence
(toast) rather than a button that does nothing — the rejection happens while
serializing the *response*, after the action body returned ok, so the action's
own catch never sees it.

**3 · My gate blamed the strip for the schema being right.** The scheduling
check set the start to 2030 while the form still held a 2027 end; the save was
correctly refused by `ends > starts` and the "strip still visible" red looked
like a scheduling bug. The block now moves both dates and asserts storage
before judging the page, so a refused save is named as a refused save.

---

## Verification

All UI gates against the **production build** except where marked; staging
data; typecheck and full lint run as the literally last thing before commit.

| Gate | Result |
|---|---|
| `audit:appearance` (new) | **18/0** on the production build; **14/4** with revalidation sabotaged — proven to fail where the failure exists |
| `audit:settings-controls` | **51/0**, now 39 controls including the five announcement controls, the pinned-offset round trip, and the strip appearing/disappearing live by schedule |
| `audit:admin-pages` | **66/0**, `/admin/appearance` rendering, tablet-clean and axe-clean |
| `audit:homepage-tokens` (new, dev-only by design — its direct inserts bypass `updateTag`) | **16/0**; 11/4 on the pre-C2 renderer |
| `audit:literals` | green |
| `audit:a11y` | clean, 22 routes / 15 states, both widths (C2 run) |
| `audit:reachability` | PASS, both widths |
| `tsc --noEmit` · `eslint .` | clean — exit codes read directly, see below |

### What I got wrong and caught

- **Two probes read the wrong exit code.** `npm run lint 2>&1 | tail` reports
  `tail`'s exit, and I printed "BATTERY CLEAN" over 2 real errors once, and
  "tsc exit=0" over a real type error once. Both re-run reading the command's
  own code. The same shape as every vacuous pass this project has recorded:
  a check that cannot say no.
- **The project's own `no-unchecked-supabase-error` rule caught me five times**
  across the two new gates — dropped errors whose failure would have rendered
  as "no rows" and made the surrounding assertion vacuous.
- **`istWallClock` exported from a `"use client"` module and called on the
  server page** — a client reference is not a callable function. The whole
  settings page failed to render, and `audit:settings-controls` reported it as
  eight missing labels plus a dead save button: the suite catching a real
  regression of mine within minutes of it existing. Moved to
  `src/lib/announcement.ts`.
- **Visible button labels carrying full section titles** overflowed a 768px
  tablet — caught by `audit:admin-pages`. Short visible text; the full name
  stays in `aria-label`, so gate location by accessible name is unchanged.
- **An axe flake from a lingering toast**: section 6's scan once caught the
  publish toast's exit animation as a contrast violation no standalone scan
  could reproduce. The gate now waits out the toast; a gate that reddens on an
  animation teaches people to re-run gates until they pass.

## Known imperfections

- **Publish is not atomic** (three statements; see C1). Repeatable, named, and
  accepted against the cost of a production migration.
- **`audit:homepage-tokens` is dev-only.** Its fixtures are direct inserts, so
  nothing busts the cache and its nonce check would fail loudly against a
  production build. The production-build coverage of the same surface is
  `audit:appearance`, whose fixtures go through Publish.
- **The "Live now" panel is a load-bearing render** (the preview's client
  manifest depends on it). Removing it breaks Preview in production builds
  only. It is commented at the render site, in `docs/architecture.md`, and
  `audit:appearance` on a production build is the enforcement.
- **Hero image URLs are pasted, not picked.** A media-library picker is real
  scope deferred; the hint says to paste from Media. A URL from a host
  `next/image` does not allow will fail at render, not at save.
- **`category_grid` slugs and `product_rail` collections are validated by
  shape, not existence.** A slug deleted later leaves a tile-less grid — the
  renderer already handles that by drawing nothing.

## Deferred

- **C4 · hero video** — owner's ordering: photography first. Blocked on a
  `site-video` bucket (production DDL, owner-applied). The section payload and
  renderer split make it a contained addition when it comes.
- Per-shipment pickup selection — unchanged from Batch B, trigger unchanged.

---

## In production

*Appended after the merge below was deployed and verified.*
