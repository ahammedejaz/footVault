"use client";

import { FieldLabel } from "@/components/admin/ui";
import { cn } from "@/lib/utils";

/**
 * Label, control, error, hint — in that DOM order, with both the error and the
 * hint reachable from the control through `aria-describedby`.
 *
 * Shared by the product form and the size dialog rather than written twice,
 * because the half that is easy to forget is the wiring: a hint rendered next
 * to an input but not referenced by it is a hint a screen reader never reads,
 * and it looks completely correct on screen. Having one component own the ids
 * means `describedBy()` and the markup cannot drift apart.
 *
 * The error is deliberately not a live region. Submitting moves focus to the
 * first field that failed, and focusing an input announces its description, so
 * a live region would say the same sentence twice.
 */
export function Field({
  htmlFor,
  label,
  required,
  hint,
  error,
  className,
  children,
}: {
  /** The id of the control inside. Ids for the hint and error derive from it. */
  htmlFor: string;
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <FieldLabel htmlFor={htmlFor} required={required}>
        {label}
      </FieldLabel>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-destructive mt-1 text-xs">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p
          id={`${htmlFor}-hint`}
          className="text-muted-foreground mt-1 text-xs text-pretty"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** The `aria-describedby` for a control inside a `Field` with the same id. */
export function describedBy(
  htmlFor: string,
  options: { error?: string; hint?: boolean },
): string | undefined {
  const parts = [
    options.error ? `${htmlFor}-error` : null,
    options.hint ? `${htmlFor}-hint` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}
