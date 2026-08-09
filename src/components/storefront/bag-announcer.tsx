"use client";

import { useState } from "react";

import { useDisplayedBagCount } from "@/lib/stores/bag";

/**
 * "3 items in your bag", said out loud, only when it changes.
 *
 * The badge is `aria-hidden` and folded into the bag link's name, which covers
 * a customer who goes looking. It does not cover the case the brief is actually
 * about: adding something from a product page, where the thing that changed is
 * in a corner of the screen nobody is pointed at.
 *
 * A live region that simply printed the count would announce on every
 * navigation, because the header re-renders and the text is "new" each time.
 * That is worse than silence — it trains people to ignore it. So the previous
 * count is remembered and the region is empty unless the number actually moved.
 *
 * Compared during render rather than in an effect: an effect would announce one
 * frame late, and on a slow phone that is after the toast has already spoken.
 */
export function BagAnnouncer({ count }: { count: number }) {
  // Announce optimistic changes too: with addToBag no longer revalidating the
  // layout, the server prop stays put until a navigation, and a screen-reader
  // user still has to hear the add they just made.
  const shown = useDisplayedBagCount(count);
  const [seen, setSeen] = useState(shown);

  if (shown !== seen) setSeen(shown);

  return (
    <p aria-live="polite" aria-atomic="true" className="sr-only">
      {shown === seen ? "" : phrase(shown)}
    </p>
  );
}

function phrase(count: number): string {
  if (count === 0) return "Your bag is empty.";
  return count === 1 ? "1 item in your bag." : `${count} items in your bag.`;
}
