"use client";

import dynamic from "next/dynamic";

/**
 * Keeps the filter sheet out of the first-load bundle.
 *
 * `next/dynamic` with `ssr: false` can only be called from a Client Component,
 * and filter-panel.tsx is a Server Component — every facet in it is a link, so
 * it has no reason to be anything else. This one-line client boundary is what
 * lets the server-rendered panel opt its own overlay out of the critical path.
 *
 * The children are server-rendered facet links, passed straight through.
 */
const FilterSheet = dynamic(
  () =>
    import("@/components/storefront/filter-sheet").then((m) => m.FilterSheet),
  { ssr: false },
);

export function FilterSheetLoader(
  props: React.ComponentProps<typeof FilterSheet>,
) {
  return <FilterSheet {...props} />;
}
