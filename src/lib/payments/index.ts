import "server-only";

import { codAdapter } from "@/lib/payments/cod";
import { razorpayAdapter } from "@/lib/payments/razorpay";
import {
  PAYMENT_METHODS,
  type PaymentAdapter,
  type PaymentMethod,
  type PaymentMethodCopy,
} from "@/lib/payments/types";

/**
 * The only way to reach a payment adapter.
 *
 * Everything outside this directory imports from here or from `./types`, never
 * from `./razorpay` — so the day a second card provider is added, the change is
 * one entry in the record below and nothing else in the codebase knows.
 *
 * **`server-only`.** Reaching an adapter means reaching a key secret one import
 * away, and a Client Component that imports this file should be a build error
 * rather than a bundle to grep. That has a consequence for the checkout page:
 * `availablePaymentMethods()` must be called in a Server Component and the
 * result passed down as a prop. `PaymentMethodCopy` is plain serialisable data
 * declared in `./types`, which has no server dependency, so it crosses that
 * boundary cleanly. This is also the reason the key id is handed over inside
 * `PaymentInitiation` instead of as a `NEXT_PUBLIC_` variable — see
 * `./config.ts`.
 */

const ADAPTERS: Readonly<Record<PaymentMethod, PaymentAdapter>> = {
  cod: codAdapter,
  razorpay: razorpayAdapter,
} as const;

/**
 * The adapter for a method. Total over `PaymentMethod`, so there is no null to
 * handle: an unknown string cannot reach here, because `PaymentMethod` is a
 * union and `isPaymentMethod()` in `./types` is what turns a request body into
 * one.
 *
 * This does **not** check `isAvailable()`. Availability is a question about
 * whether to *offer* a method; a webhook for a method that was configured an
 * hour ago and is not now still has to be parsed and applied, or a shop that
 * rotates a key loses the payments in flight.
 */
export function getPaymentAdapter(method: PaymentMethod): PaymentAdapter {
  return ADAPTERS[method];
}

/**
 * What checkout may offer, in the order it should be shown.
 *
 * Filtered on `isAvailable()`, which is the load-bearing part: Razorpay with no
 * keys configured must not appear as a radio button. A customer who picks a
 * method that cannot work has been failed twice — once by the missing
 * configuration and once by being invited to choose it.
 *
 * The order is the order of `PAYMENT_METHODS`, so the choice does not reshuffle
 * between renders or between environments.
 */
export function availablePaymentMethods(): PaymentMethodCopy[] {
  return PAYMENT_METHODS.filter((method) => ADAPTERS[method].isAvailable()).map(
    (method) => ADAPTERS[method].copy,
  );
}

/** Is this method usable right now? The checkout action's guard before it initiates. */
export function isPaymentMethodAvailable(method: PaymentMethod): boolean {
  return ADAPTERS[method].isAvailable();
}
