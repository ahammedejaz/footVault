"use client";

import { toast as sonner } from "sonner";

/**
 * One toast vocabulary for the whole storefront.
 *
 * Not a wrapper for its own sake. Three things have to be the same everywhere
 * or they stop meaning anything:
 *
 *   * **The copy pattern.** Buttons say what happens and toasts say what
 *     happened, in the same voice: "Added to bag", not "Success!".
 *   * **The undo.** Anything destructive offers one. A toast that only says a
 *     thing is gone is a notification; a toast that can put it back is a
 *     control, and it is the difference between a confident tap and a careful
 *     one.
 *   * **The duration.** Long enough to reach with a thumb, and longer when
 *     there is something to press.
 */

/** Long enough to notice, short enough not to sit on the checkout button. */
const PLAIN = 3500;
/** An action needs time to be seen, understood and reached. */
const WITH_ACTION = 7000;

export type UndoableOptions = {
  /** What to say. Past tense, specific: "Removed the Air Max 90, UK 9". */
  message: string;
  /** What pressing undo does. Failures are its own problem to report. */
  onUndo: () => void;
};

export const toast = {
  /** Something worked and there is nothing to take back. */
  done(message: string, description?: string) {
    sonner.success(message, { description, duration: PLAIN });
  },

  /**
   * Something worked and can be taken back.
   *
   * "Added to bag" gets this too, not a bare confirmation: the most common
   * regret on a phone is a tap you did not mean, and the fix belongs next to
   * the thing that just happened rather than three screens away in the bag.
   */
  undoable(message: string, description: string | undefined, undo: UndoableOptions["onUndo"], label = "Undo") {
    sonner.success(message, {
      description,
      duration: WITH_ACTION,
      action: { label, onClick: undo },
    });
  },

  /** Something worked and there is somewhere to go next. */
  withLink(message: string, description: string | undefined, label: string, onClick: () => void) {
    sonner.success(message, {
      description,
      duration: WITH_ACTION,
      action: { label, onClick },
    });
  },

  /**
   * Something did not work.
   *
   * Errors say what broke and what to do, and never apologise — so the message
   * passed in here is the server's sentence, not "Something went wrong".
   */
  failed(message: string) {
    sonner.error(message, { duration: WITH_ACTION });
  },

  /** A fact the customer needs but did not cause. */
  note(message: string, description?: string) {
    sonner.info(message, { description, duration: PLAIN });
  },
};
