/**
 * footvault/no-derived-money-line
 *
 * A rendered money figure reads a named field, or it does not render.
 * Arithmetic between money fields is banned in the layers that draw money —
 * `src/components/`, `src/lib/email/`, `src/app/`.
 *
 * The defect this encodes has now happened twice in this repository's history
 * and was caught a third time on the night this rule was written:
 *
 *  - Phase 8: `prepaidDiscount` was optional, read sites omitted it, and the
 *    checkout showed a discounted total beside a Discount row reading "—".
 *  - Phase 11 audit (11C.2): `totals.tsx` and `order-confirmation.ts` derived
 *    the coupon line as `discountTotal − prepaidDiscount`. Numerically correct
 *    while those were the only two parts — and the moment a third part existed
 *    (coins), both would have printed it under the coupon's label on the
 *    customer's receipt.
 *  - The same night: `src/app/admin/orders/[id]/page.tsx` turned out to be a
 *    third derivation site the audit's "two surfaces" missed, which is why
 *    `src/app/` is in scope and not just `src/components/`.
 *
 * A subtraction bug survives every test where two parts happen to be equal or
 * zero, and `discountTotal = coupon + prepaid` holds on every legal row — so
 * the derived line is *provably right* until the schema grows. That is what
 * makes it unfindable by testing and exactly right for a lint rule.
 *
 * Flagged — any `+` or `-` where either operand is a member read of a money
 * field, in scope:
 *   const otherDiscount = totals.discountTotal - totals.prepaidDiscount;
 *   const forwardLeg = order.shippingFee - order.codHandlingFee;
 *
 * Not flagged:
 *   - the same arithmetic in `src/lib/orders/`, `src/lib/queries/`,
 *     `src/lib/payments/` — computation and data-boundary layers, where money
 *     is *made*, not drawn. `computeOrderTotals` is the one place a total is
 *     computed; this rule keeps every other layer a reader.
 *   - comparisons, `>`/`<`/`===` — deciding whether to draw a row is not
 *     deriving its value.
 */

/** Every field that renders as a money line, present and planned. */
const MONEY_PROPS = new Set([
  "subtotal",
  "discountTotal",
  "prepaidDiscount",
  "couponDiscount",
  "shippingFee",
  "forwardShippingFee",
  "codHandlingFee",
  "taxTotal",
  "grandTotal",
  "advanceAmount",
  "balanceDueOnDelivery",
  "coinPaid",
  "coinSpent",
  "amountPaise",
  "lineTotal",
  "unitPrice",
  // snake_case twins, for raw rows that leak into a render layer
  "discount_total",
  "prepaid_discount",
  "coupon_discount",
  "shipping_fee",
  "cod_handling_fee",
  "grand_total",
  "advance_amount",
  "balance_due_on_delivery",
  "coin_paid",
]);

const SCOPE = /src[\\/](components|app)[\\/]|src[\\/]lib[\\/]email[\\/]/;

/** `totals.grandTotal`, `input.totals.grandTotal`, `order.shipping_fee` … */
function moneyMember(node) {
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier" &&
    MONEY_PROPS.has(node.property.name)
  );
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Rendered money lines must read a named field; deriving one by arithmetic silently mislabels the next part added to the schema.",
    },
    schema: [],
    messages: {
      derived:
        "This derives a money figure from `{{field}}` with arithmetic. A derived line is numerically right until the schema grows a part — then it prints that part under the wrong label on a receipt (this exact bug: 11C.2). Add a named field to OrderTotals and read it; computation belongs in src/lib/orders/totals.ts.",
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (!SCOPE.test(filename)) return {};

    return {
      BinaryExpression(node) {
        if (node.operator !== "+" && node.operator !== "-") return;
        const money = [node.left, node.right].find(moneyMember);
        if (!money) return;
        context.report({
          node,
          messageId: "derived",
          data: { field: money.property.name },
        });
      },
    };
  },
};

export default rule;
