# Admin panel: four owner reports, and what each one turned out to be

**2026-08-20** · branch `main`, uncommitted · staging `pblgpvcdappfpoxdascd` rebuilt and green
· production **untouched** — two migrations are waiting for you, see §7.

---

## The short version

| # | You said | What it actually was | State |
|---|---|---|---|
| 1 | No way to add/remove brands | The controls existed. On a phone they sat **728px off the right edge of a 390px screen** | Fixed + gated |
| 2 | Can't scroll on mobile, can't see all the options | The admin menu's list had **no scroll container at all**. Four sections were unreachable on a phone | Fixed + gated |
| 3 | Adding products is complex | The "Add a product" page rendered **all five panels**, not the three its own documentation claimed | Fixed |
| 4 | Delete products and orders permanently | No such control existed anywhere | Built + gated |
| 5 | Product image backdrop is greyish | `#eef1f5`, baked into the pixels at upload | Fixed for new uploads |

Everything below is measured. Where I quote a number, a gate produced it.

---

## 1 · The brands screen — the controls were there all along

**This is the finding I want you to read first**, because it explains three of
the five reports at once.

`/admin/brands` has had Add, Edit, show/hide and Delete since it was written.
The table is 46rem wide and scrolls sideways inside a 390px phone screen, and
the action column is the **last** one. Measured against the pre-fix build:

```
a brand's delete control is on screen — box 728,405 36×36 in 390×664
```

The button was 338px past the right edge of the screen. Present in the page,
reachable by swiping, and invisible to anyone who did not already know to swipe.
Your conclusion — that the feature was missing — was the only reasonable one to
draw.

**Fix:** the action column now pins to the right edge while the rest of the
table scrolls under it (`stickyEnd` in `src/components/admin/table.tsx`). Applied
to brands and products. The "Edit" label became a pencil icon to match the eye
and bin either side, which bought back half the column width — the brand name
*and* web address are now both readable on a phone.

### The second half: delete used to refuse almost always

`deleteBrand` refused any brand that a product pointed at, and said "switch it
off instead". In a real catalogue that is nearly every brand, so nearly every row
showed a sentence where a button should have been.

The refusal is now **overridable, not removed**. Deleting a brand in use tells
you exactly what it costs — *"3 products (and 1 removed) will be left with no
maker at all"* — and makes you type `delete`. The products keep their names,
prices, sizes and photographs; only the link is destroyed. Switching off is still
offered first, in the sentence.

---

## 2 · The mobile scroll bug — a one-line omission, four sections lost

The admin menu has 15 sections at two lines each. The desktop sidebar's `<nav>`
has had `overflow-y-auto` since it was written. **The mobile drawer's `<nav>` had
no overflow rule at all**, inside a sheet exactly one viewport tall, with Radix
locking `<body>` scroll while it is open.

Measured on the pre-fix build at 390×664:

```
the drawer's nav is a scroll container  — overflow-y: visible
the list is taller than the box         — 854px of list in 854px of box
the last section ("Health") on screen   — box 8,860 276×54 in 390×664
tapping it navigates to /admin/health   — the link could not be clicked, off-viewport
```

The Health link sat at y=860 in a 664px-tall screen. Media, Appearance, Settings
and Health were **not hard to reach on a phone — they were unreachable**, with no
gesture that could get to them.

It survived because the panel is developed on the desktop layout, where the rail
has always scrolled.

### The same bug in every dialog

`DialogContent` was `fixed`, vertically centred, with **no max-height and no
overflow**. Any dialog taller than the screen hung off both ends with nothing to
scroll. `CouponForm` had hand-patched `max-h-[90dvh] overflow-y-auto` onto its own
dialog months ago — one dialog out of nine. That fix now lives in the primitive
and the local copy is gone.

`100dvh` rather than `100vh`, because mobile browsers keep reporting the tall
viewport while the address bar is showing — which is what puts a confirm button
behind the browser chrome.

**One non-obvious detail worth recording:** the drawer fix needs `min-h-0`
alongside `flex-1 overflow-y-auto`. A flex child defaults to `min-height: auto`
and refuses to shrink below its content, so without it the nav still grows past
the sheet and the overflow rule never has an overflow to act on. It looks fixed
on a tall screen and stays broken on a phone.

---

## 3 · Adding a product

`/admin/products/new` describes itself as asking "only for what a product cannot
exist without". It was not true — it rendered the shared form, and the form
rendered all five panels: basics, price, **parcel size, search listing, publish
checkboxes**. Roughly twenty fields, of which three are required.

Now:

- **Creating** shows *the basics* and *the price*, then one sentence saying sizes
  and photographs come next and that nothing is visible to customers meanwhile.
- **Editing** shows everything, with *Parcel size* and *How it is found* collapsed
  behind a summary that states what happens if you never open them ("left alone,
  the shop's usual box is used — 1000g, 20 × 10 × 10 cm").

Nothing required is ever hidden behind a summary — a form that cannot be
submitted until you open something is worse than a long form.

### And the part that was not the form

Creating a product lands you on its edit page with three panels and no statement
of what is still missing. A shoe can have a name, a price, photographs, be
switched on, and still be unbuyable because it has no sizes.

The page now says so, verified on a real product:

> **4 things left before this can sell**
> **Add the sizes you have.** No sizes yet, so there is nothing for a customer to
> choose — a shoe with no sizes cannot be bought even when it is on the shop.
> · Put stock against a size · Add a photograph · Turn it on

It disappears entirely once everything is done, so it never becomes furniture.

---

## 4 · Permanent deletion

Two new database functions, both gated, both proven to refuse.

### `admin_purge_product(uuid)` — offered on **removed** products only

You already have a "Removed" filter on `/admin/products`; it was a drawer that
could only ever grow. It now has a bottom: **Delete for good**, typed
confirmation, reachable only from that filter.

Deliberately only there. Emptying a bin is a different act from throwing
something into it, and putting both on a live row would put the irreversible one
a mis-tap from the reversible one.

**Proven against staging:**

- the product, its sizes and its photographs are gone
- **every order line survives** with its own name, size, colour, unit price and
  line total intact — old invoices still read exactly as before
- only `order_items.product_id` is nulled

The real cost, stated plainly: those lines stop being *linked* to the product, so
a report grouping sales by product can no longer attribute them, and re-creating
a product with the same name will not re-adopt them. The dialog says this.

### `admin_delete_order(uuid)` — on the order page

Per your decision: unpaid, failed and cancelled orders can go; anything paid or
dispatched cannot. Four gates, checked in order:

1. `payment_status <> 'unpaid'` → refuses
2. any payment row not conclusively `failed` → refuses *(including `created` — a
   customer may be typing their card number; this is the same lesson as migration
   `20260809030000`)*
3. any refund row → refuses
4. shipped / delivered / returning / returned → refuses

**The part that would have leaked, and does not:** placing an order decrements
stock in the same transaction. Deleting such a row directly would strand that
decrement forever, and the shop would quietly believe it had fewer shoes than it
does. So the function **cancels through `cancel_order_with_restock` first**, then
deletes. Measured end-to-end:

```
placing the order took the pairs off the shelf   stock 10 → 7
the unpaid order deletes                          deleted
and the three pairs are back on the shelf         stock 7 → 10
```

The Vault Coins ledger cannot cascade and must not vanish — `delta` is the only
place a balance exists. Those rows are **unlinked, not deleted**, with the order
number appended to the note, so what the shop owes a customer never changes
silently.

Where deletion is refused you get a sentence naming the next move, not "cannot
delete" — e.g. *"A payment was started against this order and has not
conclusively failed… It will settle by itself once the payment check runs."*

---

## 5 · The image backdrop

The grey was `CARD_SURFACE = "#eef1f5"` in `src/lib/images/constants.ts`, burnt
into the padding of every processed image by `sharp.flatten()`.

It could not simply be set to white: it was pinned to `--fv-fog`, which also
drives `--muted`, `--secondary` and `--accent`. Changing that one value would
have flattened every card, band and input in the shop.

**So the two were split.** A new `--fv-photo: #ffffff` token now owns the
photograph well and nothing else; `--fv-fog` is unchanged at `#eef1f5`. Eight
photograph wells moved to the new `bg-photo` utility (product card, gallery and
its thumbnails, cart lines, wishlist, search results, checkout lines, account
orders, the admin contact sheet and image manager). Everything that is merely *a
surface* still uses fog.

Verified pixel-by-pixel across 6 awkward source shapes × 4 widths:

```
padded with the card surface — corner rgb(255,255,255)
```

### What happens to photographs already uploaded — you chose "new uploads only"

This costs nothing and needs no migration, and here is why. `pipeline.ts:309`
folds `CARD_SURFACE` into the content hash *before* the variant bytes, and that
hash **is** the storage path (`derived/v1/<hash>/shoe-1600.webp`). Changing the
colour re-derives every path, so uploads from now on write brand-new objects
while existing rows keep pointing at what they already have. No rewrite, no
window where a product has no image.

**The consequence, stated honestly:** photographs uploaded before today are still
padded in grey and now sit in white wells, so the two will not match until you
reprocess. That is one command whenever you want it:

```
npm run images:reprocess
```

It works from the untouched originals and writes new objects, so the old
catalogue keeps rendering throughout. I have not run it, because you asked for
new uploads only.

---

## 6 · Gates — including proof they catch the bug

Two new suites, registered in `package.json`.

**`npm run audit:admin-mobile`** — 13 checks. Drives a real browser at 390×664
and asks, for each control, *is this actually on the screen right now*, using
`boundingBox()` against the viewport rather than `isVisible()`. `isVisible()`
returns true for an element 900px below a scroll-locked fold, which is exactly
the state the drawer was in and exactly why no existing gate noticed.

I reverted all three fixes, rebuilt, and re-ran it. **It failed 7 of 13**, with
the measurements quoted in §1 and §2. Restored, rebuilt, re-ran: **13/13**. A gate
that passes on both the broken and the fixed build is worth nothing, so I checked.

**`npm run audit:permanent-delete`** — 17 checks. Proves the purge preserves order
lines, the restock actually happens, a paid order survives the attempt, and
neither function is callable anonymously.

**Existing suites re-run, all green:** `audit:images` (67), `audit:admin-pages`
(72), `audit:overflow` (9,626 elements across 6 widths incl. 360px and 390px),
`audit:a11y` (23 routes + 15 states, axe clean), `audit:image-upload` (31),
`audit:image-editor` (32), `audit:gallery`.

**Full CI battery green as the last action:** typecheck · lint · shapes · build ·
guard:use-server · guard:client-imports.

### Two things that went wrong, for the record

- My first version of the mobile gate used Playwright's `isMobile: true`. That
  turns on Chromium's mobile layout emulation, and the page laid out against an
  **850px** viewport inside a context declared as 664 — so clicks aimed at the
  last nav item landed three rows above it. An artefact of the harness, not the
  panel: `elementFromPoint` at the same coordinates returned the right link. The
  gate now uses `hasTouch` without `isMobile`.
- One `audit:image-editor` run reported 1 of 32 failed when I ran it in the same
  command as `audit:gallery`; run on its own it is 32/32 green. Two browser suites
  sharing fixtures in one shell. Worth knowing before you trust a batched run.

---

## 7 · What is waiting for you

**Production has not been touched.** Two migrations are applied to staging only:

```
supabase/migrations/20260820090000_admin_purge_product.sql
supabase/migrations/20260820090100_admin_delete_order.sql
```

Staging was rebuilt from empty first — all 118 migrations replay, seed and every
check green — so the set is proven to apply in order.

To put them on production, per `docs/admin-guide.md` §12 and the path that has
worked twice before:

1. snapshot production (`npx supabase db dump` over the session pooler, schema +
   `--data-only`, verified by content)
2. `npx supabase db push --db-url … --dry-run` — it must list **exactly** those
   two files and nothing else
3. push, then confirm both functions resolve through PostgREST and that anon is
   refused
4. only then deploy the code

I have deliberately not run this. It is a production schema change and it is
yours to authorise.

**Nothing else needs a deploy step.** The image change, the mobile fixes and the
form changes are all code.

---

## Screenshots

`screenshots/admin-mobile-drawer.png` — the menu scrolled to Health, with "View
the shop" pinned below it
`screenshots/admin-mobile-brands.png` — every row's show/hide, edit and delete on
a 390px phone
`screenshots/admin-mobile-new-product.png` — the shortened Add a product form
`screenshots/admin-mobile-product.png` — a product page
