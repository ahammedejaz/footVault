"use client";

import { Minus, Plus } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Minus, a number, plus.
 *
 * A stepper rather than a `<select>`: on a phone a select opens a wheel for a
 * choice that is almost always ±1, and the two-tap cost of that wheel is paid
 * on every quantity change in the shop.
 *
 * The number is a live region so the change is announced without moving focus —
 * a customer holding the plus button should hear the count, not be dragged to
 * it. Both buttons keep their 44px target even though they look smaller.
 */
export function QuantityStepper({
  quantity,
  max,
  onChange,
  busy,
  label,
}: {
  quantity: number;
  /** Live stock, or the per-line ceiling, whichever is lower. */
  max: number;
  onChange: (next: number) => void;
  busy?: boolean;
  /** What is being counted, for the buttons' accessible names. */
  label: string;
}) {
  return (
    <div className="border-border inline-flex items-center rounded-lg border">
      <button
        type="button"
        onClick={() => onChange(quantity - 1)}
        disabled={busy || quantity <= 1}
        aria-label={`One fewer ${label}`}
        className="hit-44 hover:bg-muted flex size-9 items-center justify-center rounded-l-lg transition-colors disabled:opacity-40"
      >
        <Minus className="size-3.5" aria-hidden />
      </button>

      <span
        aria-live="polite"
        aria-atomic="true"
        className={cn(
          "min-w-8 text-center font-mono text-sm tabular-nums",
          busy && "opacity-50",
        )}
      >
        {quantity}
        <span className="sr-only"> {label}</span>
      </span>

      <button
        type="button"
        onClick={() => onChange(quantity + 1)}
        disabled={busy || quantity >= max}
        aria-label={`One more ${label}`}
        className="hit-44 hover:bg-muted flex size-9 items-center justify-center rounded-r-lg transition-colors disabled:opacity-40"
      >
        <Plus className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
