"use client";

import { useRef, useState, useTransition } from "react";
import { Pencil, Plus, Star, Trash2 } from "lucide-react";

import { AddressCard } from "@/components/checkout/address-card";
import {
  AddressFields,
  EMPTY_ADDRESS,
  Field,
  fieldId,
  type AddressDraft,
  type FieldErrors,
} from "@/components/checkout/address-fields";
import { CheckRow } from "@/components/checkout/check-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  deleteAddress,
  saveAddress,
  setDefaultAddress,
  updateAddress,
} from "@/lib/actions/address";
import type { SavedAddress } from "@/lib/address-types";
import { toast } from "@/lib/toast";
import {
  addressBookSchema,
  addressEditSchema,
} from "@/lib/validations/address";

/**
 * The address book, managed.
 *
 * Removing offers an undo rather than a confirmation dialog — the same trade
 * the bag makes, for the same reason: a dialog charges every removal a decision
 * to protect against the rare wrong one. The undo works because the entry is
 * only ever a convenience. What ships is the snapshot on the order, so a
 * removed-and-restored address is a new row and nothing downstream notices.
 *
 * The form is the same `AddressFields` the checkout uses, validated with the
 * same schema plus a label. A second address form would be a second set of PIN
 * code rules to keep in step.
 */
export function AddressBook({ addresses }: { addresses: SavedAddress[] }) {
  const [adding, setAdding] = useState(addresses.length === 0);
  /**
   * Which entry the open form is editing, or null when it is adding one.
   *
   * The id rather than the row: `addresses` is re-fetched by the revalidate
   * after every write, so holding the object would pin a stale copy of the
   * entry being edited — the version from before the save, shown back to the
   * customer as though it were current.
   */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AddressDraft>(EMPTY_ADDRESS);
  const [label, setLabel] = useState("");
  const [makeDefault, setMakeDefault] = useState(addresses.length === 0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [attempted, setAttempted] = useState(false);
  const [pending, startTransition] = useTransition();

  /** Focus returns here when the form closes, rather than to the document. */
  const addButton = useRef<HTMLButtonElement>(null);

  /**
   * The schema's *input* shape. `line2` must be `undefined` when it is blank,
   * never `null` — the schema turns undefined into null on the way through, and
   * feeding it a null makes `z.string()` reject a field the customer chose to
   * leave empty. Same trap as `currentAddress()` in `checkout-flow.tsx`.
   */
  function toEntry() {
    return {
      recipientName: draft.recipientName,
      phone: draft.phone,
      line1: draft.line1,
      line2: draft.line2.trim() ? draft.line2 : undefined,
      city: draft.city,
      state: draft.state,
      postalCode: draft.postalCode,
      country: "IN" as const,
      label: label.trim() || undefined,
      isDefault: makeDefault,
    };
  }

  function validateField(name: keyof AddressDraft) {
    if (!attempted && !draft[name].trim()) return;
    const parsed = addressBookSchema.safeParse(toEntry());
    const issue = parsed.success
      ? undefined
      : parsed.error.issues.find((entry) => entry.path[0] === name);
    setErrors((previous) => ({
      ...previous,
      [`address.${name}`]: issue?.message,
    }));
  }

  function reset() {
    setDraft(EMPTY_ADDRESS);
    setLabel("");
    setErrors({});
    setAttempted(false);
    setEditingId(null);
  }

  /** Open the form over an existing entry. */
  function beginEdit(address: SavedAddress) {
    setDraft({
      recipientName: address.recipientName,
      phone: address.phone,
      line1: address.line1,
      // The form's fields are strings throughout; `null` would render the word.
      line2: address.line2 ?? "",
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
    });
    setLabel(address.label ?? "");
    setMakeDefault(address.isDefault);
    setErrors({});
    setAttempted(false);
    setEditingId(address.id);
    setAdding(true);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAttempted(true);

    const parsed = editingId
      ? addressEditSchema.safeParse({ ...toEntry(), id: editingId })
      : addressBookSchema.safeParse(toEntry());
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key =
          issue.path[0] === "label"
            ? "label"
            : `address.${String(issue.path[0])}`;
        if (!next[key]) next[key] = issue.message;
      }
      setErrors(next);
      const first = parsed.error.issues[0];
      if (first)
        document.getElementById(fieldId(String(first.path[0])))?.focus();
      return;
    }

    setErrors({});
    startTransition(async () => {
      // The *raw* entry, not `parsed.data`. Parsing here turns an empty
      // landmark line into `null`, and feeding that back into the same schema
      // on the server fails — `.optional()` accepts `undefined`, not `null`.
      // The client parse is a pre-check; the server does the real one.
      const result = editingId
        ? await updateAddress({ ...toEntry(), id: editingId })
        : await saveAddress(toEntry());
      if (!result.ok) {
        toast.failed(result.message);
        return;
      }
      const edited = editingId !== null;
      reset();
      setAdding(false);
      setMakeDefault(false);
      toast.done(edited ? "Address updated" : "Address saved");
      addButton.current?.focus();
    });
  }

  function promote(address: SavedAddress) {
    startTransition(async () => {
      const result = await setDefaultAddress(address.id);
      if (!result.ok) {
        toast.failed(result.message);
        return;
      }
      toast.done(
        "Default address changed",
        address.label ?? address.recipientName,
      );
    });
  }

  function remove(address: SavedAddress) {
    startTransition(async () => {
      const result = await deleteAddress(address.id);
      if (!result.ok) {
        toast.failed(result.message);
        return;
      }

      toast.undoable(
        "Address removed",
        address.label ?? address.recipientName,
        () => {
          startTransition(async () => {
            const back = await saveAddress({
              recipientName: address.recipientName,
              phone: address.phone,
              line1: address.line1,
              line2: address.line2 ?? undefined,
              city: address.city,
              state: address.state,
              postalCode: address.postalCode,
              country: address.country,
              label: address.label ?? undefined,
              isDefault: address.isDefault,
            });
            if (!back.ok) {
              toast.failed(back.message);
              return;
            }
            toast.done("Address restored");
          });
        },
      );
    });
  }

  return (
    <div className={pending ? "opacity-70" : undefined}>
      {addresses.length > 0 ? (
        <ul className="mt-8 space-y-4">
          {addresses.map((address) => (
            <li
              key={address.id}
              className="border-border rounded-lg border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  {address.label ? (
                    <p className="font-mono text-xs tracking-[0.06em] uppercase">
                      {address.label}
                    </p>
                  ) : null}
                  <div className={address.label ? "mt-2" : undefined}>
                    <AddressCard address={address} />
                  </div>
                </div>

                {address.isDefault ? (
                  <span className="bg-foreground text-background shrink-0 rounded-4xl px-3 py-1 font-mono text-xs tracking-[0.06em] uppercase">
                    Default
                  </span>
                ) : null}
              </div>

              <div className="border-border mt-4 flex flex-wrap gap-2 border-t pt-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => beginEdit(address)}
                  disabled={pending}
                >
                  <Pencil className="size-3.5" aria-hidden />
                  Edit
                  <span className="sr-only"> — {address.recipientName}</span>
                </Button>
                {address.isDefault ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => promote(address)}
                    disabled={pending}
                  >
                    <Star className="size-3.5" aria-hidden />
                    Make default
                    <span className="sr-only"> — {address.recipientName}</span>
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => remove(address)}
                  disabled={pending}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  Remove
                  <span className="sr-only"> — {address.recipientName}</span>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {adding ? (
        <form
          onSubmit={submit}
          noValidate
          className="border-border mt-8 rounded-lg border p-5"
        >
          <h2 className="text-lg font-semibold">
            {editingId ? "Edit address" : "Add an address"}
          </h2>

          <Field
            name="label"
            label="Name this address"
            optional
            className="mt-4 max-w-xs"
            error={errors["label"]}
            hint="Home, Office — whatever you will recognise at checkout."
          >
            {(props) => (
              <Input
                {...props}
                name="label"
                maxLength={40}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            )}
          </Field>

          <AddressFields
            className="mt-4"
            draft={draft}
            errors={errors}
            onChange={(name, value) =>
              setDraft((previous) => ({ ...previous, [name]: value }))
            }
            onBlurField={validateField}
          />

          <div className="mt-4">
            <CheckRow
              name="isDefault"
              checked={makeDefault}
              onChange={setMakeDefault}
              label="Use this address by default"
              hint="It is the one checkout preselects."
            />
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <Button type="submit" disabled={pending}>
              {pending
                ? "Saving…"
                : editingId
                  ? "Save changes"
                  : "Save address"}
            </Button>
            {addresses.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  reset();
                  setAdding(false);
                  addButton.current?.focus();
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      ) : (
        <Button
          ref={addButton}
          variant="outline"
          className="mt-8"
          onClick={() => setAdding(true)}
        >
          <Plus className="size-4" aria-hidden />
          Add an address
        </Button>
      )}
    </div>
  );
}
