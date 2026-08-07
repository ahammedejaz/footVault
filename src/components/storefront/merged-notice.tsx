"use client";

/**
 * "Your bag came with you."
 *
 * Something arrived in the customer's bag during a redirect they did not watch,
 * and the count may have changed for reasons they never saw — a line already in
 * their account bag, a quantity capped at what is left. Saying so on arrival is
 * the difference between a merge that feels like a feature and one that feels
 * like a bug.
 *
 * `role="status"` rather than an alert: it is worth hearing, and it is not
 * urgent enough to interrupt.
 */
export function MergedNotice({ count }: { count: number }) {
  return (
    <p
      role="status"
      className="border-state-stock/40 bg-state-stock/5 mt-6 rounded-lg border p-4 text-sm text-pretty"
    >
      {count === 1
        ? "The item you added before signing in is here."
        : `The ${count} items you added before signing in are here.`}{" "}
      Anything already saved to your account has been combined with them.
    </p>
  );
}
