import { z } from "./z";

/**
 * What the browser is allowed to say about a bag.
 *
 * Identifiers and quantities. No price, ever — the server reads that from the
 * catalog, and a schema that accepted a price would be an invitation to send
 * one. This file is the whole vocabulary of the client half of the cart.
 *
 * Shared by both sides so the form and the action cannot drift: the client uses
 * it to disable a button, the server uses it because the client is not trusted.
 */

/** One order cannot take a shop's entire run of a size through the bag UI. */
export const MAX_LINE_QUANTITY = 10;

export const variantIdSchema = z.uuid({ message: "That is not a valid size." });

export const addToBagSchema = z.object({
  variantId: variantIdSchema,
  quantity: z.coerce
    .number()
    .int()
    .min(1, { message: "Choose at least one." })
    .max(MAX_LINE_QUANTITY, { message: `Up to ${MAX_LINE_QUANTITY} per size.` })
    .default(1),
});

export const setQuantitySchema = z.object({
  itemId: z.uuid(),
  // Zero is a legitimate quantity here: it is how the stepper removes a line.
  quantity: z.coerce.number().int().min(0).max(MAX_LINE_QUANTITY),
});

export const removeLineSchema = z.object({ itemId: z.uuid() });

export type AddToBagInput = z.infer<typeof addToBagSchema>;
