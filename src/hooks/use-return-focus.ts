"use client";

import * as React from "react";

/**
 * Put focus back where it came from when an overlay closes.
 *
 * Radix restores focus to whatever it captured when the dialog mounted — but
 * these overlays are dynamically imported, so the panel mounts a tick *after*
 * the click that opened it, and what it captures is whatever the browser had
 * moved to by then. Closing the size guide with Escape dropped focus onto the
 * document body, which strands a keyboard user at the top of the page.
 *
 * Focusing an element is a write to the DOM, not a state update, which is
 * exactly what an effect is for.
 */
export function useReturnFocus(open: boolean) {
  const trigger = React.useRef<HTMLButtonElement | null>(null);
  const wasOpen = React.useRef(false);

  React.useEffect(() => {
    if (wasOpen.current && !open) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);

  return trigger;
}
