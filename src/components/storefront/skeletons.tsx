import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading states, built from the same measurements as the real thing.
 *
 * A skeleton whose height differs from its content is not a loading state, it
 * is a layout shift with a shimmer on it. Every box here is sized from the
 * component it stands in for — the card's 4:5 media box, the 26px name line,
 * the 16px size strip — so the page does not move when the data lands.
 *
 * `aria-hidden` throughout, with one polite "Loading" for the whole region.
 * Announcing eleven grey rectangles is worse than announcing nothing.
 */
export function ProductCardSkeleton() {
  return (
    <div aria-hidden>
      <Skeleton className="aspect-4/5 w-full rounded-lg" />
      <div className="mt-3 space-y-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-[26px] w-3/4" />
        <Skeleton className="h-[26px] w-24" />
        <Skeleton className="mt-3 h-4 w-full" />
      </div>
    </div>
  );
}

export function ProductGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 lg:grid-cols-3 xl:grid-cols-4"
    >
      <span className="sr-only">Loading products</span>
      {Array.from({ length: count }, (_, index) => (
        <ProductCardSkeleton key={index} />
      ))}
    </div>
  );
}

/** The whole listing shell: heading, control bar, rail, grid. */
export function ListingSkeleton() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:py-12">
      <div aria-hidden className="max-w-2xl">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-2 h-11 w-72" />
        <Skeleton className="mt-3 h-[26px] w-full max-w-md" />
      </div>

      <div
        aria-hidden
        className="border-border mt-8 flex flex-wrap items-center justify-between gap-3 border-b pb-4"
      >
        <div className="flex items-center gap-3">
          <Skeleton className="h-11 w-28 lg:hidden" />
          <Skeleton className="h-4 w-16" />
        </div>
        <Skeleton className="h-11 w-64" />
      </div>

      <div className="mt-8 flex gap-10">
        <div aria-hidden className="hidden w-60 shrink-0 space-y-6 lg:block">
          {[7, 8, 6].map((rows, index) => (
            <div key={index}>
              <Skeleton className="h-4 w-20" />
              <div className="mt-3 flex flex-wrap gap-2">
                {Array.from({ length: rows }, (_, i) => (
                  <Skeleton key={i} className="h-11 w-16 rounded-lg" />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <ProductGridSkeleton />
        </div>
      </div>
    </div>
  );
}

/** The 4xl display heading every storefront page opens with. */
function HeadingSkeleton({ width = "w-48" }: { width?: string }) {
  return <Skeleton aria-hidden className={`h-10 ${width}`} />;
}

/** A bag line: thumbnail, name and size, stepper, price. ~112px tall. */
function BagLineSkeleton() {
  return (
    <div aria-hidden className="flex gap-4 py-4">
      <Skeleton className="size-24 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-[22px] w-3/4" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-3 h-11 w-32 rounded-lg" />
      </div>
      <Skeleton className="h-[22px] w-16" />
    </div>
  );
}

/** The order-of-money block: rows of label/value, then a total. */
function TotalsSkeleton() {
  return (
    <div aria-hidden className="space-y-3">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex items-baseline justify-between">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
      <div className="border-border flex items-baseline justify-between border-t pt-4">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-5 w-20" />
      </div>
    </div>
  );
}

/** The bag: lines on the left, the money on the right. */
export function CartSkeleton() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <HeadingSkeleton width="w-40" />
      <div
        role="status"
        aria-live="polite"
        className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_23rem] lg:gap-10"
      >
        <span className="sr-only">Loading your bag</span>
        <div aria-hidden className="divide-border divide-y">
          {Array.from({ length: 3 }, (_, i) => (
            <BagLineSkeleton key={i} />
          ))}
        </div>
        <div aria-hidden className="border-border h-fit rounded-lg border p-5">
          <TotalsSkeleton />
          <Skeleton className="mt-5 h-13 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}

/** Checkout: address and payment on the left, the money on the right. */
export function CheckoutSkeleton() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <HeadingSkeleton width="w-52" />
      <div
        role="status"
        aria-live="polite"
        className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_23rem] lg:gap-10"
      >
        <span className="sr-only">Loading checkout</span>
        <div aria-hidden className="space-y-8">
          <div className="space-y-3">
            <Skeleton className="h-5 w-40" />
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-11 w-full rounded-lg" />
            ))}
          </div>
          <div className="space-y-3">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-20 w-full rounded-lg" />
            <Skeleton className="h-20 w-full rounded-lg" />
          </div>
        </div>
        <div aria-hidden className="border-border h-fit rounded-lg border p-5">
          <TotalsSkeleton />
          <Skeleton className="mt-5 h-13 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}

/** A stack of list rows — orders, addresses, saved items. */
export function RowListSkeleton({
  heading = "w-48",
  maxWidth = "max-w-4xl",
  rows = 4,
  rowHeight = "h-24",
  label = "Loading",
}: {
  heading?: string;
  maxWidth?: string;
  rows?: number;
  rowHeight?: string;
  label?: string;
}) {
  return (
    <div className={`mx-auto ${maxWidth} px-4 py-10 sm:px-6`}>
      <HeadingSkeleton width={heading} />
      <div role="status" aria-live="polite" className="mt-8 space-y-4">
        <span className="sr-only">{label}</span>
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton
            key={i}
            aria-hidden
            className={`${rowHeight} w-full rounded-lg`}
          />
        ))}
      </div>
    </div>
  );
}

/** An order page: the status rail, the lines, the money, the address. */
export function OrderSkeleton() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <HeadingSkeleton width="w-72" />
      <div
        role="status"
        aria-live="polite"
        className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_23rem] lg:gap-10"
      >
        <span className="sr-only">Loading this order</span>
        <div aria-hidden className="space-y-8">
          <Skeleton className="h-16 w-full rounded-lg" />
          <div className="divide-border divide-y">
            {Array.from({ length: 2 }, (_, i) => (
              <BagLineSkeleton key={i} />
            ))}
          </div>
          <div className="space-y-2">
            <Skeleton className="h-5 w-28" />
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-4 w-56" />
            ))}
          </div>
        </div>
        <div aria-hidden className="border-border h-fit rounded-lg border p-5">
          <TotalsSkeleton />
        </div>
      </div>
    </div>
  );
}

/** The product page, above the fold. */
export function ProductSkeleton() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <Skeleton aria-hidden className="h-8 w-64" />
      <div
        role="status"
        aria-live="polite"
        className="mt-6 grid gap-8 lg:grid-cols-2 lg:gap-16"
      >
        <span className="sr-only">Loading this product</span>
        <div aria-hidden>
          <Skeleton className="aspect-4/5 w-full rounded-lg" />
          <div className="mt-3 hidden gap-3 lg:flex">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="size-20 rounded-lg" />
            ))}
          </div>
        </div>
        <div aria-hidden>
          <Skeleton className="h-4 w-20" />
          <Skeleton className="mt-2 h-11 w-full max-w-sm" />
          <Skeleton className="mt-4 h-8 w-40" />
          <Skeleton className="mt-1 h-[22px] w-36" />

          <Skeleton className="mt-8 h-4 w-24" />
          <div className="mt-3 flex flex-wrap gap-2">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} className="h-11 w-32 rounded-lg" />
            ))}
          </div>

          <Skeleton className="mt-8 h-4 w-20" />
          <div className="mt-3 flex flex-wrap gap-2">
            {Array.from({ length: 7 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-12 rounded-lg" />
            ))}
          </div>
          <Skeleton className="mt-4 h-10 w-56" />

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Skeleton className="h-13 flex-1 rounded-lg" />
            <Skeleton className="h-13 flex-1 rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  );
}
