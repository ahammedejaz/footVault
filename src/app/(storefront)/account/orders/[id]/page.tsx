import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { OrderDetail } from "@/components/checkout/order-detail";
import { formatOrderDate } from "@/components/checkout/order-format";
import { StatusChip } from "@/components/checkout/status-chip";
import { getOrderForViewer } from "@/lib/queries/orders";
import { cachedSiteSettings } from "@/lib/queries/cached";
import { setting, type ContactSettings } from "@/lib/queries/content";

export const metadata: Metadata = {
  title: "Order",
  robots: { index: false, follow: false },
};

/**
 * One order, from the history.
 *
 * Addressed by id rather than by order number, because this is a list row being
 * opened rather than a link being typed, and the list already holds the id.
 * `getOrderForViewer` accepts either and returns null for anything the caller
 * does not own — so this page, like the confirmation, answers a stranger with a
 * 404 rather than telling them the order is real.
 */
export default async function AccountOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const order = await getOrderForViewer(id);
  if (!order) notFound();

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <Link
        href="/account/orders"
        className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center gap-2 rounded-lg font-mono text-xs tracking-[0.06em] uppercase transition-colors"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        All orders
      </Link>

      <h1 className="font-display mt-2 text-4xl font-extrabold tracking-[-0.03em] uppercase">
        Your order
      </h1>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3">
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

      <OrderDetail order={order} contact={await shopContact()} />
    </div>
  );
}

/**
 * Where to reach the shop, for the replacement window.
 *
 * The store's policy is that a damaged parcel is reported by contacting them
 * directly — there is no self-service path by design — so the contact details
 * have to travel with the order, not sit in the footer.
 */
async function shopContact() {
  const settings = await cachedSiteSettings();
  const contact = setting<ContactSettings>(settings, "contact", {
    email: "",
    phone: "",
    whatsapp: "",
    address: "",
  });
  return {
    phone: contact.phone || null,
    whatsapp: contact.whatsapp || null,
  };
}
