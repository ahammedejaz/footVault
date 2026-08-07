"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/**
 * The counts behind the two badges in the header.
 *
 * Phase 4 owns the bag and the saved list. What Phase 3 owes them is the badge:
 * the header has to reserve the space, render the number, and keep the icons
 * where they are when it appears — none of which can be retrofitted later
 * without the header shifting the first time somebody adds a shoe.
 *
 * So the store is real and persisted, and the only thing missing is the code
 * that writes to it. `setBagCount` / `setSavedCount` are the seam Phase 4 uses.
 *
 * `hydrated` exists because a persisted store cannot be read during server
 * rendering: the server has no localStorage, so it renders 0, and a client that
 * rendered 3 on the first pass would be a hydration mismatch. The badge stays
 * hidden until the store has rehydrated, which is one frame.
 */
type BagState = {
  bagCount: number;
  savedCount: number;
  hydrated: boolean;
  setBagCount: (count: number) => void;
  setSavedCount: (count: number) => void;
};

export const useBagStore = create<BagState>()(
  persist(
    (set) => ({
      bagCount: 0,
      savedCount: 0,
      hydrated: false,
      setBagCount: (bagCount) => set({ bagCount }),
      setSavedCount: (savedCount) => set({ savedCount }),
    }),
    {
      name: "fv-bag",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ bagCount: state.bagCount, savedCount: state.savedCount }),
      onRehydrateStorage: () => () => {
        useBagStore.setState({ hydrated: true });
      },
    },
  ),
);
