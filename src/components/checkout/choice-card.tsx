"use client";

import { useId } from "react";

import { cn } from "@/lib/utils";

/**
 * One option in a set of one — a delivery address, a way to pay.
 *
 * **The radio really is the whole card.** It is a native `<input type="radio">`
 * stretched to `inset-0` at zero opacity, with the visible dot drawn by a
 * sibling through `group-has-[:checked]`. That is not decoration: the tap
 * target measured by `npm run audit:overflow` is the input's own box, and a
 * 13px radio with a `::before` pad would report 44px while a thumb still landed
 * on 13 — `::before` is not rendered on a replaced element. Stretching the
 * input makes the measured target and the real one the same object.
 *
 * Native radios also bring what a `role="radiogroup"` reimplementation has to
 * earn: arrow keys move within the set, the set is one tab stop, and it all
 * works before any JavaScript arrives.
 *
 * The accessible name is the title alone, via `aria-labelledby`. Left to the
 * wrapping `<label>` it would be the entire card — "Cash on Delivery Pay the
 * delivery agent in cash when the parcel arrives Available on orders under…" —
 * read out in full before the customer hears what the next option is.
 */
export function ChoiceCard({
  name,
  value,
  checked,
  onSelect,
  title,
  description,
  note,
  disabled,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: (value: string) => void;
  title: React.ReactNode;
  /** One line under the title. What picking this actually means. */
  description?: React.ReactNode;
  /** The caveat. Smaller, never hidden. */
  note?: React.ReactNode;
  disabled?: boolean;
  /** Anything richer than the three lines above — an address, for instance. */
  children?: React.ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <label
      className={cn(
        "group border-border relative block cursor-pointer rounded-lg border p-4 transition-colors",
        "has-[:checked]:border-foreground has-[:checked]:bg-fog",
        // The global :focus-visible indicator paints on the focused element,
        // and the focused element here is invisible. Repeated on the card so
        // the composite orange-on-halo ring still appears where the eye is.
        "has-[:focus-visible]:outline-orange has-[:focus-visible]:shadow-[0_0_0_4px_var(--fv-focus-halo)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onSelect(value)}
        aria-labelledby={titleId}
        aria-describedby={description || note ? descriptionId : undefined}
        className="absolute inset-0 size-full cursor-pointer appearance-none rounded-lg opacity-0 disabled:cursor-not-allowed"
      />

      <div className="pointer-events-none flex items-start gap-3">
        <span
          aria-hidden
          className="border-line group-has-[:checked]:border-foreground mt-0.5 grid size-5 shrink-0 place-items-center rounded-4xl border-2"
        >
          <span className="bg-foreground size-2.5 rounded-4xl opacity-0 transition-opacity group-has-[:checked]:opacity-100" />
        </span>

        <span className="min-w-0 flex-1">
          <span id={titleId} className="block text-sm font-medium text-pretty">
            {title}
          </span>
          {description || note ? (
            <span id={descriptionId} className="block">
              {description ? (
                <span className="text-muted-foreground mt-1 block text-sm text-pretty">
                  {description}
                </span>
              ) : null}
              {note ? (
                <span className="text-muted-foreground mt-1 block text-xs text-pretty">
                  {note}
                </span>
              ) : null}
            </span>
          ) : null}
          {children ? <span className="mt-2 block">{children}</span> : null}
        </span>
      </div>
    </label>
  );
}
