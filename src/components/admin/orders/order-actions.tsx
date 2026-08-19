"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { ConfirmAction } from "@/components/admin/confirm-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  addOrderNote,
  deleteOrder,
  markCashCollected,
  recordReplacement,
  setOrderStatus,
} from "@/lib/actions/admin/orders";
import { formatPaise } from "@/lib/format";
import {
  REPLACEMENT_REASONS,
  REPLACEMENT_REASON_LABEL,
  type ReplacementReason,
} from "@/lib/orders/replacement";
import {
  ORDER_TRANSITIONS,
  type OrderStatus,
  type PaymentStatus,
} from "@/lib/orders/types";
import { toast } from "@/lib/toast";

/**
 * Everything the owner can do to an order that is not shipping.
 *
 * The status buttons are the legal moves and only the legal moves —
 * `ORDER_TRANSITIONS` is the same table the server enforces, so a button that
 * cannot work is never drawn. Showing every status and rejecting most of them
 * would teach the owner to expect failure.
 *
 * Nothing here writes `orders.status`. Each button calls the action, which
 * calls `transitionOrder`, which owns the compare-and-swap. That is the whole
 * reason there is no "quick edit" on this page.
 */
export function OrderActions({
  orderId,
  orderNumber,
  status,
  paymentStatus,
  balanceDueOnDelivery,
  cashCollectedAt,
  deliveredAt,
}: {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  balanceDueOnDelivery: number;
  cashCollectedAt: string | null;
  deliveredAt: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  async function run(
    key: string,
    action: () => Promise<{ ok: boolean; message?: string }>,
    success: string,
  ): Promise<boolean> {
    if (busy) return false;
    setBusy(key);
    try {
      const result = await action();
      if (result.ok) {
        toast.done(success);
        router.refresh();
        return true;
      }
      toast.failed(result.message ?? "That did not work.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  const next = ORDER_TRANSITIONS[status];
  const owesCash = balanceDueOnDelivery > 0;

  return (
    <div className="space-y-6">
      {/* ---------------------------------------------------------- status -- */}
      <div>
        <h3 className="text-sm font-medium">Move this order on</h3>
        {next.length === 0 ? (
          <p className="text-muted-foreground mt-1 text-sm text-pretty">
            {status === "cancelled"
              ? "Cancelled orders stay cancelled. Their stock has already gone back."
              : "This order is finished. There is nowhere further for it to go."}
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {next.map((to) => (
              <Button
                key={to}
                type="button"
                size="sm"
                variant={to === "cancelled" ? "outline" : "default"}
                className="min-h-11 capitalize"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    `status:${to}`,
                    () => setOrderStatus({ orderId, to }),
                    `Order marked ${to}.`,
                  )
                }
              >
                {busy === `status:${to}` ? (
                  <Loader2 aria-hidden className="size-4 animate-spin" />
                ) : null}
                Mark {to}
              </Button>
            ))}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------ cash -- */}
      {owesCash ? (
        <div className="border-border rounded-md border p-3">
          <h3 className="text-sm font-medium">Cash at the door</h3>
          {cashCollectedAt ? (
            <p className="text-muted-foreground mt-1 text-sm text-pretty">
              {formatPaise(balanceDueOnDelivery)} marked collected on{" "}
              {new Date(cashCollectedAt).toLocaleString()}.
            </p>
          ) : (
            <>
              <p className="text-muted-foreground mt-1 text-sm text-pretty">
                The courier owes the shop{" "}
                <strong className="font-mono">
                  {formatPaise(balanceDueOnDelivery)}
                </strong>
                . Mark this only when the money is actually in hand — it is never
                inferred from a delivery status, because delivery usually means
                payment and occasionally does not.
              </p>
              <Button
                type="button"
                size="sm"
                className="mt-2 min-h-11"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    "cash",
                    () => markCashCollected({ orderId }),
                    "Cash recorded.",
                  )
                }
              >
                {busy === "cash" ? (
                  <Loader2 aria-hidden className="size-4 animate-spin" />
                ) : null}
                Mark {formatPaise(balanceDueOnDelivery)} collected
              </Button>
            </>
          )}
        </div>
      ) : null}

      {/* ---------------------------------------------------- replacement -- */}
      {status === "delivered" ? (
        <ReplacementForm
          orderId={orderId}
          deliveredAt={deliveredAt}
          busy={busy}
          run={run}
        />
      ) : null}

      {/* ----------------------------------------------------------- note -- */}
      <NoteForm orderId={orderId} busy={busy} run={run} />

      {/* --------------------------------------------------------- delete -- */}
      <DeleteOrder
        orderId={orderId}
        orderNumber={orderNumber}
        status={status}
        paymentStatus={paymentStatus}
      />
    </div>
  );
}

/**
 * Removing an order from the database for good.
 *
 * **The condition below is advice, not authorisation.** `admin_delete_order`
 * decides, and it checks four things this component cannot see — whether a
 * payment row exists at a status short of `failed`, whether a refund has been
 * raised, and whether the stock actually went back. Duplicating that here would
 * be a second copy of a rule that has to stay in step with the first, which is
 * the shape this codebase keeps refusing. What it is for is deciding **which of
 * two things to draw**, and both of them are honest:
 *
 *   - plausibly deletable → the button, and the server may still say no, in
 *     which case the refusal arrives as a sentence naming the next move;
 *   - clearly not → the reason, in place of the button.
 *
 * The second half is the part worth having. A paid order with no delete control
 * and no explanation is indistinguishable from a panel that has not implemented
 * deleting, which is precisely the misreading that produced this whole batch of
 * work — the owner concluded the brands screen had no remove option when it had
 * one for every brand nothing pointed at.
 */
function DeleteOrder({
  orderId,
  orderNumber,
  status,
  paymentStatus,
}: {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
}) {
  const dispatched =
    status === "shipped" ||
    status === "delivered" ||
    status === "returning" ||
    status === "returned";
  const paid = paymentStatus !== "unpaid";

  return (
    <div className="border-destructive/30 rounded-md border p-3">
      <h3 className="text-sm font-medium">Remove this order</h3>

      {paid || dispatched ? (
        <p className="text-muted-foreground mt-1 text-sm text-pretty">
          {paid
            ? "This order has been paid, so it is the shop's record of a sale and cannot be removed. Cancel it if it is not going ahead — that puts the stock back and leaves the record intact."
            : "This order is with the courier or has already arrived, so it stays. Deleting it would leave the courier's updates arriving for an order that no longer exists."}
        </p>
      ) : (
        <>
          <p className="text-muted-foreground mt-1 text-sm text-pretty">
            Nothing has been paid on this order, so it can be taken out of the
            database altogether — useful for a test order or a checkout nobody
            finished.{" "}
            {status === "cancelled"
              ? "Its stock has already gone back on the shelf."
              : "Any pairs it is holding go back on the shelf first."}
          </p>
          <div className="mt-3">
            <ConfirmAction
              subject={`Delete order ${orderNumber} from the database?`}
              consequence={
                `Everything about it goes — the items, the timeline, the address and any payment attempt. ` +
                (status === "cancelled"
                  ? "Its stock is already back on the shelf. "
                  : "The pairs it is holding go back on the shelf first. ") +
                `Any Vault Coins already earned or spent on it stay on the customer's balance. ` +
                `Nothing can bring this order back.`
              }
              confirmLabel="Delete it for good"
              triggerLabel="Delete this order"
              triggerVariant="destructive"
              requireTyping="delete"
              action={() => deleteOrder({ orderId })}
              successMessage={`Order ${orderNumber} has been deleted`}
              // This page *is* the order. Refreshing it after a successful
              // delete would re-request a route that now 404s.
              redirectTo="/admin/orders"
            />
          </div>
        </>
      )}
    </div>
  );
}

type Runner = (
  key: string,
  action: () => Promise<{ ok: boolean; message?: string }>,
  success: string,
) => Promise<boolean>;

/**
 * Recording a replacement, which is only ever the shop's decision.
 *
 * There is no customer-facing version of this form anywhere in the codebase and
 * that is the policy, not an omission: a customer contacts the shop and a human
 * decides.
 */
function ReplacementForm({
  orderId,
  deliveredAt,
  busy,
  run,
}: {
  orderId: string;
  deliveredAt: string | null;
  busy: string | null;
  run: Runner;
}) {
  const [reason, setReason] = React.useState<ReplacementReason>(
    "damaged_in_transit",
  );
  const [note, setNote] = React.useState("");

  /**
   * The deadline is *shown*, not judged.
   *
   * Deciding "has it lapsed" here would mean reading the clock during render,
   * which React's purity rule flags and is right to: the answer changes while
   * the page sits open, and a component that computed it once would go stale
   * silently. The server stamps late-or-not onto the timeline at the moment the
   * replacement is recorded, which is the only reading that matters.
   */
  const deadline = deliveredAt
    ? new Date(new Date(deliveredAt).getTime() + 24 * 60 * 60 * 1000)
    : null;

  return (
    <form
      className="border-border rounded-md border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void run(
          "replacement",
          () => recordReplacement({ orderId, reason, note }),
          "Replacement recorded.",
        ).then((ok) => {
          if (ok) setNote("");
        });
      }}
    >
      <h3 className="text-sm font-medium">Record a replacement</h3>
      <p className="text-muted-foreground mt-1 text-sm text-pretty">
        {deadline === null
          ? "This order has no delivery timestamp, so the 24-hour window cannot be checked. That is recorded on the timeline."
          : `The 24-hour window runs to ${deadline.toLocaleString()}. You can record a replacement after it — whether to honour a late claim is your call, and the timeline will say it was late.`}
      </p>

      <label
        htmlFor="replacement-reason"
        className="mt-3 block text-xs font-medium"
      >
        Why
      </label>
      <select
        id="replacement-reason"
        value={reason}
        onChange={(event) =>
          setReason(event.target.value as ReplacementReason)
        }
        className="border-input bg-background mt-1 min-h-11 w-full rounded-md border px-3 text-sm"
      >
        {REPLACEMENT_REASONS.map((value) => (
          <option key={value} value={value}>
            {REPLACEMENT_REASON_LABEL[value]}
          </option>
        ))}
      </select>

      <label htmlFor="replacement-note" className="mt-3 block text-xs font-medium">
        What happened
      </label>
      <Input
        id="replacement-note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Left sole split on arrival, photos on WhatsApp"
        className="mt-1"
        maxLength={500}
        required
      />

      <Button
        type="submit"
        size="sm"
        variant="outline"
        className="mt-3 min-h-11"
        disabled={busy !== null || note.trim().length === 0}
      >
        {busy === "replacement" ? (
          <Loader2 aria-hidden className="size-4 animate-spin" />
        ) : null}
        Record replacement
      </Button>
    </form>
  );
}

function NoteForm({
  orderId,
  busy,
  run,
}: {
  orderId: string;
  busy: string | null;
  run: Runner;
}) {
  const [note, setNote] = React.useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void run(
          "note",
          () => addOrderNote({ orderId, note }),
          "Note added.",
        ).then((ok) => {
          if (ok) setNote("");
        });
      }}
    >
      <label htmlFor="order-note" className="block text-sm font-medium">
        Add a note
      </label>
      <p className="text-muted-foreground mt-1 text-sm text-pretty">
        Goes on the timeline at the order&rsquo;s current status, so &ldquo;rang
        the customer, no answer&rdquo; sits in the right place in the story.{" "}
        <strong>Only you see this.</strong> The customer&rsquo;s own timeline
        shows the status and the sentences the shop writes for them, never these
        notes.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Input
          id="order-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Rang the customer, no answer"
          className="min-w-48 flex-1"
          maxLength={500}
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          className="min-h-11"
          disabled={busy !== null || note.trim().length === 0}
        >
          {busy === "note" ? (
            <Loader2 aria-hidden className="size-4 animate-spin" />
          ) : null}
          Add note
        </Button>
      </div>
    </form>
  );
}
