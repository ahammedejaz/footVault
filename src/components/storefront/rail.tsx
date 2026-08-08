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
 * no swipe, two arrow buttons appear and page it by whole cards.
 *
 * The arrows are the *only* client-side part, and they disable themselves at
 * each end rather than scrolling into nothing. They are also `aria-hidden`:
 * the rail is a plain scroll container, so a keyboard user tabs through the
 * cards and the browser scrolls to each in turn, which already works. An arrow
 * button in the tab order would be two extra stops that do nothing new.
 *
 * Two things about the geometry are deliberate and were both defects before.
 *
 * The scroller no longer bleeds to the viewport edge. It used to carry
 * `-mx-4 px-4`, which made it wider than the page container, so the card at the
 * cut was sliced by the edge of the screen with nothing beyond it — a rail that
 * has run off the page rather than one you can scroll. Now it sits inside the
 * container and overhangs by 8px only, which is slack for a focus ring, not a
 * bleed.
 *
 * And the arrows sit *above* the rail in their own strip rather than on top of
 * the first and last cards. There is nowhere to overlay a 44px control at 1024
 * wide: the page gutter is 24px, so anything anchored to the rail's edge is
 * standing on a card. The strip costs 52px of height on large screens and
 * always occupies it, arrows visible or not, so nothing moves when the measure
 * lands after hydration.
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

    /*
      A whole number of cards, measured from the DOM rather than assumed.

      This used to scroll by 90% of the viewport and leave scroll-snap to tidy
      up whatever fraction of a card that landed on. Snap does tidy it up, but
      only after a second animation, and only if the browser agrees about which
      snap point is nearest — so the rail visibly settled backwards about as
      often as it settled forwards. Rounding the step down to the card pitch
      means the resting position is a card boundary by construction.
    */
    const first = el.firstElementChild as HTMLElement | null;
    const second = el.children[1] as HTMLElement | undefined;
    const pitch =
      first && second
        ? second.getBoundingClientRect().left - first.getBoundingClientRect().left
        : (first?.getBoundingClientRect().width ?? el.clientWidth);
    const step = pitch > 0 ? Math.max(1, Math.floor(el.clientWidth / pitch)) * pitch : el.clientWidth;

    el.scrollBy({
      left: direction * step,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  };

  return (
    <div className={cn("relative", className)}>
      <div data-rail-controls aria-hidden className="mb-2 hidden justify-end gap-2 lg:flex">
        <RailArrow side="left" disabled={atStart} onClick={() => page(-1)} />
        <RailArrow side="right" disabled={atEnd} onClick={() => page(1)} />
      </div>

      <ul
        ref={scroller}
        data-rail
        onScroll={measure}
        aria-label={label}
        className="rail -mx-2 flex gap-4 overflow-x-auto px-2 pb-2 scroll-px-2"
      >
        {children}
      </ul>
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
      // Invisible rather than absent at the ends: the strip keeps its width, so
      // the arrow that is still live does not slide sideways when the other one
      // switches off.
      className={cn("rounded-full border transition-opacity", disabled && "opacity-0")}
    >
      <Icon />
    </Button>
  );
}
