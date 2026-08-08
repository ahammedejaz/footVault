"use client";

/**
 * The Razorpay checkout script, typed.
 *
 * Razorpay ships no types for the browser bundle, so the surface this codebase
 * actually uses is declared here. The alternative is `any` at the one place in
 * the app where money moves, which the house rules forbid for exactly this kind
 * of code.
 *
 * Note what is in `RazorpayOptions` and what is not. `amount` and `order_id`
 * come from the server's `PaymentInitiation` and are never assembled in the
 * browser; `key` is the publishable half of the key pair. There is no secret
 * here and there must never be one — everything Razorpay is told from this file
 * is visible in devtools by design.
 */

export const RAZORPAY_CHECKOUT_SRC =
  "https://checkout.razorpay.com/v1/checkout.js";

/** The three strings the browser gets back, and the only ones worth reading. */
export type RazorpaySuccess = {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
};

export type RazorpayFailure = {
  error?: {
    code?: string;
    description?: string;
    reason?: string;
    step?: string;
    source?: string;
  };
};

export type RazorpayOptions = {
  key: string;
  /** Integer paise. Razorpay's unit is ours, so nothing is converted. */
  amount: number;
  currency: string;
  order_id: string;
  name: string;
  description?: string;
  prefill?: { name?: string; email?: string; contact?: string };
  notes?: Record<string, string>;
  theme?: { color?: string };
  modal?: { ondismiss?: () => void };
  handler: (response: RazorpaySuccess) => void;
};

export interface RazorpayInstance {
  open(): void;
  close(): void;
  on(
    event: "payment.failed",
    handler: (response: RazorpayFailure) => void,
  ): void;
}

export type RazorpayConstructor = new (
  options: RazorpayOptions,
) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

/**
 * Wait for the script `next/script` is fetching, and give up out loud.
 *
 * The tag is rendered with `strategy="lazyOnload"`, so on a slow connection a
 * customer can reach the pay button before the script has landed. Polling
 * covers that gap without blocking the page load, and the null return is the
 * honest outcome the caller has to handle: the order already exists by the time
 * this is called, so "the modal never opened" is a state that needs its own
 * sentence rather than a spinner that never stops.
 *
 * Eight seconds because a customer staring at a dead button for longer than
 * that has already decided the shop is broken.
 */
export async function waitForRazorpay(
  timeoutMs = 8_000,
): Promise<RazorpayConstructor | null> {
  if (typeof window === "undefined") return null;
  if (window.Razorpay) return window.Razorpay;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (window.Razorpay) return window.Razorpay;
  }
  return null;
}
