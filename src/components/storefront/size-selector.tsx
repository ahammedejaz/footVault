"use client";

import * as React from "react";

import type { SizeAvailability } from "@/lib/catalog-types";
import { cn } from "@/lib/utils";

/**
 * The size run as the primary selector.
 *
 * `radiogroup` rather than a row of buttons: picking a size is choosing one of
 * a set, which is what a radio group means, and it is what makes the arrow keys
 * expected rather than a surprise. Roving tabindex, so the whole run is one tab
 * stop and the arrows move within it — twelve tab stops to get past a size
 * strip is how a keyboard user ends up somewhere else.
 *
 * Sold-out sizes stay in the run and stay selectable. They are struck through
 * and their accessible name says "sold out", and choosing one is a real answer:
 * the line underneath then says so. Removing them, or making them unfocusable,
 * would hide exactly the information the size strip exists to show.
 */
export function SizeSelector({
  sizes,
  selected,
  onSelect,
  labelledBy,
}: {
  sizes: SizeAvailability[];
  selected: string | null;
  onSelect: (size: string) => void;
  labelledBy: string;
}) {
  const refs = React.useRef(new Map<string, HTMLButtonElement>());

  // Whichever chip the arrows would land on first: the selection, or the first
  // size available to buy, or failing that the first size at all.
  const fallback =
    sizes.find((entry) => entry.size === selected)?.size ??
    sizes.find((entry) => entry.available)?.size ??
    sizes[0]?.size ??
    null;

  const move = (from: number, delta: number) => {
    if (sizes.length === 0) return;
    const next = (from + delta + sizes.length) % sizes.length;
    const size = sizes[next]!.size;
    onSelect(size);
    refs.current.get(size)?.focus();
  };

  const onKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        move(index, 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        move(index, -1);
        break;
      case "Home":
        event.preventDefault();
        move(-1, 1);
        break;
      case "End":
        event.preventDefault();
        move(0, -1);
        break;
      default:
    }
  };

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      className="flex flex-wrap gap-2"
    >
      {sizes.map((entry, index) => {
        const isSelected = entry.size === selected;
        return (
          <button
            key={entry.size}
            ref={(node) => {
              if (node) refs.current.set(entry.size, node);
              else refs.current.delete(entry.size);
            }}
            type="button"
            role="radio"
            aria-checked={isSelected}
            // The strikethrough is the whole message and it is invisible to a
            // screen reader, so the name carries it instead.
            aria-label={
              entry.available
                ? `UK ${entry.size}`
                : `UK ${entry.size}, sold out`
            }
            tabIndex={
              isSelected || (selected === null && entry.size === fallback)
                ? 0
                : -1
            }
            onKeyDown={(event) => onKeyDown(event, index)}
            onClick={() => onSelect(entry.size)}
            className={cn(
              // 48px, per the design system: comfortably over the 44px floor
              // with room for a half size like 8.5 without wrapping.
              "flex h-12 min-w-12 items-center justify-center rounded-lg border px-3 font-mono text-base transition-colors",
              isSelected
                ? "border-ink bg-ink text-paper font-medium"
                : entry.available
                  ? "border-border hover:border-foreground"
                  : "border-border/70 text-dim line-through decoration-1",
            )}
          >
            <span aria-hidden>{entry.size}</span>
          </button>
        );
      })}
    </div>
  );
}
