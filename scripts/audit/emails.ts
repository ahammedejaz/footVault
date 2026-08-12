/**
 * The five order emails, and the rule that none of them may fail an order.
 *
 * Pure and fast: no browser, no database, no network. Everything asserted here
 * is a property of the builders and of the seam around them, and all of it is
 * the kind of thing that is invisible until a customer is reading the result.
 *
 * **Why a gate at all when nothing is delivered yet.** Because that is exactly
 * when this breaks. With the console adapter in play a malformed email prints
 * to a log nobody reads; the day a provider is connected, the first customer
 * finds it. Every check below fails on a defect that would otherwise surface as
 * a receipt whose arithmetic disagrees with itself, a tracking link ending in
 * "null", or a checkout that 500s because a mail server was slow.
 *
 * Section 8 is the P0 wiring rule: no email that reads as a confirmation may
 * be sendable from order *creation*. The behavioural half — a captured payment
 * emails exactly once — lives in scripts/audit/checkout-orders.ts, which runs
 * the real seam against staging.
 *
 *   npx tsx scripts/audit/emails.ts
 */
import { readFileSync } from "node:fs";

import {
  buildDeliveredEmail,
  buildOwnerNewOrderEmail,
  buildRefundedEmail,
  buildShippedEmail,
} from "../../src/lib/email/lifecycle";
import { buildOrderConfirmationEmail } from "../../src/lib/email/order-confirmation";
import type { EmailAdapter, EmailMessage } from "../../src/lib/email/types";

let passed = 0;
let failed = 0;

function ok(label: string, detail = "") {
  passed++;
  console.log(`  [32m✓[0m ${label}${detail ? ` — ${detail}` : ""}`);
}
function bad(label: string, detail: string) {
  failed++;
  console.log(`  [31m✗[0m ${label} — ${detail}`);
}
function check(label: string, condition: boolean, detail = "") {
  if (condition) ok(label, detail);
  else bad(label, detail || "assertion failed");
}

const ADDRESS = {
  recipientName: "Priya <Sharma>",
  phone: "9876543210",
  line1: "12 MG Road",
  line2: null,
  city: "Bengaluru",
  state: "Karnataka",
  postalCode: "560001",
  country: "IN" as const,
};

const LINES = [
  {
    productName: 'Air Max 90 "Infrared"',
    sku: "FV-NIKE-AM90-WHT-8",
    colour: "White / Grey",
    size: "8",
    quantity: 1,
    lineTotal: 974_600,
  },
];

const TOTALS = {
  subtotal: 974_600,
  discountTotal: 100_000,
  prepaidDiscount: 100_000,
  couponDiscount: 0,
  shippingFee: 13_000,
  forwardShippingFee: 13_000,
  codHandlingFee: 0,
  taxTotal: 0,
  grandTotal: 887_600,
  advanceAmount: 887_600,
  balanceDueOnDelivery: 0,
};

console.log("\nOrder emails\n");

/* ------------------------------------------------------------- 1 · shape -- */

console.log("[1m1 · every email has both parts and a real subject[0m");

const built: [string, EmailMessage][] = [
  [
    "order-confirmation",
    buildOrderConfirmationEmail({
      orderNumber: "FV-2026-00660",
      to: "a@b.c",
      customerName: ADDRESS.recipientName,
      paymentMethod: "razorpay",
      lines: LINES,
      totals: TOTALS,
      shippingAddress: ADDRESS,
    }),
  ],
  [
    "shipped",
    buildShippedEmail({
      orderNumber: "FV-2026-00660",
      to: "a@b.c",
      customerName: ADDRESS.recipientName,
      courierName: "Delhivery",
      trackingNumber: "AWB123456",
      trackingUrl: "https://shiprocket.co/tracking/AWB123456",
      balanceDueOnDelivery: 0,
    }),
  ],
  [
    "delivered",
    buildDeliveredEmail({
      orderNumber: "FV-2026-00660",
      to: "a@b.c",
      customerName: ADDRESS.recipientName,
    }),
  ],
  [
    "refunded",
    buildRefundedEmail({
      orderNumber: "FV-2026-00660",
      to: "a@b.c",
      customerName: ADDRESS.recipientName,
      amountPaise: 887_600,
      isFull: true,
    }),
  ],
  [
    "owner-new-order",
    buildOwnerNewOrderEmail({
      orderNumber: "FV-2026-00660",
      to: "owner@shop",
      placedAt: "2026-08-09T18:00:00.000Z",
      paymentMethod: "cod",
      lines: LINES,
      shippingAddress: ADDRESS,
      grandTotal: 887_600,
      advanceAmount: 28_100,
      balanceDueOnDelivery: 859_500,
      contactPhone: "9876543210",
      contactEmail: "a@b.c",
    }),
  ],
];

for (const [name, message] of built) {
  check(
    `${name}: text, html and subject are all non-empty`,
    message.text.trim().length > 20 &&
      message.html.trim().length > 20 &&
      message.subject.trim().length > 5,
  );
  check(
    `${name}: names the order number`,
    message.text.includes("FV-2026-00660") &&
      message.html.includes("FV-2026-00660"),
  );
}

/* ------------------------------------------------------- 2 · reply-to -- */

console.log(
  "\n\u001b[1m3 \u00b7 every email can be replied to by a human\u001b[0m",
);

/*
 * There is no mailbox at footvault.in. The domain accepts mail — Resend
 * Inbound is enabled on it — but that mail lands in a dashboard, so a customer
 * who hits reply on any of these is writing to nobody, and nothing about it
 * looks like a failure: the send succeeded, the delivery succeeded, and the
 * reply is gone.
 *
 * Checked over `built`, which is every builder in the module, so a seventh
 * template added next month fails here rather than shipping without it. That
 * is the whole reason this is a gate and not a code review comment.
 *
 * The window makes it concrete: damage has to be claimed within 24 hours of
 * delivery, and the delivered notice is the email the customer is holding when
 * they open the box.
 */
for (const [name, message] of built) {
  check(
    `${name}: sets a reply-to`,
    Boolean(message.replyTo),
    message.replyTo ?? "unset — a reply to this email reaches nobody",
  );
  /*
    This assertion used to be "not an @footvault.in address", and it was right
    at the time: nothing accepted mail there, so a reply to the domain went
    nowhere. That changed when `/api/email/inbound` was proven to forward, and
    the reply-to moved onto the shop's own domain — so the check has to move
    with the fact rather than outlive it.

    What still has to hold is that a reply does not come back to the address
    the mail was *sent* from. `orders@` is the sender; a customer replying to
    it would be answered by the same machinery that wrote to them, and the
    thread would have no human in it.
  */
  check(
    `${name}: a reply does not return to the sending address`,
    Boolean(message.replyTo) && !message.replyTo!.startsWith("orders@"),
    message.replyTo ?? "unset",
  );
}

const replyTos = new Set(built.map(([, m]) => m.replyTo ?? "unset"));
check(
  "all five agree on one reply-to",
  replyTos.size === 1,
  [...replyTos].join(", "),
);

/* ------------------------------------------------------------ 2b · logo -- */

console.log("\n[1m2b · every email carries the shop's logo[0m");

/*
 * The flattened-on-white variant, by absolute URL — an email has no origin,
 * and mail clients put unpredictable colours behind transparency. Checked over
 * `built` for the same reason as the reply-to: a seventh template fails here
 * rather than shipping bare.
 */
for (const [name, message] of built) {
  check(
    `${name}: the HTML part shows /brand/logo-email.png with alt text`,
    message.html.includes("/brand/logo-email.png") &&
      message.html.includes('alt="Foot Vault"'),
  );
}

/* -------------------------------------------------------- 3 · escaping -- */

console.log(
  "\n[1m3 · anything a customer typed is escaped in the HTML part[0m",
);

/*
 * The recipient name and the product name both carry characters that are markup
 * if they are not escaped. A shop that lets a customer name themselves and a
 * catalogue that contains a quotation mark are both ordinary; an email that
 * renders either as a tag is not.
 */
for (const [name, message] of built) {
  const raw = message.html.includes("Priya <Sharma>");
  check(`${name}: the raw "<Sharma>" is not in the HTML`, !raw);
}
const confirmation = built[0]![1];
check(
  "order-confirmation: the escaped form is present instead",
  confirmation.html.includes("Priya &lt;Sharma&gt;"),
);
check(
  'order-confirmation: a product name containing " is escaped',
  confirmation.html.includes("&quot;Infrared&quot;"),
);

/* --------------------------------------------------- 4 · the arithmetic -- */

console.log(
  "\n[1m4 · the confirmation's own lines sum to the total it prints[0m",
);

/*
 * The 9E defect from the other side. A receipt whose lines do not add up is the
 * fastest way to make a customer distrust a shop, and it is the kind of thing
 * they screenshot.
 */
const sum =
  TOTALS.subtotal -
  TOTALS.discountTotal +
  TOTALS.shippingFee +
  TOTALS.taxTotal;
check(
  "subtotal − discount + delivery = grand total",
  sum === TOTALS.grandTotal,
  `${sum} vs ${TOTALS.grandTotal}`,
);
check(
  "the discount is drawn as its own line when there is one",
  confirmation.text.includes("Paying online"),
);
/*
 * **Every money line reads its own field — proven with parts that cannot alias.**
 *
 * A subtraction bug survives any fixture where two parts happen to be equal or
 * zero, and `discountTotal = coupon + prepaid` holds on every real order, so a
 * derived coupon line is *numerically correct* right up until a third discount
 * part exists. This fixture is that future: `discountTotal` carries ₹300 that
 * belongs to neither the coupon nor the prepaid line (the shape a coin
 * settlement would have had under the discount model — the exact 11C.2 hazard).
 * The old `discountTotal − prepaidDiscount` derivation would print the coupon
 * as ₹700; the field says ₹400. Every other line is distinct and non-zero too,
 * so a swap or a re-derivation of any of them has nowhere to hide.
 */
const distinct = buildOrderConfirmationEmail({
  orderNumber: "FV-2026-00699",
  to: "a@b.c",
  customerName: "Ada",
  paymentMethod: "cod",
  lines: LINES,
  couponCode: "SAVE400",
  totals: {
    subtotal: 974_600,
    discountTotal: 130_000,
    prepaidDiscount: 60_000,
    couponDiscount: 40_000,
    shippingFee: 16_000,
    forwardShippingFee: 11_000,
    codHandlingFee: 5_000,
    taxTotal: 0,
    grandTotal: 860_600,
    advanceAmount: 30_000,
    balanceDueOnDelivery: 830_600,
  },
  shippingAddress: ADDRESS,
});
for (const [line, value] of [
  ["Subtotal", "₹9,746"],
  ["Paying online", "−₹600"],
  ["Coupon SAVE400", "−₹400"],
  ["Shipping", "₹110"],
  ["Pay-on-delivery fee", "₹50"],
  ["Order total", "₹8,606"],
  ["Paid now", "₹300"],
  ["To pay on delivery", "₹8,306"],
] as const) {
  const row = distinct.text
    .split("\n")
    .find((textLine) => textLine.trimStart().startsWith(line));
  check(
    `"${line}" prints its own field's value ${value}`,
    row !== undefined && row.includes(value),
    row ?? "(line absent)",
  );
}
check(
  "no line prints the ₹700 the old subtraction would have derived",
  !distinct.text.includes("₹700") && !distinct.html.includes("₹700"),
);

const noDiscount = buildOrderConfirmationEmail({
  orderNumber: "FV-2026-00661",
  to: "a@b.c",
  customerName: "Ada",
  paymentMethod: "razorpay",
  lines: LINES,
  totals: { ...TOTALS, discountTotal: 0, prepaidDiscount: 0, grandTotal: 987_600 },
  shippingAddress: ADDRESS,
});
check(
  "and is absent entirely when there is not",
  !noDiscount.text.includes("Paying online"),
);

/* ------------------------------------------------- 5 · missing tracking -- */

console.log(
  "\n[1m5 · shipped survives having no tracking yet[0m",
);

/*
 * An AWB is assigned by a different Shiprocket call from the one that books the
 * pickup, so a parcel can legitimately be `shipped` with nothing to track. The
 * failure this prevents is a link ending in the word "null", which reads to a
 * customer as the shop having lost the parcel.
 */
const untracked = buildShippedEmail({
  orderNumber: "FV-2026-00662",
  to: "a@b.c",
  customerName: "Ada",
  courierName: null,
  trackingNumber: null,
  trackingUrl: null,
  balanceDueOnDelivery: 0,
});
check(
  "no 'null' anywhere in the text part",
  !/\bnull\b/i.test(untracked.text),
  untracked.text.match(/\bnull\b/i)?.[0] ?? "",
);
check(
  "no 'null' anywhere in the html part",
  !/\bnull\b/i.test(untracked.html),
);
check(
  "it still tells the customer the parcel is moving",
  /on its way/i.test(untracked.text),
);
check(
  "and says a tracking number is coming rather than inventing one",
  /tracking number usually appears/i.test(untracked.text),
);

/* ------------------------------------------------ 6 · what the courier collects -- */

console.log(
  "\n[1m6 · the owner's copy always states the cash figure[0m",
);

const ownerCod = built[4]![1];
check(
  "a Pay-on-Delivery order shouts the amount to collect",
  ownerCod.text.includes("COLLECT") && ownerCod.text.includes("8,595"),
  ownerCod.subject,
);
check("and it is in the subject line, for a phone", ownerCod.subject.includes("COLLECT"));

const ownerPrepaid = buildOwnerNewOrderEmail({
  orderNumber: "FV-2026-00663",
  to: "owner@shop",
  placedAt: "2026-08-09T18:00:00.000Z",
  paymentMethod: "razorpay",
  lines: LINES,
  shippingAddress: ADDRESS,
  grandTotal: 887_600,
  advanceAmount: 887_600,
  balanceDueOnDelivery: 0,
  contactPhone: "9876543210",
  contactEmail: null,
});
/*
 * Stated even when it is zero. An absent line reads as "I do not know", and the
 * owner packing a parcel has to be able to tell a prepaid order from one whose
 * cash figure failed to render.
 */
check(
  "a prepaid order says 'nothing to collect' rather than omitting the line",
  /nothing to collect/i.test(ownerPrepaid.text),
);
check(
  "the owner's copy carries size and SKU, which is what gets picked",
  ownerCod.text.includes("size 8") && ownerCod.text.includes("FV-NIKE-AM90-WHT-8"),
);
check(
  "and the delivery address",
  ownerCod.text.includes("12 MG Road") && ownerCod.text.includes("560001"),
);

/* ----------------------------------------------------- 7 · failing soft -- */

console.log("\n[1m7 · a broken provider never throws at the caller[0m");

/*
 * The rule the whole seam exists for. Asserted against the contract rather than
 * against the real module, because importing src/lib/email pulls in
 * `server-only` and a Supabase client this harness has no business creating.
 */
const throwing: EmailAdapter = {
  name: "throwing",
  isConfigured: () => true,
  async send() {
    throw new Error("socket hang up");
  },
};

async function dispatchLike(adapter: EmailAdapter, message: EmailMessage) {
  try {
    return await adapter.send(message);
  } catch (error) {
    return {
      ok: false as const,
      via: adapter.name,
      reason: error instanceof Error ? error.message : "unknown",
    };
  }
}

const refusing: EmailAdapter = {
  name: "refusing",
  isConfigured: () => true,
  async send() {
    return {
      ok: false,
      via: "refusing",
      reason: "HTTP 422 domain not verified",
    };
  },
};

async function failSoftChecks() {
  const verdict = await dispatchLike(throwing, confirmation);
  check(
    "a throwing adapter becomes a verdict, not an exception",
    verdict.ok === false && verdict.reason === "socket hang up",
  );

  const refused = await dispatchLike(refusing, confirmation);
  check(
    "a refusing adapter reports the provider's own reason",
    refused.ok === false && refused.reason.includes("domain not verified"),
  );
}

/* ----------------------------------------- 8 · nothing confirms unpaid -- */

console.log(
  "\n[1m8 · no confirmation email is reachable from order creation[0m",
);

/*
 * The P0 wiring rule, asserted against the source itself.
 *
 * A customer who closed the Razorpay modal was receiving "order confirmed",
 * and the owner a new-order alert, for an order the sweep then cancelled —
 * because both sends hung off `placeOrder` rather than off the webhook. The
 * fix moved them into `applyPaymentOutcome`, on the branch that moves a
 * pending order to confirmed. These checks make the old wiring unrepresentable
 * without failing a gate: the checkout action may not touch the email module
 * at all, and the two confirmation-flavoured senders may be called from
 * exactly one file — the payment seam.
 *
 * Source-text checks are blunt, and blunt is right here: any import of
 * `@/lib/email` in the checkout action is wrong *whatever* it is for, because
 * everything that module can say to a customer at that moment is premature.
 */
const checkoutSource = readFileSync("src/lib/actions/checkout.ts", "utf8");
check(
  "the checkout action does not import the email module",
  !checkoutSource.includes("@/lib/email"),
);
check(
  "the checkout action names no email sender",
  !/send(OrderConfirmation|OwnerNewOrder|PaymentCaptured|Shipped|Delivered|Refunded)/.test(
    checkoutSource,
  ),
);

const paymentStateSource = readFileSync(
  "src/lib/orders/payment-state.ts",
  "utf8",
);
check(
  "the payment seam is what sends the confirmation",
  paymentStateSource.includes("sendOrderConfirmation"),
);
check(
  "and the owner's new-order alert",
  paymentStateSource.includes("sendOwnerNewOrder"),
);
check(
  "and both are gated on the confirmed transition",
  /if \(settled\.customerNote\) \{\s*await notifyOrderConfirmed/.test(
    paymentStateSource,
  ),
);

/* ------------------------------------------------------------- summary -- */

failSoftChecks().then(() => {
  console.log(`\n\u001b[1m${passed} passed, ${failed} failed\u001b[0m\n`);
  if (failed > 0) process.exitCode = 1;
});
