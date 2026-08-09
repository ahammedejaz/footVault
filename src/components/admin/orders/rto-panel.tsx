"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  markRtoReceived,
  recordRtoCharge,
  restockRtoOrder,
} from "@/lib/actions/admin/rto";
import { formatPaise } from "@/lib/format";
import type { RtoPanelState } from "@/lib/orders/rto";
import { toast } from "@/lib/toast";

/**
 * The RTO panel: a parcel coming back, walked through its three moments.
 *
 * The panel renders the *next* step and the record of the ones taken, in
 * order: the courier reported it (a fact, dated), the box was received and
 * inspected (a form until it happens, a line after), the stock went back (a
 * button only when the inspection said ok). Nothing here computes anything —
 * the server decides what is allowed via `canReceive` / `canRestock`, and
 * every press is re-checked server-side, so a stale tab gets a sentence
 * rather than a side effect.
 *
 * The condition choice is deliberately blunt. "Ok" and "damaged" are the only
 * two answers because they are the only two the stock ledger distinguishes:
 * ok restocks, damaged never does. A finer taxonomy belongs in the note.
 */
export function RtoPanel({
  orderId,
  state,
}: {
  orderId: string;
  state: RtoPanelState;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [condition, setCondition] = React.useState<"ok" | "damaged">("ok");
  const [note, setNote] = React.useState("");
  /**
   * Kept as the raw string the owner typed, parsed on press. A number state
   * would have to invent a value for "empty", and 0 is a recordable charge —
   * an accidental ₹0 written because a field defaulted to it would silently
   * zero the refund deduction `freightFor()` computes from this column.
   */
  const [chargeRupees, setChargeRupees] = React.useState(
    state.actualRtoPaise !== null ? String(state.actualRtoPaise / 100) : "",
  );

  const parsedCharge = chargeRupees.trim() === "" ? NaN : Number(chargeRupees);
  const chargeValid = Number.isFinite(parsedCharge) && parsedCharge >= 0;

  async function run<T extends { ok: boolean; message?: string }>(
    key: string,
    action: () => Promise<T>,
    success: (result: T) => string,
  ): Promise<void> {
    if (busy) return;
    setBusy(key);
    try {
      const result = await action();
      if (result.ok) {
        toast.done(success(result));
        router.refresh();
      } else {
        toast.failed(result.message ?? "That did not work.");
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* -------------------------------------------------- what happened -- */}
      <dl className="space-y-1 text-sm">
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-muted-foreground">Courier reported return</dt>
          <dd className="whitespace-nowrap">
            {state.rtoAt ? formatDate(state.rtoAt) : "Moved by hand"}
          </dd>
        </div>
        {state.receivedAt ? (
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">Received and inspected</dt>
            <dd className="whitespace-nowrap">
              {formatDate(state.receivedAt)} ·{" "}
              <span
                className={
                  state.condition === "damaged"
                    ? "text-destructive"
                    : "text-emerald-600 dark:text-emerald-400"
                }
              >
                {state.condition === "damaged" ? "damaged" : "ok"}
              </span>
            </dd>
          </div>
        ) : null}
        {state.restockedAt ? (
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">Stock back on the shelf</dt>
            <dd className="whitespace-nowrap">
              {formatDate(state.restockedAt)}
            </dd>
          </div>
        ) : null}
      </dl>

      {/* ---------------------------------------------------- receive it -- */}
      {state.canReceive ? (
        <div className="border-border space-y-4 rounded-md border p-3">
          <fieldset>
            <legend className="text-sm font-medium">
              The parcel is physically here — what is inside?
            </legend>
            <div className="mt-2 space-y-2">
              {(
                [
                  ["ok", "Ok — sellable, stock can go back on the shelf"],
                  ["damaged", "Damaged — write it off, never restock"],
                ] as const
              ).map(([value, label]) => (
                <label
                  key={value}
                  className="flex min-h-11 items-center gap-2 text-sm"
                >
                  <input
                    type="radio"
                    name="rto-condition"
                    checked={condition === value}
                    onChange={() => setCondition(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <Input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={
              condition === "damaged"
                ? "What is damaged? Required — this is the write-off record."
                : "Note for the record (optional)"
            }
            maxLength={500}
            disabled={busy !== null}
          />
          {condition === "damaged" ? (
            <p className="text-muted-foreground text-sm text-pretty">
              A damaged return is never restocked. No stock movement is written
              — the pairs left the shelf at sale and will not come back — so
              the note above and the timeline are the whole record.
            </p>
          ) : null}

          <Button
            type="button"
            className="min-h-11 w-full"
            disabled={
              busy !== null || (condition === "damaged" && !note.trim())
            }
            onClick={() =>
              void run(
                "receive",
                () =>
                  markRtoReceived({
                    orderId,
                    condition,
                    note: note.trim() || undefined,
                  }),
                () =>
                  condition === "damaged"
                    ? "Received and written off. Nothing will be restocked."
                    : "Received. The stock can go back on the shelf below.",
              )
            }
          >
            {busy === "receive"
              ? "Recording…"
              : condition === "damaged"
                ? "Receive and write off"
                : "Mark the parcel received"}
          </Button>
        </div>
      ) : null}

      {/* ------------------------------------------------------- restock -- */}
      {state.canRestock ? (
        <div className="border-border space-y-3 rounded-md border p-3">
          <p className="text-muted-foreground text-sm text-pretty">
            The parcel was inspected and everything is sellable. This puts
            every pair on this order back into stock, once — pressing it twice
            moves nothing twice.
          </p>
          <Button
            type="button"
            className="min-h-11 w-full"
            disabled={busy !== null}
            onClick={() =>
              void run(
                "restock",
                () => restockRtoOrder({ orderId }),
                () => "Stock is back on the shelf, with a ledger row per item.",
              )
            }
          >
            {busy === "restock" ? "Restocking…" : "Return the stock to the shelf"}
          </Button>
        </div>
      ) : null}
      {state.condition === "damaged" && state.receivedAt ? (
        <p className="text-muted-foreground text-sm text-pretty">
          Written off as damaged. Damaged stock is never restocked — the ledger
          shows these pairs leaving at sale and nothing coming back.
        </p>
      ) : null}

      {/* -------------------------------------------------- return charge -- */}
      <div className="space-y-2">
        <dl className="space-y-1 text-sm">
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">
              Return freight, quoted (estimate)
            </dt>
            <dd className="font-mono tabular-nums">
              {state.quotedRtoPaise !== null
                ? formatPaise(state.quotedRtoPaise)
                : "—"}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">Actually charged</dt>
            <dd className="font-mono tabular-nums">
              {state.actualRtoPaise !== null
                ? formatPaise(state.actualRtoPaise)
                : "not recorded yet"}
            </dd>
          </div>
        </dl>

        <div className="flex items-center gap-2">
          <span aria-hidden className="text-muted-foreground font-mono text-sm">
            ₹
          </span>
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step={1}
            value={chargeRupees}
            onChange={(event) => setChargeRupees(event.target.value)}
            aria-label="Actual return charge in rupees, from Shiprocket's panel"
            placeholder="From Shiprocket's panel"
            className="max-w-40"
            disabled={busy !== null}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11"
            disabled={busy !== null || !chargeValid}
            onClick={() =>
              void run(
                "charge",
                () =>
                  recordRtoCharge({ orderId, actualRupees: parsedCharge }),
                () => "Recorded. Refund deductions now use this figure.",
              )
            }
          >
            {busy === "charge" ? "Recording…" : "Record actual charge"}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs text-pretty">
          Type what Shiprocket&rsquo;s panel says the return leg actually cost
          — never an estimate. Refunds deduct the recorded figure instead of
          the quote from the moment it is saved.
        </p>
      </div>
    </div>
  );
}

/** Short, shop-local, and never the raw ISO string. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}
