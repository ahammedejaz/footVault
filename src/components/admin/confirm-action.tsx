"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "@/lib/toast";

/**
 * The confirmation every destructive admin action goes through.
 *
 * **It names the thing.** "Delete this product?" is not a confirmation, it is a
 * speed bump — the owner has already decided to press yes before they have read
 * which row they are on. `subject` is required and it is rendered in the
 * heading, so a mis-click on the wrong row is caught by reading rather than by
 * remembering.
 *
 * `consequence` is the second half and matters more. The owner does not need to
 * be told that deleting deletes; they need to be told that a product with orders
 * against it is hidden rather than removed, or that cancelling puts eight pairs
 * back on the shelf. Callers pass the sentence that is true for *this* row,
 * which is why it is a prop and not a template.
 *
 * The dialog owns the pending state, so a slow action cannot be double-fired by
 * a second tap — the commonest way an admin panel creates two of something on a
 * bad connection.
 */
export function ConfirmAction({
  subject,
  consequence,
  confirmLabel,
  triggerLabel,
  triggerVariant = "outline",
  triggerSize = "sm",
  triggerClassName,
  action,
  successMessage,
  /** Set when the action cannot be undone at all — adds a typed confirmation. */
  requireTyping,
}: {
  subject: string;
  consequence: string;
  confirmLabel: string;
  triggerLabel: React.ReactNode;
  triggerVariant?: "outline" | "destructive" | "ghost" | "secondary";
  triggerSize?: "sm" | "default" | "icon-sm";
  triggerClassName?: string;
  action: () => Promise<{ ok: boolean; message?: string }>;
  successMessage: string;
  requireTyping?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [typed, setTyped] = React.useState("");

  const armed =
    !requireTyping ||
    typed.trim().toLowerCase() === requireTyping.toLowerCase();

  async function run() {
    setPending(true);
    try {
      const result = await action();
      if (result.ok) {
        setOpen(false);
        setTyped("");
        toast.done(successMessage);
        // The list this row is in is a Server Component, so the row does not
        // disappear until the server says so. Refreshing rather than filtering
        // it out locally means the panel never shows a state the database is
        // not actually in.
        router.refresh();
      } else {
        toast.failed(result.message ?? "That did not work.");
      }
    } catch {
      toast.failed("That did not work. Nothing has been changed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (!next) setTyped("");
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant={triggerVariant}
          size={triggerSize}
          className={triggerClassName}
        >
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-pretty">{subject}</DialogTitle>
          <DialogDescription className="text-pretty">
            {consequence}
          </DialogDescription>
        </DialogHeader>

        {requireTyping ? (
          <div>
            <label htmlFor="confirm-typed" className="text-sm font-medium">
              Type <span className="font-mono">{requireTyping}</span> to confirm
            </label>
            <input
              id="confirm-typed"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              className="border-input mt-1.5 h-11 w-full rounded-sm border px-3 text-sm"
            />
          </div>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" size="sm" disabled={pending}>
              Keep it
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            size="sm"
            onClick={run}
            disabled={pending || !armed}
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
