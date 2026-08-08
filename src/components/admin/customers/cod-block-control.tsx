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
import { setCodBlocked } from "@/lib/actions/admin/customers";
import { toast } from "@/lib/toast";

/**
 * Withdrawing Pay on Delivery from one customer, and giving it back.
 *
 * Not a `ConfirmAction`, because blocking is not destructive and it is not a
 * yes/no — it needs a **reason typed by a person**, and the reason is the whole
 * point. A block with no explanation is one nobody can defend when the customer
 * rings up, and "the system did it" is not an answer a shop can give. The
 * server refuses a block with an empty reason for the same reason this asks for
 * one, so the rule holds whether or not this component is the caller.
 *
 * Unblocking needs no reason and does not ask for one: giving somebody an
 * option back is not a decision anybody has to justify.
 *
 * The reason is stored with the admin's name appended, so six months later the
 * row says who as well as why.
 */
export function CodBlockControl({
  customerId,
  customerName,
  blocked,
  reason,
}: {
  customerId: string;
  customerName: string;
  blocked: boolean;
  reason: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [why, setWhy] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  const submit = (next: boolean) => {
    startTransition(async () => {
      const result = await setCodBlocked({
        customerId,
        blocked: next,
        reason: next ? why : undefined,
      });
      if (!result.ok) {
        toast.failed(result.message);
        return;
      }
      setOpen(false);
      setWhy("");
      toast.done(
        next
          ? "Pay on Delivery withdrawn"
          : "Pay on Delivery available again",
        next
          ? `${customerName} can still pay online.`
          : `${customerName} may pay on delivery again.`,
      );
      router.refresh();
    });
  };

  if (blocked) {
    return (
      <div className="flex flex-col items-end gap-1">
        <span
          className="border-state-low/50 bg-state-low/10 rounded-md border px-2 py-0.5 font-mono text-xs"
          title={reason ?? undefined}
        >
          Pay on Delivery off
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          className="min-h-11"
          onClick={() => submit(false)}
        >
          {pending ? "Restoring…" : "Allow it again"}
        </Button>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="min-h-11">
          Stop Pay on Delivery
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Stop Pay on Delivery for {customerName}?</DialogTitle>
          <DialogDescription>
            They can still pay online, and orders they have already placed are
            not affected. Use this when somebody has refused parcels more than
            once — each refusal costs the delivery out and the delivery back.
          </DialogDescription>
        </DialogHeader>

        <label htmlFor="cod-block-reason" className="block text-xs font-medium">
          Why
        </label>
        <input
          id="cod-block-reason"
          value={why}
          onChange={(event) => setWhy(event.target.value)}
          maxLength={240}
          placeholder="Refused two parcels in October"
          className="border-input bg-background min-h-11 w-full rounded-md border px-3 text-sm"
        />
        <p className="text-muted-foreground text-sm text-pretty">
          Saved with your name. If they ring up, this is what you will be
          reading.
        </p>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" className="min-h-11">
              Cancel
            </Button>
          </DialogClose>
          <Button
            className="min-h-11"
            disabled={pending || why.trim().length === 0}
            onClick={() => submit(true)}
          >
            {pending ? "Saving…" : "Stop Pay on Delivery"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
