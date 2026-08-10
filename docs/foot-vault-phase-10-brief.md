# Foot Vault — Phase 10 Brief (Batch E)

**The deferred work. Image pipeline first, homepage editor last.**

> Save as `docs/PHASE_10.md` and tell Claude Code: *"Read docs/PHASE_10.md and begin."*

---

## Where this sits

The shop works. It takes money, gives it back, ships parcels, emails at the right moments, reconciles its own stock and can be rebuilt from migrations. Batches A through D of the Phase 9 plan are complete and deployed.

Batch E is everything deferred every phase since the first brief. None of it affects whether an order can be taken, paid, shipped or refunded — which is exactly why it kept getting deferred, and why it's now the whole of this phase.

**The order matters.** The image pipeline goes first because real product photography is the single remaining blocker to opening the shop, and the pipeline is what makes those photos come out consistent. The homepage editor goes last because it's the largest piece and the only one nothing else depends on.

---

## Standing rules

**1. Execution report** per batch at `claudeExecutionReport/phase-10-<batch>.md`: what was built with file paths; every autonomous decision with a one-line rationale; every bug found, root cause not symptom; every measurement as an actual number; **what you got wrong and caught in self-review**; **known imperfections**, honestly listed; what was deferred; anything blocked on the owner with exact steps.

**2. Documentation stays current.** `README.md`, `.env.example`, `docs/architecture.md`, `docs/database.md`, `docs/admin-guide.md`, `docs/rls-tests.md`.

**3. Merge policy.** Merge without asking when every gate is green against staging with real numbers, and the change touches no money computation, payments, refunds, auth, RLS or admin authorisation, applies no production migration, and needs no dashboard change by the owner. Otherwise stop and ask. Every merge: snapshot first if a migration is involved, verify the Vercel deployment succeeded via the API rather than by inference, run the smoke check, and revert rather than forward-fix if anything fails.

**4. A blocked tool means stop and report.** Never switch tools to achieve the same effect. This binds subagents exactly as it binds the lead.

**5. At most two subagents.** One writer per file. Interfaces before implementations.

**6. Business numbers stay the owner's.** Build mechanisms unset and failing loudly rather than inventing a value.

**7. Every owner-facing control needs an operate-and-assert test** — something that finds the control on screen, changes it, and asserts the stored value moved. And every new customer-facing page must pass `audit:reachability`. Both of these exist because "built but unreachable" has now cost this project twice.

---

## Preflight — two items the Phase 9 plan listed and nobody picked up

They appear in the plan's findings table but were never assigned a batch number.

**P-1 · The ₹2,499 fallbacks.** Hardcoded at `product/[slug]/page.tsx:82` and `queries/cart.ts:96`, invisible to the literals gate. Remove both — fail loudly rather than falling back to a literal. Extend the literals gate to flag numeric `*_paise` literals anywhere in `src/` outside `lib/`, and prove the extended gate fails on today's tree before it passes. This threshold has escaped into the codebase three separate times; this is the sweep that should end it.

**P-2 · Document the deliberate rate-limit fail-open** in `docs/architecture.md`, including the `serviceability` exception and why it needed its own in-memory backstop. Without this, the next person reads a deliberate design choice as a bug and "fixes" it.

Confirm whether either is already done. If so, say where.

---

## Batch A — The image pipeline

**This is the one that matters most, because it is what stands between real photography and a catalogue that looks consistent.**

### Server-side normalisation

Accept any reasonable upload and produce a canonical asset with `sharp`:

- Fit into the card's aspect ratio with `contain`, padded with the card surface colour — never crop a shoe.
- Strip EXIF, correct orientation from EXIF before stripping it. A phone photo taken in portrait must not arrive sideways.
- Emit WebP at several widths for `next/image`, with the originals retained in Storage so a future reprocess is possible.
- Deterministic output: the same input produces the same asset, so a reprocess is idempotent.

### What the owner sees while uploading

- **Recommended: 2000 × 2000 px, square, product centred, plain light background.** Accepted: JPEG, PNG, WebP, up to 5 MB.
  *(Corrected from 10 MB during Batch A, on the owner's instruction. The bucket's own `file_size_limit` is 5 MB, and raising it is a storage migration; with client-side compression before upload a 2000 × 2000 photograph lands well under it, so the promise was changed to match what the bucket accepts rather than the reverse.)*
- A **live preview in the actual card frame**, so the owner sees exactly how it will look on the storefront before saving — not a generic thumbnail.
- A warning below 800px on either side.
- Client-side compression before upload, a progress bar, and a required alt-text field.
- Two shots per product: the three-quarter view and the outsole. The product page design leans on that second image; say so in the UI so it doesn't get skipped.

### Reprocessing

A way to re-run the pipeline over existing images, so the generated placeholders can be replaced in bulk when real photography arrives, and so a future change to the frame doesn't require re-uploading everything.

### Gates

Upload a deliberately awkward image — portrait, 4:3, EXIF-rotated, huge — and assert the stored asset is square, correctly oriented, within budget, and renders in the card without shifting layout.

---

## Batch B — Honest delivery estimates, and the smaller repairs

### Per-destination ETD

The site tells every customer "about 4 days." The real figures from the live serviceability response are Delhi 7, Hyderabad and Bangalore 4, Cuddapah local 3. The correct number is already in the response the shop fetches on every quote — it simply isn't shown.

- Show the real estimate on the checkout address step and the order confirmation, keyed to the customer's own PIN.
- Account for the 11:00 pickup cutoff. An order placed at 14:00 does not start its clock today, and the current copy already says "after dispatch" — make the date arithmetic match the words.
- When no live quote is available, say something honest and vague rather than a precise number that is wrong.
- On the product page, an estimate before a PIN is known is a guess. Either ask for a PIN or don't promise a number.

### Courier selection

The serviceability response carries `SLA_Adherence`, `rto_performance` and `tracking_performance` per courier per lane. On both lanes tested, Shiprocket's recommended courier scored worst on all three.

- Surface those scores in the admin at AWB assignment.
- Add a `courier_selection_mode` setting: cheapest, Shiprocket-recommended, or best-rated within a price tolerance. The tolerance is the owner's number — build it unset and failing loudly.
- Record which mode chose the courier, on the shipment, so the choice can be reviewed against what actually happened.

### Pickup addresses from the API

One address today (`warehouse`, PIN 516360), set in an environment variable. Fetch the list from `/v1/external/settings/company/pickup` and let the admin choose per shipment. **The pickup PIN determines the rate, so the location must be chosen before the quote is taken, not after** — if a second address is ever added in a different city, quoting from the wrong one means collecting the wrong amount.

### The focus-ring pass

The search bar renders its focus ring as a hard black box. Fix it as a focus-style pass across the whole site — if one input is wrong, others will be. **Keep focus visible and accessible**; the brass composite ring from Phase 0 is the pattern. Do not remove focus styling to make it look tidy.

---

## Batch C — The homepage editor

Promised in the very first brief — *"admin can edit his entire customer site from the admin panel"* — and deferred in every phase since. `homepage_sections` already exists and the homepage already renders from it, so the data model is done; this is the interface.

### `/admin/appearance`

- Add, reorder by drag, hide and delete sections.
- Section types: **hero** (separate mobile and desktop images), **category grid**, **product rail** (pick products or a collection), **banner**, **promo strip**, **rich text**.
- Announcement bar text and scheduling.
- **Preview before publish**, then publish and revalidate the affected paths.
- **Content-token support** — the same `{{free_shipping_threshold}}` mechanism used in the returns policy, so a number typed into homepage copy can never go stale. This is not optional: the ₹2,499 that escaped into the announcement strip is exactly what this prevents.

### The hero

The owner intends to replace the current hero (`/seed/hero-mobile.svg`, served through the Next image optimiser) with a generated 3D shoe-shuffling video, plus a caption about every size in every shoe.

So the hero section must support **video as well as image**: a poster frame for first paint so LCP doesn't regress, `muted`/`playsinline`/`autoplay` with a still fallback, `prefers-reduced-motion` honoured with the poster shown instead, and a hard budget on file size with a warning in the admin if an upload exceeds it. A hero video is the easiest way to undo the latency work that was just done — measure LCP before and after and report both.

### Gates

Reorder the homepage in the admin, publish, and assert the live page changed. Every control operate-and-asserted. `audit:reachability` green.

---

## Quality gates — every batch

- All gates against **staging**, with numbers: overflow, tap targets, six widths, axe (WCAG 2.2 A/AA).
- **Lighthouse against the live domain, not staging.** Staging reported 99 for weeks while production was crossing the planet twice per render. Production is the only real measurement for anything perceptual. Mobile ≥90 on `/`, `/shop`, a product page, `/cart`, `/checkout` — and note that the product page is currently 89, so it starts below the bar.
- `inventory_movements` reconciles to zero drift.
- No currency literal in code or in owner-editable content.
- Every owner-facing control operate-and-asserted; `audit:reachability` green.
- Staging rebuilds from migrations and seed, from empty, in one command.
- `no-unchecked-supabase-error`, the literals gate, the cached-shape gate, `audit:parcel` and `audit:transitions` all green.

---

## Not in this phase

Anything touching the money model, payments, refunds or the order lifecycle. Those are settled and proven; leave them alone unless something is broken.

---

## Done when

The owner can upload a crooked phone photo of a sandal and have it come out looking like the rest of the catalogue; a customer in Delhi is told seven days rather than four; the admin can see which courier actually delivers reliably before choosing one; and the owner can rearrange their own homepage — including dropping in a hero video — without asking anyone.
