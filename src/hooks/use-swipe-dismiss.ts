"use client";

import * as React from "react";

/**
 * Drag a panel shut.
 *
 * Radix gives a sheet Escape and a backdrop tap for free; neither is the
 * gesture a thumb reaches for. This adds the third: press, drag the panel
 * towards its own edge, release past a threshold and it closes.
 *
 * Three details that make it feel native rather than approximate:
 *
 *   - The panel follows the finger while dragging (transform only, so it stays
 *     on the compositor) and springs back if the drag is abandoned.
 *   - Dragging *away* from the edge is resisted rather than tracked, so the
 *     panel cannot be pulled off its anchor.
 *   - A drag that starts inside a list scrolled away from its top is ignored,
 *     so flicking a scrolled filter list does not close it.
 *
 * Pointer events rather than touch events: the same code then works for a mouse
 * drag and for a stylus, and there is no passive-listener problem to work
 * around. Mouse is excluded anyway — a mouse has the close button.
 */

const DISMISS_DISTANCE = 72;
const DISMISS_VELOCITY = 0.5; // px per ms

export function useSwipeDismiss({
  side,
  onDismiss,
  enabled = true,
}: {
  side: "left" | "right" | "bottom";
  onDismiss: () => void;
  enabled?: boolean;
}) {
  const start = React.useRef<{ x: number; y: number; at: number } | null>(null);
  const [offset, setOffset] = React.useState(0);

  const axis = side === "bottom" ? "y" : "x";
  const sign = side === "right" || side === "bottom" ? 1 : -1;

  const reset = React.useCallback(() => {
    start.current = null;
    setOffset(0);
  }, []);

  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!enabled || event.pointerType === "mouse") return;
      const scroller = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-swipe-scroller]",
      );
      if (scroller && scroller.scrollTop > 0) return;
      start.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    },
    [enabled],
  );

  const onPointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!start.current) return;
      const delta =
        axis === "y" ? event.clientY - start.current.y : event.clientX - start.current.x;
      const towardsEdge = delta * sign;
      setOffset(towardsEdge > 0 ? towardsEdge : towardsEdge / 4);
    },
    [axis, sign],
  );

  const onPointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!start.current) return;
      const elapsed = Math.max(1, event.timeStamp - start.current.at);
      const delta =
        axis === "y" ? event.clientY - start.current.y : event.clientX - start.current.x;
      const travelled = delta * sign;
      reset();
      if (travelled > DISMISS_DISTANCE || travelled / elapsed > DISMISS_VELOCITY) {
        onDismiss();
      }
    },
    [axis, sign, onDismiss, reset],
  );

  const translate =
    offset === 0
      ? undefined
      : axis === "y"
        ? `translate3d(0, ${offset * sign}px, 0)`
        : `translate3d(${offset * sign}px, 0, 0)`;

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: reset,
    },
    style: {
      transform: translate,
      transition: offset === 0 ? undefined : "none",
      touchAction: axis === "y" ? "pan-y" : "pan-x",
    } as React.CSSProperties,
  };
}
