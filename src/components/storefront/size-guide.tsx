"use client";

import * as React from "react";
import dynamic from "next/dynamic";

import { useReturnFocus } from "@/hooks/use-return-focus";
import type { Gender } from "@/lib/catalog-types";

/**
 * The size-guide link. The table behind it loads when it is asked for.
 *
 * The conversions, the measuring instructions and the dialog machinery are of
 * no use to the customer who already knows they are a 9 — which is most of
 * them — and they were sitting in the product page's first-load bundle.
 */
const SizeGuidePanel = dynamic(
  () =>
    import("@/components/storefront/size-guide-panel").then(
      (m) => m.SizeGuidePanel,
    ),
  { ssr: false },
);

export function SizeGuide({
  gender,
  highlight,
}: {
  gender: Gender;
  highlight?: string | null;
}) {
  const [open, setOpen] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const trigger = useReturnFocus(open);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="text-orange-ink inline-flex min-h-11 items-center text-sm underline underline-offset-4"
        onPointerDown={() => setMounted(true)}
        onFocus={() => setMounted(true)}
        onClick={() => {
          setMounted(true);
          setOpen(true);
        }}
      >
        Size guide
      </button>
      {mounted ? (
        <SizeGuidePanel
          gender={gender}
          highlight={highlight}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}
