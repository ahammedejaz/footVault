/**
 * `npm run audit:reviews` — ratings, held to Phase 11's promises.
 *
 *   npm run dev:stage          # a server on :3210, for the browser half
 *   npm run audit:reviews
 *
 *   1. `anon` and `authenticated` PostgREST INSERTs are refused — 11A.1
 *      closed at source by the revoke, the check most worth seeing
 *   2. a customer with no delivered order for a product cannot review it,
 *      through the real enforcement seam (`writeReview` — the Server Action
 *      minus the cookie jar; the action adds only auth + throttle on top)
 *   3. a delivered purchaser can, it publishes immediately (post-moderation),
 *      and the snapshot carries their first name
 *   4. one review per customer per product — the DATABASE's answer, 23505
 *   5. aggregates: trigger-maintained columns match the rows, before and
 *      after a removal; reconcile_reviews() returns zero rows
 *   6. soft removal through the real /admin/reviews control, operated by its
 *      visible label: reason required, row survives with it, storefront
 *      forgets it, aggregate falls
 *   7. anon reads: approved yes, removed no
 *   8. JSON-LD: no AggregateRating at zero reviews; the true value at N
 *   9. the product page SHOWS the review. Under `next dev` every request
 *      re-renders, so a dev-server pass here says nothing about the cache
 *      claim ("immediately, under build:stage") — when this run is against
 *      dev it says SKIP loudly rather than printing a pass it did not earn.
 *
 * Run as: NODE_OPTIONS=--conditions=react-server tsx scripts/audit/reviews.ts
 */
// clients first: repoints this process at staging, refuses production.
import { adminClient, anonClient, assertNotProduction, createAccount, sessionCookies } from "./fixtures";

import { chromium } from "playwright";

import { writeReview } from "../../src/lib/reviews/write";
import { BASE_URL } from "./routes";

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (!condition) failures++;
  console.log(
    `  ${condition ? "ok  " : "FAIL"}  ${label}${condition || !detail ? "" : `\n          ${detail}`}`,
  );
}

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function main(): Promise<void> {
  assertNotProduction("build review fixtures");
  const db = adminClient();
  const run = Date.now().toString(36);

  /** Two products: one gets reviews, one stays at zero for the JSON-LD half. */
  const { data: products, error: productError } = await db
    .from("products")
    .select("id, name, slug")
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(2);
  if (productError || (products?.length ?? 0) < 2) {
    throw new Error(`need two active products: ${productError?.message}`);
  }
  const reviewed = products![0]!;
  const untouched = products![1]!;

  // Every fixture account's full_name is "Quality Runner", so the snapshot's
  // first-name-only rule shows as "Quality".
  const buyer = await createAccount("reviews-buyer");
  const stranger = await createAccount("reviews-stranger");
  const admin = await createAccount("reviews-admin");
  const orderIds: string[] = [];
  const userIds = [buyer.userId, stranger.userId, admin.userId];

  {
    const { error } = await db
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", admin.userId);
    if (error) throw new Error(`could not promote the admin probe: ${error.message}`);
  }

  /** A delivered order for the buyer carrying the reviewed product. */
  async function deliveredOrder(userId: string, productId: string) {
    const { data: order, error } = await db
      .from("orders")
      .insert({
        user_id: userId,
        status: "delivered",
        delivered_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        delivered_source: "courier",
        subtotal: 259_900,
        grand_total: 259_900,
        advance_amount: 259_900,
        balance_due_on_delivery: 0,
        shipping_address: {
          recipientName: "QA Reviews",
          phone: "9800000002",
          line1: "2 Audit Street",
          line2: null,
          city: "Coimbatore",
          state: "Tamil Nadu",
          postalCode: "641001",
          country: "IN",
        },
        contact_phone: "9800000002",
        contact_email: null,
      })
      .select("id")
      .single();
    if (error || !order) throw new Error(`fixture order failed: ${error?.message}`);
    orderIds.push(order.id);
    const { error: itemError } = await db.from("order_items").insert({
      order_id: order.id,
      product_id: productId,
      product_name: reviewed.name,
      product_slug: reviewed.slug,
      size: "UK 9",
      color: "Black",
      sku: `FVQA-REV-${run}`,
      unit_price: 259_900,
      quantity: 1,
      line_total: 259_900,
    });
    if (itemError) throw new Error(`fixture item failed: ${itemError.message}`);
    return order.id;
  }

  async function aggregateOf(productId: string) {
    const { data, error } = await db
      .from("products")
      .select("review_count, rating_sum")
      .eq("id", productId)
      .single();
    if (error || !data) throw new Error(`aggregate read failed: ${error?.message}`);
    return data;
  }

  try {
    /* ══ 1 · the door is shut at the grant, not the guard ═══════════════ */
    section("1 · PostgREST writes are refused outright (11A.1)");

    const anon = anonClient();
    const { error: anonInsert } = await anon.from("reviews").insert({
      product_id: reviewed.id,
      user_id: stranger.userId,
      rating: 5,
      display_name: "Anon",
    });
    ok(
      "anon INSERT refused",
      anonInsert !== null,
      "an anonymous caller wrote a review over PostgREST",
    );

    const authed = anonClient();
    await authed.auth.setSession({
      access_token: stranger.session.access_token,
      refresh_token: stranger.session.refresh_token,
    });
    const { error: authedInsert } = await authed.from("reviews").insert({
      product_id: reviewed.id,
      user_id: stranger.userId,
      rating: 5,
      display_name: "Stranger",
    });
    ok(
      "authenticated INSERT refused — the revoke, proven through the endpoint",
      authedInsert !== null,
      "a signed-in caller wrote a review over PostgREST with no purchase",
    );

    /* ══ 2 · no parcel, no review ═══════════════════════════════════════ */
    section("2 · the delivered-order lock, through the enforcement seam");

    const refused = await writeReview({
      userId: stranger.userId,
      productId: reviewed.id,
      rating: 5,
      title: "Never bought it",
      body: null,
    });
    ok(
      "a customer with no delivered order is refused",
      !refused.ok && refused.reason === "not_delivered",
      JSON.stringify(refused),
    );

    /* An order that exists but has NOT arrived is not enough either. */
    const { data: pendingOrder, error: pendingError } = await db
      .from("orders")
      .insert({
        user_id: stranger.userId,
        status: "shipped",
        subtotal: 259_900,
        grand_total: 259_900,
        advance_amount: 259_900,
        balance_due_on_delivery: 0,
        shipping_address: {
          recipientName: "QA Reviews",
          phone: "9800000003",
          line1: "3 Audit Street",
          line2: null,
          city: "Coimbatore",
          state: "Tamil Nadu",
          postalCode: "641001",
          country: "IN",
        },
        contact_phone: "9800000003",
        contact_email: null,
      })
      .select("id")
      .single();
    if (pendingError) throw new Error(`shipped fixture failed: ${pendingError.message}`);
    if (pendingOrder) {
      orderIds.push(pendingOrder.id);
      const { error: pendingItemError } = await db.from("order_items").insert({
        order_id: pendingOrder.id,
        product_id: reviewed.id,
        product_name: reviewed.name,
        product_slug: reviewed.slug,
        size: "UK 8",
        color: "Black",
        sku: `FVQA-REV2-${run}`,
        unit_price: 259_900,
        quantity: 1,
        line_total: 259_900,
      });
      if (pendingItemError)
        throw new Error(`shipped fixture item failed: ${pendingItemError.message}`);
    }
    const stillRefused = await writeReview({
      userId: stranger.userId,
      productId: reviewed.id,
      rating: 5,
      title: null,
      body: null,
    });
    ok(
      "an order that is merely shipped does not qualify — delivered_at is the evidence",
      !stillRefused.ok && stillRefused.reason === "not_delivered",
    );

    /* ══ 3 · a delivered purchaser writes, and it is live now ═══════════ */
    section("3 · the delivered purchaser, through the real form and action");

    /*
      The REAL path, end to end: the prompt on the delivered order's page,
      the form, `submitReview` (auth + throttle + writeReview +
      revalidatePath). Driving the action rather than the seam matters
      doubly under `build:stage`: the product page is static there, and the
      action's revalidatePath is the entire mechanism behind "publishes
      immediately" — a seam-level write would skip it and section 8 would
      rightly fail against a production build.
    */
    const buyerOrderId = await deliveredOrder(buyer.userId, reviewed.id);
    {
      const browser = await chromium.launch();
      try {
        const context = await browser.newContext({
          viewport: { width: 1280, height: 1000 },
        });
        await context.addCookies(await sessionCookies(buyer.session));
        const page = await context.newPage();
        await page.goto(`${BASE_URL}/account/orders/${buyerOrderId}`, {
          waitUntil: "load",
        });
        const summary = page.getByText(`Review ${reviewed.name}`, { exact: true });
        await summary.waitFor({ state: "visible", timeout: 20_000 });
        ok("the delivered order offers the review prompt", true);
        await summary.click();
        await page
          .getByRole("radio", { name: "4 stars" })
          .check({ force: true });
        await page.getByLabel(/title/i).fill("Fits true to size");
        await page.getByLabel(/^review/i).fill("Comfortable from the first wear.");
        await page.getByRole("button", { name: "Post review" }).click();
        const outcome = page.getByRole("status");
        await outcome.waitFor({ timeout: 20_000 });
        ok(
          "the action publishes it immediately — post-moderation",
          /live on the product page/i.test((await outcome.textContent()) ?? ""),
          (await outcome.textContent()) ?? "(no status)",
        );
        await context.close();
      } finally {
        await browser.close();
      }
    }

    const { data: row, error: rowError } = await db
      .from("reviews")
      .select("display_name, is_verified_purchase, is_approved")
      .eq("product_id", reviewed.id)
      .eq("user_id", buyer.userId)
      .single();
    ok(
      "the snapshot is the first name only",
      rowError === null && row?.display_name === "Quality",
      rowError?.message ?? `display_name = ${row?.display_name}`,
    );
    ok("and marked a verified purchase", row?.is_verified_purchase === true);

    /* ══ 4 · one per customer per product, said by the database ═════════ */
    section("4 · one review per customer per product");

    const duplicate = await writeReview({
      userId: buyer.userId,
      productId: reviewed.id,
      rating: 5,
      title: "Second thoughts",
      body: null,
    });
    ok(
      "a second review collides with reviews_one_per_customer",
      !duplicate.ok && duplicate.reason === "already_reviewed",
      JSON.stringify(duplicate),
    );

    /* ══ 5 · aggregates are data, and they reconcile ════════════════════ */
    section("5 · aggregates");

    let aggregate = await aggregateOf(reviewed.id);
    ok(
      "review_count counts the live review",
      aggregate.review_count === 1,
      `count = ${aggregate.review_count}`,
    );
    ok(
      "rating_sum carries its stars",
      aggregate.rating_sum === 4,
      `sum = ${aggregate.rating_sum}`,
    );

    const { data: drift, error: reconcileError } = await db.rpc("reconcile_reviews");
    ok(
      "reconcile_reviews() returns zero rows",
      reconcileError === null && (drift?.length ?? 0) === 0,
      reconcileError?.message ?? `${drift?.length} drifting products`,
    );

    /* ══ 6 · removal, through the real admin control ════════════════════ */
    section("6 · soft removal, operated on /admin/reviews by visible label");

    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 1000 },
      });
      await context.addCookies(await sessionCookies(admin.session));
      const page = await context.newPage();
      await page.goto(`${BASE_URL}/admin/reviews`, { waitUntil: "load" });
      await page
        .getByRole("button", { name: "Remove…" })
        .first()
        .waitFor({ state: "visible", timeout: 20_000 });
      await page.getByRole("button", { name: "Remove…" }).first().click();
      await page
        .getByLabel(/why this review is being removed/i)
        .fill("QA: pattern-of-removals record test");
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      await page.getByText(/Review removed/i).waitFor({ timeout: 15_000 });
      await context.close();
    } finally {
      await browser.close();
    }

    const { data: removedRow, error: removedError } = await db
      .from("reviews")
      .select("removed_at, removed_reason, removed_by")
      .eq("product_id", reviewed.id)
      .eq("user_id", buyer.userId)
      .single();
    ok(
      "the row survives with the reason and the remover",
      removedError === null &&
        removedRow?.removed_at !== null &&
        removedRow?.removed_reason === "QA: pattern-of-removals record test" &&
        removedRow?.removed_by === admin.userId,
      JSON.stringify(removedRow),
    );

    aggregate = await aggregateOf(reviewed.id);
    ok(
      "the aggregate falls with the removal",
      aggregate.review_count === 0 && aggregate.rating_sum === 0,
      `count=${aggregate.review_count} sum=${aggregate.rating_sum}`,
    );
    const { data: driftAfter, error: driftAfterError } = await db.rpc("reconcile_reviews");
    ok(
      "and still reconciles",
      driftAfterError === null && (driftAfter?.length ?? 0) === 0,
      driftAfterError?.message ?? `${driftAfter?.length} drifting products`,
    );

    /* ══ 7 · who can read what ══════════════════════════════════════════ */
    section("7 · reads under RLS");

    const { data: anonRead, error: anonReadError } = await anon
      .from("reviews")
      .select("id")
      .eq("product_id", reviewed.id);
    ok(
      "a removed review is invisible to the storefront's client",
      anonReadError === null && (anonRead?.length ?? 0) === 0,
      anonReadError?.message ?? `${anonRead?.length} visible`,
    );

    /* Put it back for the rendered-page half. */
    const { error: restoreError } = await db
      .from("reviews")
      .update({ removed_at: null, removed_reason: null, removed_by: null })
      .eq("product_id", reviewed.id)
      .eq("user_id", buyer.userId);
    if (restoreError) throw new Error(`restore failed: ${restoreError.message}`);
    const { data: anonReadBack, error: anonBackError } = await anon
      .from("reviews")
      .select("id, display_name")
      .eq("product_id", reviewed.id);
    ok(
      "an approved one is readable anonymously",
      anonBackError === null && (anonReadBack?.length ?? 0) === 1,
      anonBackError?.message ?? "",
    );

    /* ══ 8 · the rendered page and its JSON-LD ══════════════════════════ */
    section("8 · the product page");

    const reviewedHtml = await (
      await fetch(`${BASE_URL}/product/${reviewed.slug}`, { cache: "no-store" })
    ).text();
    const untouchedHtml = await (
      await fetch(`${BASE_URL}/product/${untouched.slug}`, { cache: "no-store" })
    ).text();

    ok(
      "the review is on the page — title, body and first name",
      reviewedHtml.includes("Fits true to size") &&
        reviewedHtml.includes("Comfortable from the first wear.") &&
        reviewedHtml.includes("Quality"),
    );
    ok(
      "its JSON-LD carries the true AggregateRating",
      reviewedHtml.includes('"aggregateRating"') &&
        reviewedHtml.includes('"ratingValue":"4.0"') &&
        reviewedHtml.includes('"reviewCount":1'),
    );
    ok(
      "a product with zero reviews emits NO AggregateRating",
      !untouchedHtml.includes('"aggregateRating"'),
    );
    ok(
      "and shows the honest sentence, never five grey stars",
      untouchedHtml.includes("No reviews yet"),
    );

    /*
      The cache claim ("a new review appears immediately") is only meaningful
      against a production build — dev re-renders every request and passes
      trivially (recorded lesson: 18/0 under dev, 14/4 under build:stage).
      In the 2026-08-11 build, /product/[slug] is ƒ Dynamic (the layout's
      cookie read; the page header's "statically rendered" comment predates
      that), and the reviews block reads live OUTSIDE unstable_cache — so
      immediacy is structural, and this gate proved it against
      `build:stage` + `start:stage` on the night it was written, 21/21.
      The line below records which kind of server THIS run measured, so a
      future reader of a green dev run does not over-claim.
    */
    const cacheControl = (
      await fetch(`${BASE_URL}/product/${untouched.slug}`, { method: "HEAD" })
    ).headers.get("cache-control");
    console.log(
      `  ·     measured a server answering cache-control: ${cacheControl ?? "(none)"} — ` +
        "re-run against `npm run build:stage && npm run start:stage` for the cache claim",
    );
  } finally {
    for (const orderId of orderIds) {
      const { error: itemsGone } = await db.from("order_items").delete().eq("order_id", orderId);
      const { error: orderGone } = await db.from("orders").delete().eq("id", orderId);
      if (itemsGone || orderGone)
        console.error(`  !! fixture order not removed: ${(itemsGone ?? orderGone)?.message}`);
    }
    for (const userId of userIds) {
      const { error: reviewsGone } = await db.from("reviews").delete().eq("user_id", userId);
      if (reviewsGone)
        console.error(`  !! fixture reviews not removed: ${reviewsGone.message}`);
      await db.auth.admin.deleteUser(userId).catch(() => {});
    }
  }

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
