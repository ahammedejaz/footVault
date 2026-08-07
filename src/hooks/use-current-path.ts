"use client";

import { useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

/**
 * Where the customer is standing, query string included.
 *
 * Sign-in has to come back to the exact place it left — `?size=9` on a product
 * page is part of where you were, not decoration — and `usePathname()` alone
 * drops it. `useSearchParams()` keeps it but pulls a Suspense boundary onto
 * every component that reads it, and this one is in the header.
 *
 * So the location is read as what it is: external, mutable state owned by the
 * browser. `useSyncExternalStore` is the primitive for that, and it hydrates
 * cleanly — React uses the server snapshot for the first client render, so
 * there is no mismatch to paper over and no state set from an effect.
 */
const subscribe = (onStoreChange: () => void) => {
  window.addEventListener("popstate", onStoreChange);
  return () => window.removeEventListener("popstate", onStoreChange);
};

const getSnapshot = () => window.location.pathname + window.location.search;

export function useCurrentPath(): string {
  // Load-bearing: `popstate` fires on back and forward but not on a pushState,
  // which is every in-app navigation. Subscribing to the router as well is what
  // makes the snapshot above re-read after a Link click.
  const pathname = usePathname();
  const href = useSyncExternalStore(subscribe, getSnapshot, () => pathname);

  // If the snapshot has not caught up with the router yet, the router wins —
  // sending somebody back to the page they were on beats sending them back to
  // the page they were on a moment ago.
  return href.split("?")[0] === pathname ? href : pathname;
}
