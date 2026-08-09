"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The settings controls, rebuilt around one rule: **the control comes first.**
 *
 * ## What was wrong, measured rather than felt
 *
 * The owner asked three times over two phases for a flat delivery rate and a
 * Pay-on-Delivery switch. Both were on `/admin/settings` the whole time,
 * rendering, interactive, deployed. The failure was information design, and the
 * audit found three specific causes:
 *
 * 1. **Every control was subordinate to its own explanation.** A `<select>` and
 *    three 16-pixel native checkboxes sat inside a wall of grey paragraphs that
 *    were physically larger and darker than the controls themselves. The prose
 *    was written to satisfy a real requirement — *"one line per setting saying
 *    what it does and what happens if it is set too high or too low"* — and it
 *    succeeded at that and overshot into hiding the settings.
 * 2. **The word the owner was scanning for was inside a closed dropdown.** In
 *    the default state the delivery-charge select displayed only *"Pass the
 *    courier's rate through"*. *"Charge one flat amount"* existed only after a
 *    click, and the flat-amount field was not in the DOM at all.
 * 3. **The panel opened by denying it did the thing.** Its most prominent line
 *    was **"Delivery rates are not set here."**
 *
 * ## What these components do about it
 *
 * - `Field` puts the label above the control and the consequence line **below**
 *   it, one step smaller and lighter. The consequence lines stay — they are
 *   genuinely good and were a real requirement — they simply stop outranking the
 *   thing they describe.
 * - `RadioChoice` renders every option inline as a real radio, so every word an
 *   owner might scan for is on screen in the default state. Nothing that decides
 *   how money is charged hides inside a closed dropdown.
 * - `Toggle` is a switch a finger can hit, not a 16-pixel checkbox, and its
 *   accessible name is the **label alone**. That is a fix as well as a style: the
 *   old markup wrapped the four-line consequence paragraph inside the `<label>`,
 *   so the control announced its entire explanation as its own name.
 *
 * Everything here is located by `scripts/audit/settings-controls.ts` through its
 * visible label. A control that loses its label fails that gate rather than
 * quietly becoming unfindable again.
 */

/* --------------------------------------------------------------- field ---- */

export function Field({
  htmlFor,
  label,
  hint,
  children,
  className,
  disabled,
}: {
  htmlFor: string;
  label: string;
  /** What happens if this is set too high or too low. Below the control. */
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  /*
    The wrapper is **not** dimmed when the field is disabled, and that is a fix
    rather than a preference. `opacity-60` over `text-muted-foreground` took the
    hint to 2.53:1 — axe caught it on the first run after the redesign — and the
    hint on a disabled field is the one sentence the owner most needs to read:
    "Applies when 'Charge one flat amount' is chosen above." Dimming the
    explanation of why a control is unavailable is the opposite of the point.

    The control itself still shows its state: `Input` carries `disabled:bg-muted`
    and a not-allowed cursor.
  */
  return (
    <div className={className}>
      <label
        htmlFor={htmlFor}
        className={cn(
          "block text-sm font-medium",
          disabled && "text-muted-foreground",
        )}
      >
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      {hint ? (
        <p
          id={`${htmlFor}-hint`}
          className="text-muted-foreground mt-1.5 text-xs text-pretty"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- money ---- */

export function Money({
  id,
  label,
  hint,
  value,
  onChange,
  disabled,
  /** What a zero means here, when zero is "not set" rather than an amount. */
  unsetMeans,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  unsetMeans?: string;
}) {
  const unset = unsetMeans !== undefined && !(value > 0);
  return (
    <Field htmlFor={id} label={label} hint={hint} disabled={disabled}>
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-muted-foreground font-mono text-sm">
          ₹
        </span>
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={0}
          /*
            `step="any"`, never the field's natural increment.

            A `step` on a number input is constraint validation, not an arrow-key
            size: the browser silently refuses to submit a value that is not a
            multiple of it, showing a native bubble no code here controls. The
            packed weight was stepped by 10, so an owner typing a real 1,234 g
            parcel pressed Save and nothing happened — no toast, no error, no
            request. Found by `audit:settings-controls` on its first run.
          */
          step="any"
          disabled={disabled}
          aria-describedby={hint ? `${id}-hint` : undefined}
          value={unset ? "" : Number.isFinite(value) ? value : 0}
          placeholder={unset ? "not set" : undefined}
          onChange={(event) => {
            const next = event.target.valueAsNumber;
            onChange(Number.isFinite(next) ? next : 0);
          }}
          className="max-w-40 tabular-nums"
        />
        {unset ? (
          <span className="text-muted-foreground text-xs">
            not set — {unsetMeans}
          </span>
        ) : null}
      </div>
    </Field>
  );
}

/* -------------------------------------------------------------- number ---- */

export function Amount({
  id,
  label,
  unit,
  hint,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  /** Shown beside the label, so "grams" is never a guess. */
  unit?: string;
  hint?: React.ReactNode;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <Field
      htmlFor={id}
      label={unit ? `${label} (${unit})` : label}
      hint={hint}
      disabled={disabled}
    >
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        value={value > 0 ? value : ""}
        placeholder="not set"
        onChange={(event) => {
          const next = event.target.valueAsNumber;
          onChange(Number.isFinite(next) ? next : 0);
        }}
        className="max-w-40 tabular-nums"
      />
    </Field>
  );
}

/* ---------------------------------------------------------------- text ---- */

export function Text({
  id,
  label,
  hint,
  value,
  onChange,
  ...rest
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  inputMode?: "text" | "numeric";
  maxLength?: number;
  placeholder?: string;
}) {
  return (
    <Field htmlFor={id} label={label} hint={hint}>
      <Input
        id={id}
        value={value}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)}
        {...rest}
      />
    </Field>
  );
}

/* --------------------------------------------------------------- radio ---- */

/**
 * Every option, on screen, in the closed state.
 *
 * This replaced a `<select>`, and the reason is the whole of finding 9A: an
 * owner scanning the page for the word *flat* found nothing, because the option
 * that says "Charge one flat amount" only existed inside a dropdown they had no
 * reason to open. A radio group has no closed state.
 *
 * The consequence line belongs to the **chosen** option, so it changes as the
 * owner moves between them — that is what makes it a consequence rather than a
 * caption.
 */
export function RadioChoice<T extends string>({
  name,
  legend,
  value,
  onChange,
  options,
  hint,
  disabled,
}: {
  name: string;
  legend: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; note?: string }[];
  hint?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend
        className={cn("text-sm font-medium", disabled && "text-muted-foreground")}
      >
        {legend}
      </legend>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const id = `${name}-${option.value}`;
          const chosen = value === option.value;
          return (
            <label
              key={option.value}
              htmlFor={id}
              /*
                A disabled group is shown by muting its **surface**, never its
                text. Dimming the words is what took the hint under a disabled
                field to 2.53:1 — and on a group like this the words are how the
                owner learns the feature exists before choosing it.
              */
              className={cn(
                "border-input flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm transition-colors",
                chosen && !disabled && "border-foreground bg-fog/40",
                disabled && "bg-muted/50 cursor-not-allowed",
              )}
            >
              <input
                id={id}
                type="radio"
                name={name}
                value={option.value}
                checked={chosen}
                disabled={disabled}
                onChange={() => onChange(option.value)}
                className="mt-0.5 size-4 shrink-0"
              />
              <span className="min-w-0">
                <span className="block font-medium">{option.label}</span>
                {option.note ? (
                  <span className="text-muted-foreground mt-0.5 block text-xs text-pretty">
                    {option.note}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      {hint ? (
        <p className="text-muted-foreground mt-2 text-xs text-pretty">{hint}</p>
      ) : null}
    </fieldset>
  );
}

/* -------------------------------------------------------------- toggle ---- */

/**
 * A switch, and its name is the label alone.
 *
 * Two things are wrong with the control this replaces, and only one of them is
 * cosmetic. The cosmetic one: `<input type="checkbox" className="size-4">` is a
 * 16-pixel box sitting under a four-line paragraph that is physically larger and
 * darker than it. The other one is a defect — that paragraph was **inside** the
 * `<label>`, so the checkbox's accessible name was the label plus the whole
 * explanation, which is what a screen reader announces on landing. The
 * explanation moves to `aria-describedby`, where it is still read out, after the
 * name, as a description.
 *
 * It stays a real `<input type="checkbox">` with `role="switch"` rather than
 * becoming a `<button>`: the input paints the track itself, so the global
 * `:focus-visible` indicator lands on the thing a keyboard is actually on, and
 * `check()` / `uncheck()` in `audit:settings-controls` drive it the way a person
 * does.
 */
export function Toggle({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="flex min-h-11 cursor-pointer items-center gap-3"
      >
        <span className="relative inline-flex shrink-0">
          <input
            id={id}
            type="checkbox"
            role="switch"
            checked={checked}
            disabled={disabled}
            aria-describedby={hint ? `${id}-hint` : undefined}
            onChange={(event) => onChange(event.target.checked)}
            className="peer border-input bg-muted checked:bg-foreground h-6 w-11 cursor-pointer appearance-none rounded-full border transition-colors disabled:cursor-not-allowed"
          />
          <span
            aria-hidden
            className="bg-background pointer-events-none absolute top-1/2 left-0.5 size-4 -translate-y-1/2 rounded-full shadow-sm transition-transform peer-checked:translate-x-5"
          />
        </span>
        <span className="text-sm font-medium">{label}</span>
      </label>
      {hint ? (
        <p
          id={`${id}-hint`}
          className="text-muted-foreground mt-1 ml-14 text-xs text-pretty"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
