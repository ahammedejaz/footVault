"use client";

import * as React from "react";

import { toast } from "@/lib/toast";

/**
 * A one-shot toast for something that happened during a redirect.
 *
 * Signing out is the case it was built for: the customer presses a menu item,
 * the page changes underneath them, and until Phase 7 nothing said whether it
 * had worked. The evidence was the header quietly becoming a stranger's.
 *
 * **Why a query parameter and not a cookie.** A flash cookie is the tidier
 * mechanism, and it is not available here: a Server Component cannot delete a
 * cookie, so the flag would outlive the arrival it describes and toast again on
 * the next render of any page in the layout. The parameter is read once, raised
 * once, and removed from the URL with `replaceState` — so a refresh is silent,
 * the back button does not replay it, and nothing anybody would bookmark
 * carries it.
 *
 * **`window.location` rather than `useSearchParams`.** Reading search params
 * through the hook opts every route under this layout out of static rendering.
 * These routes are already dynamic for other reasons, but the dependency is one
 * nobody should have to remember, and the value is wanted exactly once after
 * mount rather than on every change.
 *
 * The effect guards on a ref rather than on the dependency array, because React
 * mounts twice in development and a toast that appears in pairs reads as a bug
 * in the thing being confirmed.
 */

const MESSAGES: Record<string, { message: string; description?: string }> = {
  "signed-out:1": {
    message: "Signed out",
    description: "Your bag stays on this device. Sign in again to sync it.",
  },
  "signed-out:failed": {
    message: "You may still be signed in",
    description: "Signing out did not complete. Try again in a moment.",
  },
};

export function FlashToast() {
  const raised = React.useRef(false);

  React.useEffect(() => {
    if (raised.current) return;

    const url = new URL(window.location.href);
    const key = [...url.searchParams.entries()]
      .map(([name, value]) => `${name}:${value}`)
      .find((candidate) => candidate in MESSAGES);
    if (!key) return;

    raised.current = true;
    const flash = MESSAGES[key]!;
    if (key.endsWith(":failed")) toast.failed(flash.message);
    else toast.done(flash.message, flash.description);

    url.searchParams.delete(key.split(":")[0]!);
    const query = url.searchParams.toString();
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${query ? `?${query}` : ""}`,
    );
  }, []);

  return null;
}
