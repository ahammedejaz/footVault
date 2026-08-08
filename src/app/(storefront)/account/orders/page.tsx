import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { formatOrderDate } from "@/components/checkout/order-format";
import { StatusChip } from "@/components/checkout/status-chip";
import { EmptyState } from "@/components/storefront/empty-state";
import { GoogleSignInForm } from "@/components/storefront/sign-in";
import { getCurrentUser } from "@/lib/auth";
import { formatPaise } from "@/lib/format";
import type { OrderSummary } from "@/lib/orders/types";
import { listOrdersForCustomer } from "@/lib/queries/orders";

export const metadata: Metadata = {
  title: "Your orders",
  robots: { index: false, follow: false },
};

/**
 * Order history.
 *
 * Signed out this is a pitch rather than a wall, the same shape as /wishlist:
 * there is nothing here to hide, and an empty history and a signed-out history
 * look identical to everybody except the person who has one.
 *
 * A guest's orders are deliberately not listed here. There is no account to
 * hang them off, and a page that listed orders by cookie would show a shared
 * phone's previous owner somebody else's address.
 */
export default async function AccountOrdersPage() {
  const user = await getCurrentUser();
  const orders: OrderSummary[] = user ? await listOrdersForCustomer() : [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <h1 className="font-display text-4xl font-extrabold tracking-[-0.03em] uppercase">
        Your orders
      </h1>

      {!user ? (
        <div className="border-border mt-8 rounded-lg border p-6 text-center">
          <p className="text-base text-pretty">
            An account puts every order in one place — what you bought, where it
            went, and where it has got to. You never needed one to buy, and any
            order you have already placed as a guest is unaffected.
          </p>
          <div className="mx-auto mt-5 max-w-xs">
            <GoogleSignInForm next="/account/orders" />
          </div>
        </div>
      ) : orders.length === 0 ? (
        <EmptyState
          title="No orders yet"
          body="Nothing has been ordered on this account. The shop is the place to start — every card shows the full size run before you open anything."
          action={{ href: "/shop", label: "Shop all footwear" }}
        />
      ) : (
        <ul className="divide-border mt-8 divide-y border-t border-b">
          {orders.map((order) => (
            <OrderRow key={order.id} order={order} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One order in the list.
 *
 * The whole row is the link, stretched from the order number with an
 * `after:inset-0` overlay — one tab stop, a target the width of the row, and an
 * accessible name that is the order number rather than "click here". The
 * thumbnails are `aria-hidden`: three unlabelled shoe photographs add nothing
 * to a spoken row that already says what the order is.
 */
function OrderRow({ order }: { order: OrderSummary }) {
  return (
    <li className="relative flex flex-wrap items-center gap-x-4 gap-y-3 py-4 transition-colors hover:bg-fog">
      <div className="flex shrink-0 -space-x-3" aria-hidden>
        {order.thumbnails.map((thumbnail, index) => (
          <div
            key={`${thumbnail.url ?? "blank"}-${index}`}
            className="bg-fog border-background relative aspect-4/5 w-10 overflow-hidden rounded-md border-2"
          >
            {thumbnail.url ? (
              <Image
                src={thumbnail.url}
                alt=""
                fill
                loading="lazy"
                sizes="40px"
                className="object-cover"
              />
            ) : null}
          </div>
        ))}
      </div>

      <div className="min-w-0 flex-1">
        <p className="font-mono text-sm font-medium tracking-[0.06em]">
          <Link
            href={`/account/orders/${order.id}`}
            className="rounded-sm after:absolute after:inset-0 after:content-['']"
          >
            <span className="sr-only">Order </span>
            {order.orderNumber}
          </Link>
        </p>
        <p className="text-muted-foreground mt-1 text-sm">
          <time dateTime={order.placedAt}>
            {formatOrderDate(order.placedAt)}
          </time>{" "}
          · {order.itemCount} {order.itemCount === 1 ? "item" : "items"}
        </p>
      </div>

      <div className="flex items-center gap-4">
        <StatusChip status={order.status} />
        <p className="font-mono text-sm font-medium">
          {formatPaise(order.grandTotal)}
        </p>
      </div>
    </li>
  );
}
