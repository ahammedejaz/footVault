"use client";

import Image from "next/image";
import Link from "next/link";

import { Panel } from "@/components/admin/ui";
import { loaderFor } from "@/lib/images/srcset";

/**
 * Every photograph in the catalogue, at the size a customer sees it.
 *
 * ## Why a sheet rather than a list
 *
 * One well-framed photograph is not the goal; thirty consistent ones are. That
 * is a property you cannot check one product page at a time — the shoe that
 * floats too small in its card looks perfectly reasonable on its own, and only
 * becomes obviously wrong beside the thirty-four that do not.
 *
 * So this renders the whole catalogue in the card's own frame — `aspect-4/5`,
 * `bg-fog`, `object-contain`, the three the storefront uses — at roughly card
 * size. The odd one out is then a glance rather than a hunt, and the fix is one
 * click away because each tile links to the product it belongs to.
 *
 * ## The current product is marked, not filtered
 *
 * Showing only this product's pictures would answer "are these two consistent
 * with each other", which is the easy half. The tiles belonging to the product
 * being edited carry a ring so the owner can see *their* work in the context
 * that matters — the catalogue it is about to sit in.
 */
export function ContactSheet({
  images,
  currentProductId,
  total,
}: {
  images: {
    id: string;
    url: string;
    altText: string | null;
    productId: string;
    productName: string;
  }[];
  currentProductId: string;
  /** How many exist, so a capped sheet says so instead of implying completeness. */
  total: number;
}) {
  if (images.length === 0) return null;

  return (
    <Panel
      title="The catalogue, side by side"
      description="Every photograph at card size. A shoe that sits differently from the rest is easier to see here than to find by browsing."
    >
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        {images.map((image) => (
          <li key={image.id}>
            <Link
              href={`/admin/products/${image.productId}`}
              className="group block"
              // The product's name rather than the alt text: on this screen the
              // question is "which product is that", and the alt text describes
              // the photograph to someone who cannot see it, which is a
              // different sentence.
              title={image.productName}
            >
              <div
                className={[
                  "bg-fog relative aspect-4/5 overflow-hidden rounded-md",
                  image.productId === currentProductId
                    ? "ring-primary ring-2 ring-offset-1"
                    : "",
                ].join(" ")}
              >
                <Image
                  src={image.url}
                  alt={image.altText ?? image.productName}
                  fill
                  sizes="(min-width: 1024px) 12vw, 30vw"
                  loader={loaderFor(image.url)}
                  className="object-contain"
                />
              </div>
              <p className="text-muted-foreground mt-1 truncate text-xs">
                {image.productName}
              </p>
            </Link>
          </li>
        ))}
      </ul>

      {total > images.length ? (
        <p className="text-muted-foreground mt-3 text-xs">
          Showing the {images.length} most recent of {total}. The sheet is for
          spotting the odd one out, not for browsing the whole library.
        </p>
      ) : null}
    </Panel>
  );
}
