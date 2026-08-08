import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { OrderDetail } from "@/components/checkout/order-detail";
import { formatOrderDate } from "@/components/checkout/order-format";
import { StatusChip } from "@/components/checkout/status-chip";
import { GoogleSignInForm } from "@/components/storefront/sign-in";
import { Button } from "@/components/ui/button";
import { getOrderForViewer } from "@/lib/queries/orders";

/**
 * Deliberately static, and deliberately vague.
 *
 * A `generateMetadata` that read the order would put its number — and a second
 * query — behind a title, and would answer "does order FV-2026-00042 exist?"
 * differently for an owner and a stranger. The page below already refuses to
 * make that distinction; the metadata must not reintroduce it.
 */
export const metadata: Metadata = {
  title: "Your order",
  robots: { index: false, follow: false },
};

/**
 * Set by checkout on the navigation that follows a placed order, and by nothing
 * else — the "see the order" link on a failed payment deliberately omits it.
 *
 * A clock comparison against `placedAt` was the first attempt and was wrong
 * twice over: `Date.now()` in a render is impure (the React compiler rule
 * catches it), and "placed in the last half hour" is not the question. The
 * question is "did the customer arrive here from checkout", which only checkout
 * knows. Anyone can add the parameter by hand; all it can do is congratulate
 * them on an order that is already theirs to read.
 */
const JUST_PLACED = "placed";

/**
 * The confirmation.
 *
 * **A stranger gets a 404, not a 403.** `getOrderForViewer` returns null unless
 * the caller owns the order, and null becomes `notFound()`. "You are not
 * authorised to view this order" would confirm the order exists, which is the
 * whole prize for someone walking the order-number space — and order numbers
 * are sequential. The page an attacker sees is identical to the page they get
 * for a number nobody has ever used.
 *
 * The same URL is the receipt, the tracking page and the thing linked from a
 * failed payment, so nothing here assumes it is being read seconds after
 * checkout. The celebration is time-boxed; everything else is true forever.
 */
export default async function OrderConfirmationPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderNumber: string }>;
  searchParams: Promise<{ placed?: string }>;
}) {
  const [{ orderNumber }, query] = await Promise.all([params, searchParams]);
  const order = await getOrderForViewer(orderNumber);
  if (!order) notFound();

  const justPlaced = query.placed === JUST_PLACED;

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      {justPlaced ? (
        <div className="mb-6">
          <div className="tread-rule w-24" aria-hidden="true" />
          <p className="mt-4 font-mono text-xs tracking-[0.06em] uppercase">
            {order.status === "cancelled" ? "Order cancelled" : "Order placed"}
          </p>
        </div>
      ) : null}

      <h1 className="font-display text-4xl font-extrabold tracking-[-0.03em] uppercase">
        Your order
      </h1>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3">
        {/* Mono and large: the order number is the one string on this page
            somebody will read out over the phone. */}
        <p className="font-mono text-2xl font-medium">
          <span className="sr-only">Order number </span>
          {order.orderNumber}
        </p>
        <StatusChip status={order.status} />
      </div>

      <p className="text-muted-foreground mt-2 text-sm">
        Placed on{" "}
        <time dateTime={order.placedAt}>{formatOrderDate(order.placedAt)}</time>
      </p>

      <OrderDetail order={order} />

      <div className="mt-10 border-t border-border pt-8">
        {order.isGuestOrder ? (
          <div className="max-w-xl">
            <h2 className="text-lg font-semibold">
              Keep your orders in one place
            </h2>
            {/*
              An offer about the future, not a promise about this order. Whether
              signing in attaches an existing guest order to the new account is
              a decision that lives in src/lib/orders/ — `OrderView.isGuestOrder`
              leaves room for it ("and still has none"). If that lands, this
              copy should say so, because "we will link this one" is a much
              better reason to sign in than "future ones will be tidier".
            */}
            <p className="text-muted-foreground mt-2 text-base text-pretty">
              An account keeps your order history, your saved addresses and your
              bag together on every device you use. You did not need one to buy,
              and you do not need one now.
            </p>
            <div className="mt-4 max-w-xs">
              <GoogleSignInForm
                next={`/order/${order.orderNumber}`}
                label="Create an account"
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" asChild>
              <Link href="/account/orders">See all your orders</Link>
            </Button>
            <Button variant="ghost" asChild>
              <Link href="/shop">Keep shopping</Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
