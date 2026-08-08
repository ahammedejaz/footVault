"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  IndentDecrease,
  IndentIncrease,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  moveCategory,
  setCategoryActive,
} from "@/lib/actions/admin/categories";
import { toast } from "@/lib/toast";

/**
 * Reordering and re-nesting, as four buttons rather than a drag handle.
 *
 * Drag-and-drop is the obvious answer and the wrong one here. A drag target
 * needs a keyboard equivalent written separately — and the brief's
 * accessibility gate covers the panel, not only the shop — plus a pointer
 * sensor that does not fight a tablet's own scroll, plus a live region so a
 * screen reader is told where the row landed. Four buttons already tab, already
 * announce what they do, already clear 44px, and already work on a touch screen
 * that is trying to scroll the table sideways at the same time. The owner
 * reorders the menu a handful of times a year; the accessible version is also
 * the honest one.
 *
 * Each press is a whole server round trip, and the row does not move until the
 * server says it did. Optimistically reordering here would mean the list
 * animates into an order the database may refuse — and the one it refuses most
 * is the interesting one, nesting too deep for the shop's menu to render.
 */
export function CategoryRowActions({
  id,
  name,
  isActive,
  canMoveUp,
  canMoveDown,
  canNest,
  canUnnest,
  nestBlockedBecause,
}: {
  id: string;
  name: string;
  isActive: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canNest: boolean;
  canUnnest: boolean;
  /** Why the indent button is off, for its tooltip and its label. */
  nestBlockedBecause: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  async function move(direction: "up" | "down" | "in" | "out", said: string) {
    setPending(true);
    const result = await moveCategory({ id, direction });
    setPending(false);
    if (!result.ok) {
      toast.failed(result.message);
      return;
    }
    toast.done(`${name} ${said}`);
    router.refresh();
  }

  async function toggle() {
    setPending(true);
    const result = await setCategoryActive({ id, isActive: !isActive });
    setPending(false);
    if (!result.ok) {
      toast.failed(result.message);
      return;
    }
    toast.done(
      isActive ? `${name} is hidden` : `${name} is showing`,
      isActive
        ? "It has gone from the shop's menu. Its products are unaffected."
        : "It is back in the shop's menu.",
    );
    router.refresh();
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={pending || !canMoveUp}
        aria-label={`Move ${name} up`}
        onClick={() => move("up", "moved up")}
      >
        <ArrowUp className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={pending || !canMoveDown}
        aria-label={`Move ${name} down`}
        onClick={() => move("down", "moved down")}
      >
        <ArrowDown className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={pending || !canNest}
        title={nestBlockedBecause ?? undefined}
        aria-label={
          nestBlockedBecause
            ? `Cannot nest ${name}: ${nestBlockedBecause}`
            : `Nest ${name} under the category above it`
        }
        onClick={() => move("in", "moved in a level")}
      >
        <IndentIncrease className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={pending || !canUnnest}
        aria-label={`Move ${name} out to the top level`}
        onClick={() => move("out", "moved out a level")}
      >
        <IndentDecrease className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={pending}
        aria-label={
          isActive ? `Hide ${name} from the shop` : `Show ${name} in the shop`
        }
        onClick={toggle}
      >
        {isActive ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
      </Button>
    </div>
  );
}
