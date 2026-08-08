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
 * **Sold-out sizes stay in the run, and stopped being selectable in Phase 7.**
 * They were selectable by design until then, on the reasoning that choosing one
 * is a real answer and the line underneath says so. The owner's zero-stock
 * report ended that: a chip that can be chosen is a chip that leads somewhere,
 * and the somewhere was an add-to-bag button that had to refuse. The brief is
 * explicit — *"is not selectable, and cannot be added to the bag"* — so a
 * sold-out chip now answers a press by saying so instead of by becoming the
 * selection, and the arrows step over it.
 *
 * `aria-disabled` rather than `disabled`, and the distinction is the whole
 * reason the chip still works: a `disabled` button cannot be focused, cannot be
 * reached by a screen reader walking the group, and so can never explain
 * itself. This one is focusable, announces "UK 8, sold out", and passes the
 * press to `onUnavailable` so the live region can repeat it for anybody who
 * cannot see the strikethrough.
 */
export function SizeSelector({
  sizes,
  selected,
  onSelect,
  onUnavailable,
  labelledBy,
}: {
  sizes: SizeAvailability[];
  selected: string | null;
  onSelect: (size: string) => void;
  /** A sold-out chip was pressed. Announce it; do not select it. */
  onUnavailable?: (size: string) => void;
  labelledBy: string;
}) {
  const refs = React.useRef(new Map<string, HTMLButtonElement>());

  // Whichever chip the arrows would land on first: the selection, or the first
  // size available to buy, or failing that the first size at all — because a
  // run with nothing left still has to be reachable to be read.
  const fallback =
    sizes.find((entry) => entry.size === selected)?.size ??
    sizes.find((entry) => entry.available)?.size ??
    sizes[0]?.size ??
    null;

  /**
   * Arrow to the next size that can actually be chosen.
   *
   * Stepping onto a sold-out chip and selecting it was the old behaviour and is
   * exactly what "not selectable" rules out. Bounded by the run's length so a
   * product with nothing left cannot spin: if the walk comes all the way back
   * round, there is nowhere to go and the focus stays put.
   */
  const move = (from: number, delta: number) => {
    if (sizes.length === 0) return;
    for (let step = 1; step <= sizes.length; step++) {
      const next =
        (((from + delta * step) % sizes.length) + sizes.length) % sizes.length;
      const entry = sizes[next]!;
      if (!entry.available) continue;
      onSelect(entry.size);
      refs.current.get(entry.size)?.focus();
      return;
    }
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
            aria-disabled={entry.available ? undefined : true}
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
            onClick={() => {
              if (!entry.available) {
                onUnavailable?.(entry.size);
                return;
              }
              onSelect(entry.size);
            }}
            className={cn(
              // 48px, per the design system: comfortably over the 44px floor
              // with room for a half size like 8.5 without wrapping.
              "flex h-12 min-w-12 items-center justify-center rounded-lg border px-3 font-mono text-base transition-colors",
              isSelected
                ? "border-ink bg-ink text-paper font-medium"
                : entry.available
                  ? "border-border hover:border-foreground"
                  : "border-border/70 text-dim line-through decoration-1 cursor-not-allowed",
            )}
          >
            <span aria-hidden>{entry.size}</span>
          </button>
        );
      })}
    </div>
  );
}
