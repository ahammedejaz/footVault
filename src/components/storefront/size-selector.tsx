"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import type { SizeAvailability } from "@/lib/catalog-types";
import { cn } from "@/lib/utils";

/**
 * The size run as the primary selector.
 *
 * Selecting a size writes it to the URL, so a chosen size survives a refresh
 * and can be linked — "the 9 is still there, look" is a message people
 * actually send. Sold-out sizes stay visible and struck through; they are
 * rendered as disabled spans rather than links, so keyboard users are not
 * walked through options they cannot pick.
 */
export function SizeSelector({
  sizes,
  selected,
}: {
  sizes: SizeAvailability[];
  selected: string | null;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const hrefFor = (size: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("size", size);
    return `${pathname}?${next.toString()}`;
  };

  return (
    <ul className="flex flex-wrap gap-2" role="list">
      {sizes.map((entry) => {
        const isSelected = entry.size === selected;
        if (!entry.available) {
          return (
            <li key={entry.size}>
              <span
                aria-disabled="true"
                className="border-border text-dim flex h-12 min-w-12 items-center justify-center rounded-lg border px-3 font-mono text-base line-through decoration-1"
              >
                {entry.size}
                <span className="sr-only"> — sold out</span>
              </span>
            </li>
          );
        }
        return (
          <li key={entry.size}>
            <Link
              href={hrefFor(entry.size)}
              scroll={false}
              aria-current={isSelected ? "true" : undefined}
              className={cn(
                "flex h-12 min-w-12 items-center justify-center rounded-lg border px-3 font-mono text-base transition-colors",
                isSelected
                  ? "border-ink bg-ink text-paper font-medium"
                  : "border-border hover:border-foreground",
              )}
            >
              {entry.size}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
