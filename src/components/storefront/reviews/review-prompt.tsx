import { ReviewForm } from "@/components/storefront/reviews/review-form";

/**
 * "Your pair arrived — tell people about it", on the delivered order's page.
 *
 * One disclosure per distinct product (an order can carry two sizes of the
 * same shoe; that is one review, because reviews are per product per
 * customer). Native <details>, so the page stays calm and the keyboard gets
 * the toggle for free. A customer who already reviewed gets the database's
 * one-per-customer answer through the form, phrased as a fact rather than an
 * error.
 *
 * Rendered only when the order carries `delivered_at` — the same evidence
 * field the action's binding check reads, so the prompt and the permission
 * cannot disagree about which orders qualify.
 */
export function ReviewPrompt({
  products,
}: {
  products: { id: string; name: string }[];
}) {
  if (products.length === 0) return null;

  return (
    <section
      aria-labelledby="review-prompt-heading"
      className="border-border mt-8 rounded-lg border p-4 sm:p-6"
    >
      <h2
        id="review-prompt-heading"
        className="font-mono text-xs tracking-[0.06em] uppercase"
      >
        How did they work out?
      </h2>
      <p className="text-muted-foreground mt-2 text-sm text-pretty">
        Your order has arrived, so you can review it. Reviews on Foot Vault
        come only from customers whose pairs actually got there — that is what
        makes them worth reading.
      </p>
      <div className="mt-4 space-y-3">
        {products.map((product) => (
          <details key={product.id} className="group">
            <summary className="hit-44 relative inline-flex cursor-pointer items-center rounded-lg font-mono text-xs tracking-[0.06em] uppercase underline underline-offset-2 group-open:no-underline">
              Review {product.name}
            </summary>
            <div className="mt-3">
              <ReviewForm productId={product.id} productName={product.name} />
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
