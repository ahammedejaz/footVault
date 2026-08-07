"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { INDIAN_STATES } from "@/lib/validations/checkout";
import { cn } from "@/lib/utils";

/**
 * The typed-at-checkout address.
 *
 * All strings, including `state`, because that is what a form holds. The empty
 * string is a real value here — it is what "no state chosen" looks like, and
 * `z.enum(INDIAN_STATES)` rejects it with "Choose a state." rather than the
 * form having to invent that message.
 */
export type AddressDraft = {
  recipientName: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
};

export const EMPTY_ADDRESS: AddressDraft = {
  recipientName: "",
  phone: "",
  line1: "",
  line2: "",
  city: "",
  state: "",
  postalCode: "",
};

/**
 * One id per field, derived rather than generated.
 *
 * `useId()` would be tidier, but the submit handler has to move focus to the
 * first field that failed and it only has the Zod issue path to go on. A stable
 * id is what turns `["address", "postalCode"]` back into an element.
 */
export function fieldId(name: string): string {
  return `checkout-${name}`;
}

export type FieldErrors = Partial<Record<string, string>>;

/* ------------------------------------------------------------------ field -- */

/**
 * Label, control, error, hint — in that DOM order, with the error and the hint
 * both wired into `aria-describedby`.
 *
 * The error is not a live region. On submit the handler moves focus to the
 * first bad field, and focusing an input announces its description, so a live
 * region would say the same sentence twice. On blur the customer is standing on
 * the field they just left and the message is right underneath it.
 */
export function Field({
  name,
  label,
  error,
  hint,
  optional,
  className,
  children,
}: {
  name: string;
  label: string;
  error?: string;
  hint?: string;
  optional?: boolean;
  className?: string;
  children: (props: {
    id: string;
    "aria-invalid": boolean | undefined;
    "aria-describedby": string | undefined;
  }) => React.ReactNode;
}) {
  const id = fieldId(name);
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ");

  return (
    <div className={className}>
      <Label htmlFor={id}>
        {label}
        {optional ? (
          <span className="text-muted-foreground font-normal">Optional</span>
        ) : null}
      </Label>
      <div className="mt-2">
        {children({
          id,
          "aria-invalid": error ? true : undefined,
          "aria-describedby": describedBy || undefined,
        })}
      </div>
      {error ? (
        <p id={errorId} className="text-destructive mt-1.5 text-xs text-pretty">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className="text-muted-foreground mt-1.5 text-xs text-pretty">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- address -- */

/**
 * The Indian address shape.
 *
 * Every field carries a `shipping`-prefixed autocomplete token, which is the
 * difference between a two-tap autofill and a two-minute typing job on a phone.
 * The PIN code is `inputMode="numeric"` for the same reason: it summons the
 * number pad rather than the full keyboard for six digits that can only ever be
 * digits.
 */
export function AddressFields({
  draft,
  errors,
  onChange,
  onBlurField,
  className,
}: {
  draft: AddressDraft;
  errors: FieldErrors;
  onChange: (name: keyof AddressDraft, value: string) => void;
  onBlurField: (name: keyof AddressDraft) => void;
  className?: string;
}) {
  const error = (name: keyof AddressDraft) => errors[`address.${name}`];

  return (
    <div className={cn("grid gap-4 sm:grid-cols-2", className)}>
      <Field
        name="recipientName"
        label="Full name"
        error={error("recipientName")}
        className="sm:col-span-2"
      >
        {(props) => (
          <Input
            {...props}
            name="recipientName"
            autoComplete="shipping name"
            value={draft.recipientName}
            onChange={(event) => onChange("recipientName", event.target.value)}
            onBlur={() => onBlurField("recipientName")}
          />
        )}
      </Field>

      <Field
        name="phone"
        label="Mobile number"
        error={error("phone")}
        hint="The delivery agent calls this number. Indian mobiles only."
        className="sm:col-span-2"
      >
        {(props) => (
          <Input
            {...props}
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="shipping tel-national"
            placeholder="98765 43210"
            value={draft.phone}
            onChange={(event) => onChange("phone", event.target.value)}
            onBlur={() => onBlurField("phone")}
          />
        )}
      </Field>

      <Field
        name="line1"
        label="Flat, house number and street"
        error={error("line1")}
        className="sm:col-span-2"
      >
        {(props) => (
          <Input
            {...props}
            name="line1"
            autoComplete="shipping address-line1"
            value={draft.line1}
            onChange={(event) => onChange("line1", event.target.value)}
            onBlur={() => onBlurField("line1")}
          />
        )}
      </Field>

      <Field
        name="line2"
        label="Area, landmark"
        optional
        error={error("line2")}
        className="sm:col-span-2"
      >
        {(props) => (
          <Input
            {...props}
            name="line2"
            autoComplete="shipping address-line2"
            value={draft.line2}
            onChange={(event) => onChange("line2", event.target.value)}
            onBlur={() => onBlurField("line2")}
          />
        )}
      </Field>

      <Field name="city" label="City or town" error={error("city")}>
        {(props) => (
          <Input
            {...props}
            name="city"
            autoComplete="shipping address-level2"
            value={draft.city}
            onChange={(event) => onChange("city", event.target.value)}
            onBlur={() => onBlurField("city")}
          />
        )}
      </Field>

      <Field name="postalCode" label="PIN code" error={error("postalCode")}>
        {(props) => (
          <Input
            {...props}
            name="postalCode"
            inputMode="numeric"
            maxLength={6}
            autoComplete="shipping postal-code"
            placeholder="560001"
            className="font-mono"
            value={draft.postalCode}
            onChange={(event) => onChange("postalCode", event.target.value)}
            onBlur={() => onBlurField("postalCode")}
          />
        )}
      </Field>

      <Field name="state" label="State" error={error("state")} className="sm:col-span-2">
        {(props) => (
          <Select
            {...props}
            name="state"
            autoComplete="shipping address-level1"
            value={draft.state}
            onChange={(event) => onChange("state", event.target.value)}
            onBlur={() => onBlurField("state")}
          >
            <option value="">Choose a state</option>
            {INDIAN_STATES.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </div>
  );
}
