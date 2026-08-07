"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A horizontal rail.
 *
 * On a phone it is native overflow with scroll-snap — no JavaScript involved,
 * so it works before hydration and cannot stutter. On a desktop, where there is
 * no swipe, two arrow buttons appear and page it by one viewport at a time.
 *
 * The arrows are the *only* client-side part, and they disable themselves at
 * each end rather than scrolling into nothing. They are also `aria-hidden`:
 * the rail is a plain scroll container, so a keyboard user tabs through the
 * cards and the browser scrolls to each in turn, which already works. An arrow
 * button in the tab order would be two extra stops that do nothing new.
 */
export function Rail({
  children,
  label,
  className,
}: {
  children: React.ReactNode;
  label: string;
  className?: string;
}) {
  const scroller = React.useRef<HTMLUListElement | null>(null);
  const [atStart, setAtStart] = React.useState(true);
  const [atEnd, setAtEnd] = React.useState(true);

  const measure = React.useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setAtStart(el.scrollLeft <= 1);
    // 1px of slack: sub-pixel widths mean scrollLeft never quite reaches the
    // arithmetic maximum, and an arrow that stays enabled at the end is worse
    // than one that disables a pixel early.
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  }, []);

  React.useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  const page = (direction: -1 | 1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({
      left: direction * el.clientWidth * 0.9,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  };

  const hasOverflow = !(atStart && atEnd);

  return (
    <div className={cn("relative", className)}>
      <ul
        ref={scroller}
        onScroll={measure}
        aria-label={label}
        className="rail -mx-4 flex gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0"
      >
        {children}
      </ul>

      {hasOverflow ? (
        <div aria-hidden className="pointer-events-none absolute inset-y-0 -inset-x-2 hidden lg:block">
          <RailArrow side="left" disabled={atStart} onClick={() => page(-1)} />
          <RailArrow side="right" disabled={atEnd} onClick={() => page(1)} />
        </div>
      ) : null}
    </div>
  );
}

function RailArrow({
  side,
  disabled,
  onClick,
}: {
  side: "left" | "right";
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <Button
      type="button"
      variant="secondary"
      size="icon"
      tabIndex={-1}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "pointer-events-auto absolute top-1/3 -translate-y-1/2 rounded-full border shadow-md transition-opacity",
        side === "left" ? "left-0" : "right-0",
        disabled && "opacity-0",
      )}
    >
      <Icon />
    </Button>
  );
}
