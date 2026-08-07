"use client";

import * as React from "react";

/**
 * Read one query parameter, without making the route dynamic.
 *
 * `useSearchParams` would do this, and would also opt the whole route out of
 * static rendering — which on the product page means a database round trip in
 * front of the LCP image on the most important screen on the site.
 *
 * `useSyncExternalStore` is the exact tool for the shape of this problem: the
 * server has no URL parameters to read, so `getServerSnapshot` returns null and
 * the prerendered HTML shows nothing selected; the client reads the real value
 * on the first render after hydration. React knows the two differ on purpose,
 * so there is no hydration warning and no effect that sets state a frame late.
 *
 * The subscription is `popstate`, so going back to a link with `?size=9` still
 * reflects it. `replaceState` does not fire `popstate`, which is correct here:
 * when this component writes the URL it already holds the value in its own
 * state.
 */
function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

export function useUrlParam(key: string): string | null {
  return React.useSyncExternalStore(
    subscribe,
    React.useCallback(
      () => new URLSearchParams(window.location.search).get(key),
      [key],
    ),
    () => null,
  );
}
