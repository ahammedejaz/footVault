"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  addOrderNote,
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
import { ORDER_TRANSITIONS, type OrderStatus } from "@/lib/orders/types";
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
  status,
  balanceDueOnDelivery,
  cashCollectedAt,
  deliveredAt,
}: {
  orderId: string;
  status: OrderStatus;
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
        the customer, no answer&rdquo; sits in the right place in the story.
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
