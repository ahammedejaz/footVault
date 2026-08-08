"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { Search } from "lucide-react";

import { useReturnFocus } from "@/hooks/use-return-focus";
import { Button } from "@/components/ui/button";

/**
 * The search entry point, and nothing else.
 *
 * The overlay behind it is a dialog, a debounced fetch, a result list and a
 * portal — none of which any customer needs downloaded, parsed and executed
 * before the page they asked for has painted. It is loaded on the first click.
 *
 * That is not a micro-optimisation here: the four overlays on this site (search,
 * the mobile menu, the filter sheet, the size guide) were the largest single
 * block of JavaScript on the critical path, and Lighthouse was holding LCP
 * until the main thread finished with them.
 *
 * The button itself is server-rendered markup with an event handler, so it
 * works from the first frame — the only thing that arrives late is the panel,
 * and it arrives while the finger is still on the way down.
 */
const SearchPanel = dynamic(
  () =>
    import("@/components/storefront/search-panel").then((m) => m.SearchPanel),
  { ssr: false },
);

export function SearchButton({
  popular,
}: {
  popular: Array<{ label: string; href: string }>;
}) {
  // `mounted` stays true once opened, so closing and reopening does not refetch
  // the chunk.
  const [open, setOpen] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const trigger = useReturnFocus(open);

  return (
    <>
      <Button
        ref={trigger}
        variant="ghost"
        size="icon"
        aria-label="Search"
        onPointerDown={() => setMounted(true)}
        onFocus={() => setMounted(true)}
        onClick={() => {
          setMounted(true);
          setOpen(true);
        }}
      >
        <Search />
      </Button>
      {mounted ? (
        <SearchPanel open={open} onOpenChange={setOpen} popular={popular} />
      ) : null}
    </>
  );
}
