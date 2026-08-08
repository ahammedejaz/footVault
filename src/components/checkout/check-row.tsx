"use client";

import { Check } from "lucide-react";
import { useId } from "react";

import { cn } from "@/lib/utils";

/**
 * A checkbox that is a row rather than a 13px square.
 *
 * Same construction as `ChoiceCard`, for the same measured reason: a native
 * checkbox is about 13×13, `::before` does not render on a replaced element, so
 * the only way to make the real hit area 44px is to make the input's own box
 * that size. It is stretched over the row at zero opacity and the tick is drawn
 * by a sibling.
 */
export function CheckRow({
  name,
  checked,
  onChange,
  label,
  hint,
}: {
  name: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
}) {
  const labelId = useId();
  const hintId = useId();

  return (
    <label className="group border-border hover:bg-fog relative flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-orange has-[:focus-visible]:shadow-[0_0_0_4px_var(--fv-focus-halo)]">
      <input
        type="checkbox"
        name={name}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-labelledby={labelId}
        aria-describedby={hint ? hintId : undefined}
        className="absolute inset-0 size-full cursor-pointer appearance-none rounded-lg opacity-0"
      />

      <span
        aria-hidden
        className={cn(
          "border-line group-has-[:checked]:border-foreground group-has-[:checked]:bg-foreground mt-0.5 grid size-5 shrink-0 place-items-center rounded-sm border-2 transition-colors",
        )}
      >
        <Check className="text-background size-3 opacity-0 group-has-[:checked]:opacity-100" />
      </span>

      <span className="pointer-events-none min-w-0 flex-1">
        <span id={labelId} className="block text-sm text-pretty">
          {label}
        </span>
        {hint ? (
          <span
            id={hintId}
            className="text-muted-foreground mt-0.5 block text-xs text-pretty"
          >
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
}
