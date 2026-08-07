"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Put the customer back where they were.
 *
 * Tapping the tenth card and coming back to the top of the grid is the single
 * most irritating thing a listing page does, and it is not something the router
 * can always fix on its own: a listing with a `loading.tsx` unmounts the grid
 * on the way out, so there is no scroll height to restore into when the back
 * navigation lands, and the browser gives up.
 *
 * Keyed by the full URL including the query, so page 3 filtered to size 9
 * restores to its own position and not to page 1's.
 *
 * sessionStorage rather than a module variable: a hard reload of the product
 * page, then back, still lands in the right place. It is cleared with the tab,
 * which is the right lifetime for "where I was ten seconds ago".
 */
export function ScrollRestore() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const key = `fv:scroll:${pathname}?${searchParams.toString()}`;

  React.useEffect(() => {
    // The browser's own restoration runs first and would fight this one.
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";

    const saved = Number(sessionStorage.getItem(key) ?? "0");
    if (saved > 0) {
      // Two frames: the first lets the grid paint, the second lets images with
      // reserved aspect ratios settle, so the target offset actually exists.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => window.scrollTo(0, saved)),
      );
    }

    const save = () => sessionStorage.setItem(key, String(window.scrollY));
    // pagehide covers the bfcache path that visibilitychange misses on iOS.
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", save);
    return () => {
      save();
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", save);
      if ("scrollRestoration" in history) history.scrollRestoration = "auto";
    };
  }, [key]);

  return null;
}
