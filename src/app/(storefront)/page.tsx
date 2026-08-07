import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Phase 0 renders the hero shell only.
 *
 * From Phase 7 this page renders whatever is in `homepage_sections`, in that
 * order, so the owner controls it end to end. Nothing below fakes a product
 * rail in the meantime — an invented catalog would only have to be deleted.
 */
export default function HomePage() {
  return (
    <>
      <section
        data-surface="ink"
        className="relative isolate overflow-hidden"
        aria-labelledby="hero-heading"
      >
        <div
          className="tread-texture pointer-events-none absolute inset-0"
          aria-hidden="true"
        />
        <div className="relative mx-auto grid max-w-7xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:items-center lg:gap-16 lg:py-28">
          <div>
            <p className="text-orange font-mono text-xs tracking-[0.06em] uppercase">
              Foot Vault
            </p>
            <h1
              id="hero-heading"
              className="font-display mt-5 text-4xl font-extrabold tracking-[-0.03em] uppercase lg:text-6xl"
            >
              Every step
              <br />
              counts
            </h1>
            <p className="text-muted-foreground mt-5 max-w-md text-base">
              Sneakers, formal shoes, boots and sandals for men, women and kids.
              Every size we hold, shown on every product.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <Link href="/shop">Shop all footwear</Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link href="/style-guide">View the design system</Link>
              </Button>
            </div>
          </div>

          <div
            className="border-border/40 bg-ink-soft/60 hidden aspect-[4/3] items-center justify-center rounded-lg border lg:flex"
            aria-hidden="true"
          >
            <p className="text-muted-foreground px-8 text-center font-mono text-xs tracking-[0.06em]">
              Hero image — uploaded by the owner from /admin/appearance in
              Phase&nbsp;7, with separate mobile and desktop crops
            </p>
          </div>
        </div>
      </section>

      <div className="tread-rule" aria-hidden="true" />

      <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        <h2 className="font-display text-2xl font-bold tracking-[-0.02em] uppercase">
          The shell is up
        </h2>
        <p className="text-muted-foreground mt-3 max-w-2xl text-base">
          Design tokens, the three type roles, the restyled primitives and the
          base layout are in place. The catalog arrives in Phase 3 and this page
          becomes owner-editable in Phase 7.
        </p>
      </section>
    </>
  );
}
