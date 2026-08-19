import Image from "next/image";
import Link from "next/link";

import { formatPaise } from "@/lib/format";
import type { OrderLine } from "@/lib/orders/types";

/**
 * What was bought, as it was bought.
 *
 * Every field here is a snapshot taken when the order was written — name, size,
 * colour, SKU, unit price, image. Nothing is re-read from the catalog, which is
 * the point: a product renamed, repriced or deleted next month must not rewrite
 * what somebody's receipt says they paid for.
 *
 * `productSlug` is the one field allowed to be null, because the product it
 * pointed at may be gone. When it is, the name stops being a link rather than
 * becoming a 404 — a dead link on a receipt is worse than no link.
 */
export function OrderLines({ lines }: { lines: OrderLine[] }) {
  return (
    <ul className="divide-border divide-y">
      {lines.map((line) => (
        <li key={line.id} className="flex gap-4 py-4">
          <div className="bg-photo relative aspect-4/5 w-16 shrink-0 overflow-hidden rounded-lg sm:w-20">
            {line.imageUrl ? (
              <Image
                src={line.imageUrl}
                alt=""
                fill
                loading="lazy"
                sizes="80px"
                className="object-cover"
              />
            ) : null}
          </div>

          <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
            <div className="min-w-0">
              {/*
                `hit-44` rather than a taller box, the same trade the bag makes:
                the name is a 14px line above three more, and giving the anchor
                44px of its own height would space them apart until the row
                stopped reading as one item. Measured at 163×18 without it.
              */}
              <h3 className="text-sm font-medium text-pretty">
                {line.productSlug ? (
                  <Link
                    href={`/product/${line.productSlug}`}
                    className="hit-44 hover:text-orange-ink"
                  >
                    {line.productName}
                  </Link>
                ) : (
                  line.productName
                )}
              </h3>
              <p className="text-muted-foreground mt-1 font-mono text-xs tracking-[0.06em]">
                UK {line.size} · {line.color}
              </p>
              <p className="text-muted-foreground mt-1 font-mono text-xs tracking-[0.06em]">
                {line.sku}
              </p>
              <p className="text-muted-foreground mt-1 font-mono text-xs tracking-[0.06em]">
                {line.quantity} × {formatPaise(line.unitPrice)}
              </p>
            </div>

            <p className="shrink-0 font-mono text-sm font-medium">
              {formatPaise(line.lineTotal)}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
