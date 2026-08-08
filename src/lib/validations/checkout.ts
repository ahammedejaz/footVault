import { z } from "zod";

import { PAYMENT_METHODS } from "@/lib/payments/types";

/**
 * What the browser is allowed to say at checkout.
 *
 * Same rule as `cart.ts`: identifiers and the things only the customer knows —
 * where to ship it and how to reach them. No price, no total, no line, no
 * quantity. The server reads the bag for the caller's own session and
 * recomputes every rupee from the catalog, so there is no browser-supplied
 * number anywhere near the arithmetic.
 *
 * One schema, both sides. The form uses it to show a field error before a round
 * trip; the server action uses it because the form is not trusted and a POST
 * can be made without one. Two schemas would drift, and the one that drifts is
 * always the server's.
 *
 * The market is India, so the shape is Indian: a six-digit PIN, a state from a
 * closed list, and a ten-digit mobile. Loosening any of these is a business
 * decision (shipping regions) and belongs to the owner, not to this file.
 */

/* ---------------------------------------------------------------- states -- */

/**
 * All 28 states and 8 union territories.
 *
 * A closed list rather than free text: the state ends up on a shipping label
 * and in whatever the courier's API wants, and "Karnatka" is a delivery
 * failure discovered a week later. It is also what makes the field a `select`,
 * which on a phone is one tap instead of twelve characters.
 */
export const INDIAN_STATES = [
  "Andaman and Nicobar Islands",
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chandigarh",
  "Chhattisgarh",
  "Dadra and Nagar Haveli and Daman and Diu",
  "Delhi",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jammu and Kashmir",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Ladakh",
  "Lakshadweep",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Puducherry",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttar Pradesh",
  "Uttarakhand",
  "West Bengal",
] as const;

export type IndianState = (typeof INDIAN_STATES)[number];

/* ----------------------------------------------------------------- parts -- */

/**
 * Indian PIN codes are six digits and never start with zero — the first digit
 * is the postal region, numbered 1 to 8 with 9 reserved for the army postal
 * service. `[1-9]` catches a typo'd leading zero, which is the common one.
 */
export const postalCodeSchema = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]{5}$/, { message: "Enter a six-digit PIN code." });

/**
 * A ten-digit Indian mobile, with or without +91 and with any spacing.
 *
 * Normalised to the bare ten digits on the way through, so the database holds
 * one format and a support search for a number finds the order. Landlines are
 * rejected on purpose: this is the number a delivery agent calls.
 */
export const phoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s\-()]/g, ""))
  .transform((value) => value.replace(/^(\+?91)/, ""))
  .pipe(
    z.string().regex(/^[6-9][0-9]{9}$/, {
      message: "Enter a ten-digit mobile number.",
    }),
  );

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: "Enter an email we can send the receipt to." }));

/** Bounded so a paste of an entire document cannot become an address line. */
const line = (max: number, message: string) =>
  z.string().trim().min(1, { message }).max(max);

/* --------------------------------------------------------------- address -- */

export const shippingAddressSchema = z.object({
  recipientName: line(80, "Who is this going to?"),
  phone: phoneSchema,
  line1: line(120, "Enter a house or flat number and street."),
  /**
   * Empty means empty, not an empty string sitting in the snapshot.
   *
   * `nullish`, not `optional`, and the difference is not cosmetic. `optional()`
   * accepts `undefined` and **rejects `null`** — but `ShippingAddress` in
   * `src/lib/orders/types.ts` declares this field `string | null`, so every
   * caller that obeyed the published contract and sent `null` was answered with
   * `invalid_input` and no indication why. Two agents hit it independently
   * during this phase, once through the checkout form and once through
   * `placeOrder`'s save-to-address-book call. The type said one thing and the
   * validator said another; the validator is what ran.
   */
  line2: z
    .string()
    .trim()
    .max(120)
    .nullish()
    .transform((value) => (value ? value : null)),
  city: line(60, "Enter a city or town."),
  state: z.enum(INDIAN_STATES, { message: "Choose a state." }),
  postalCode: postalCodeSchema,
  // Not a choice yet. Shipping regions are the owner's call, and the shipping
  // settings in `site_settings` currently list IN and nothing else.
  country: z.literal("IN").default("IN"),
});

export type ShippingAddressInput = z.input<typeof shippingAddressSchema>;

/* -------------------------------------------------------------- checkout -- */

/**
 * The whole payload, with the rules that span fields.
 *
 * `superRefine` rather than four separate schemas because the requirements are
 * conditional on each other: an address is needed *unless* one was chosen from
 * the book, and an email is needed *unless* the caller is signed in — and the
 * server decides who is signed in, never the payload. `requireContactEmail` is
 * therefore a parameter of the factory below, not a field the browser sends.
 */
export function checkoutSchema(options: { requireContactEmail: boolean }) {
  return z
    .object({
      paymentMethod: z.enum(PAYMENT_METHODS, {
        message: "Choose how you want to pay.",
      }),
      addressId: z.uuid().optional(),
      address: shippingAddressSchema.optional(),
      contactEmail: emailSchema.optional(),
      contactPhone: phoneSchema.optional(),
      // nullish for the same reason as `line2` above: OrderView reports this
      // as `string | null`, so a round trip must be able to hand it back.
      customerNote: z
        .string()
        .trim()
        .max(500, { message: "Keep the note under 500 characters." })
        .nullish()
        .transform((value) => (value ? value : null)),
      saveAddress: z.boolean().optional().default(false),
    })
    .superRefine((value, ctx) => {
      if (!value.addressId && !value.address) {
        ctx.addIssue({
          code: "custom",
          path: ["address"],
          message: "Add a delivery address.",
        });
      }
      if (options.requireContactEmail && !value.contactEmail) {
        ctx.addIssue({
          code: "custom",
          path: ["contactEmail"],
          message: "Enter an email so we can send your order confirmation.",
        });
      }
    });
}

export type CheckoutInput = z.infer<ReturnType<typeof checkoutSchema>>;

/* ---------------------------------------------------- the client callback -- */

/**
 * The three strings Razorpay's browser callback hands back.
 *
 * Shaped here so the verify action can reject a malformed POST before it does
 * any crypto. Being well-formed proves nothing about authenticity — see
 * `ClientCallbackClaim` in `src/lib/payments/types.ts` for why the signature,
 * and then the webhook, are what actually decide.
 */
export const razorpayCallbackSchema = z.object({
  razorpay_order_id: z.string().trim().min(1).max(64),
  razorpay_payment_id: z.string().trim().min(1).max(64),
  razorpay_signature: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{64}$/, {
      message: "Malformed signature.",
    }),
});
