"use client";

import * as React from "react";

import { SizeSelector } from "@/components/storefront/size-selector";
import type { SizeAvailability } from "@/lib/catalog-types";

/**
 * The live selector, for /style-guide.
 *
 * The selector is controlled by the product page; the style guide has no
 * product, so this holds the state instead. Rendering a static mock-up of the
 * chips would let the guide drift from the component it documents, which is the
 * one thing a style guide must not do.
 */
export function SizeSelectorDemo({ sizes }: { sizes: SizeAvailability[] }) {
  const [selected, setSelected] = React.useState<string | null>("9");
  return (
    <>
      <h3 id="style-guide-size" className="sr-only">
        Size
      </h3>
      <SizeSelector
        sizes={sizes}
        selected={selected}
        onSelect={setSelected}
        labelledBy="style-guide-size"
      />
    </>
  );
}
