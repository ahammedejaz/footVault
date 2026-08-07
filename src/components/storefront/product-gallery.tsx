"use client";

import * as React from "react";
import Image from "next/image";

import { cn } from "@/lib/utils";

/**
 * The product gallery.
 *
 * Two images per product from the seed — the three-quarter view and the
 * outsole — with thumbnails below. The thumbnail row is real buttons rather
 * than a scroll-jacked carousel, so keyboard and screen-reader users get the
 * same control as everyone else.
 */
export function ProductGallery({
  images,
  productName,
}: {
  images: Array<{ url: string; alt: string }>;
  productName: string;
}) {
  const [active, setActive] = React.useState(0);
  if (images.length === 0) return null;

  const current = images[Math.min(active, images.length - 1)]!;

  return (
    <div>
      <div className="bg-fog relative aspect-4/5 overflow-hidden rounded-lg">
        <Image
          src={current.url}
          alt={current.alt}
          fill
          priority
          sizes="(max-width: 1024px) 100vw, 50vw"
          className="object-cover"
        />
      </div>

      {images.length > 1 ? (
        <ul className="mt-3 flex gap-3">
          {images.map((image, index) => (
            <li key={image.url}>
              <button
                type="button"
                onClick={() => setActive(index)}
                aria-pressed={index === active}
                aria-label={`View ${image.alt || productName}`}
                className={cn(
                  "bg-fog relative block size-20 overflow-hidden rounded-lg border transition-colors",
                  index === active ? "border-orange" : "border-border hover:border-foreground",
                )}
              >
                <Image
                  src={image.url}
                  alt=""
                  aria-hidden
                  fill
                  sizes="80px"
                  className="object-cover"
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
