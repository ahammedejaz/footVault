"use client";

import * as React from "react";

import { create } from "zustand";

import type { Cart } from "@/lib/cart-types";

/**
 * The bag drawer's open state, and nothing else.
 *
 * This file used to hold the badge counts, persisted to localStorage, waiting
 * for Phase 4 to write to them. Phase 4 did not: the bag now lives in the
 * `carts` table, so the count is a fact the server already knows on every
 * render. Keeping a second copy in localStorage would have made a stale number
 * possible — the one thing a bag badge must never be — and would have
 * disagreed with a bag that had been merged, capped or emptied on another
 * device. The counts are props from the server now.
 *
 * What is left is genuine client state with no server opinion: whether the
 * drawer is open. It is shared because three different places open it — the bag
 * icon in the header, the add-to-bag button, and the "view bag" action on the
 * toast — and none of them is an ancestor of the drawer.
 *
 * The drawer's *contents* live here too, and the fetch is a store action rather
 * than an effect in the component. That is not a workaround: opening the drawer
 * is an event, and fetching in the event that caused it is what React actually
 * wants. Doing it in an effect keyed on `open` means a synchronous setState
 * reachable from an effect, which cascades renders — and it puts the trigger
 * one indirection away from the thing that triggered it.
 *
 * `refresh()` is a no-op while the drawer is closed: a mutation from a product
 * card should not fetch a panel nobody is looking at. Opening always refetches,
 * so what it shows is never older than the tap that opened it.
 */
type BagUiState = {
  drawerOpen: boolean;
  cart: Cart | null;
  failed: boolean;
  openDrawer: () => void;
  setDrawerOpen: (open: boolean) => void;
  /** Re-read the bag from the server. Call after any mutation. */
  refresh: () => Promise<void>;

  /**
   * The badge's optimistic half. The server count is still the authority —
   * the note above about localStorage stands — but it now arrives only with a
   * navigation, because the cart actions stopped revalidating the whole
   * layout (the ~340 ms that made adding feel slow). What changed in between
   * is tracked as a *delta*, never as a count of its own: the badge shows
   * `server + delta`, and the moment a fresh server count arrives the delta
   * is retired and the fact wins — so a bag merged, capped or emptied on
   * another device can be wrong on this one for at most one navigation,
   * which is exactly the staleness the layout revalidate had anyway.
   */
  delta: number;
  /** An optimistic change of `by` units. */
  bump: (by: number) => void;
  /** A fresh server count arrived; the delta has been absorbed or disproved. */
  settle: () => void;
};

async function readCart(): Promise<Cart> {
  const response = await fetch("/api/cart", { cache: "no-store" });
  if (!response.ok) throw new Error(`GET /api/cart -> ${response.status}`);
  return (await response.json()) as Cart;
}

export const useBagUi = create<BagUiState>()((set, get) => ({
  drawerOpen: false,
  cart: null,
  failed: false,

  openDrawer: () => {
    set({ drawerOpen: true });
    void get().refresh();
  },

  setDrawerOpen: (drawerOpen) => {
    set({ drawerOpen });
    if (drawerOpen) void get().refresh();
  },

  refresh: async () => {
    if (!get().drawerOpen) return;
    try {
      set({ cart: await readCart(), failed: false });
    } catch (error) {
      console.error("[bag] could not read the bag:", error);
      set({ failed: true });
    }
  },

  delta: 0,
  bump: (by) => set((state) => ({ delta: state.delta + by })),
  settle: () => set({ delta: 0 }),
}));

/**
 * What the badge should show: the server's count plus the optimistic delta.
 * A server count that moved underneath (another tab, a merge, a navigation)
 * retires the delta and wins untouched.
 */
export function useDisplayedBagCount(serverCount: number): number {
  const delta = useBagUi((state) => state.delta);
  const settle = useBagUi((state) => state.settle);

  // The server spoke: a changed count has absorbed (or disproved) the delta,
  // and the fact wins. A layout effect so the retirement happens before
  // paint — the alternative is one frame of double counting after every
  // navigation that followed an add.
  const previous = React.useRef(serverCount);
  React.useLayoutEffect(() => {
    if (previous.current !== serverCount) {
      previous.current = serverCount;
      settle();
    }
  }, [serverCount, settle]);

  return Math.max(0, serverCount + delta);
}
