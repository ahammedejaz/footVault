import { z } from "./z";

import { shippingAddressSchema } from "@/lib/validations/checkout";

/**
 * An address book entry — a shippable address plus the two book-only fields.
 *
 * Built by extending `shippingAddressSchema` rather than by restating it: the
 * rules that make an address deliverable in India (six-digit PIN, a state from
 * the closed list, a ten-digit mobile) belong to one schema, and a second copy
 * of them here is a second copy to forget to update. Same schema on both sides
 * of the wire, for the reason given at the top of `checkout.ts`.
 */
export const addressBookSchema = shippingAddressSchema.extend({
  /**
   * `nullish`, not `optional` — and this is the interesting line in the file.
   *
   * `z.string().optional()` accepts `undefined` and **rejects `null`**, while
   * the transform below emits `null`. So anything that parses an address, hands
   * the result to something else, and lets that parse it again fails on exactly
   * the fields the customer left blank. That is not hypothetical: it bit the
   * checkout form (empty landmark line, silent refusal to submit) and then bit
   * `placeOrder`, which calls `saveAddress({ ...address, label: null })` and had
   * its "save this address for next time" quietly do nothing.
   *
   * A write path shared by a form and another module has to accept both spellings
   * of "absent". `line2` is overridden here for the same reason; the version in
   * `shippingAddressSchema` is `optional` and is not mine to change.
   */
  line2: z
    .string()
    .trim()
    .max(120)
    .nullish()
    .transform((value) => (value ? value : null)),
  /**
   * Bounded and absent-able. A label is a memory aid for a list of three, not a
   * field worth making anyone fill in — most entries will have none.
   */
  label: z
    .string()
    .trim()
    .max(40, { message: "Keep the label under 40 characters." })
    .nullish()
    .transform((value) => (value ? value : null)),
  isDefault: z.boolean().optional().default(false),
});

/**
 * The same entry, plus which row it is.
 *
 * A separate schema rather than an optional `id` on `addressBookSchema`,
 * because the two write paths must not be able to become each other by
 * accident. `saveAddress` is called by `placeOrder` with whatever the checkout
 * held ("save this address for next time"); if an `id` were merely optional,
 * a payload that carried one — forged, or copied from a stale form — would
 * turn an insert into an overwrite of an existing entry. RLS would keep it to
 * the customer's *own* rows, so the damage would be quiet: one address
 * silently replaced by another rather than added.
 *
 * Two schemas make that a parse failure instead of a behaviour change.
 */
export const addressEditSchema = addressBookSchema.extend({
  id: z.uuid(),
});

export type AddressEditInput = z.input<typeof addressEditSchema>;

export type AddressBookInput = z.input<typeof addressBookSchema>;
