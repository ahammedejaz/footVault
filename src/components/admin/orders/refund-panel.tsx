"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createRefund, importRefunds } from "@/lib/actions/admin/refunds";
import { formatPaise } from "@/lib/format";
import type { RefundPanelState } from "@/lib/orders/refunds";
import { toast } from "@/lib/toast";

/**
 * The refund panel: the owner giving money back without leaving the order.
 *
 * The amount is never typed and never computed here. The server computed both
 * verdicts from the policy matrix before this rendered; the admin chooses the
 * *cause* — the one fact no column knows — and the panel shows what that
 * choice returns and why, deductions itemised. Confirming sends the cause and
 * the displayed amount back; the server recomputes and refuses on any
 * difference, so a tab left open overnight cannot confirm a stale figure.
 *
 * Two presses to move money: the first arms the button, the second fires.
 * The real double-click guard is the database's one-in-flight index — this is
 * just the UI agreeing with it.
 */
export function RefundPanel({
  orderId,
  state,
}: {
  orderId: string;
  state: RefundPanelState;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [cause, setCause] = React.useState<"normal" | "shop_error">("normal");
  const [note, setNote] = React.useState("");
  const [armed, setArmed] = React.useState(false);

  const verdict = cause === "shop_error" ? state.verdicts.shopError : state.verdicts.normal;
  const inFlight = state.rows.some(
    (row) => row.status === "created" || row.status === "pending",
  );

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
      setArmed(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* ------------------------------------------------------- history -- */}
      {state.rows.length > 0 ? (
        <ul className="divide-border divide-y text-sm">
          {state.rows.map((row) => (
            <li key={row.id} className="py-2 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono font-medium tabular-nums">
                  {formatPaise(row.amountPaise)}
                </span>
                <span
                  className={
                    row.status === "processed"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : row.status === "failed"
                        ? "text-destructive"
                        : "text-muted-foreground"
                  }
                >
                  {row.status === "processed"
                    ? "returned"
                    : row.status === "failed"
                      ? "failed"
                      : "waiting for Razorpay"}
                </span>
              </div>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {row.reason.replaceAll("_", " ")}
                {row.razorpayRefundId ? ` · ${row.razorpayRefundId}` : ""}
                {row.processedAt
                  ? ` · ${new Date(row.processedAt).toLocaleString()}`
                  : ""}
              </p>
              {row.deductions.length > 0 ? (
                <ul className="text-muted-foreground mt-1 text-xs">
                  {row.deductions.map((line) => (
                    <li key={line.label}>
                      − {formatPaise(line.amountPaise)} · {line.label}
                    </li>
                  ))}
                </ul>
              ) : null}
              {row.failureReason ? (
                <p className="text-destructive mt-1 text-xs text-pretty">
                  {row.failureReason}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {/* ------------------------------------------------------- summary -- */}
      <dl className="space-y-1 text-sm">
        <div className="flex items-baseline justify-between">
          <dt className="text-muted-foreground">Paid online</dt>
          <dd className="font-mono tabular-nums">
            {formatPaise(state.capturedPaise)}
          </dd>
        </div>
        {state.processedPaise > 0 ? (
          <div className="flex items-baseline justify-between">
            <dt className="text-muted-foreground">Already returned</dt>
            <dd className="font-mono tabular-nums">
              −{formatPaise(state.processedPaise)}
            </dd>
          </div>
        ) : null}
        {state.inFlightPaise > 0 ? (
          <div className="flex items-baseline justify-between">
            <dt className="text-muted-foreground">On its way back</dt>
            <dd className="font-mono tabular-nums">
              −{formatPaise(state.inFlightPaise)}
            </dd>
          </div>
        ) : null}
      </dl>

      {state.capturedPaise === 0 ? (
        <p className="text-muted-foreground text-sm text-pretty">
          Nothing was paid online for this order, so there is nothing to send
          back from here.
        </p>
      ) : state.refundablePaise === 0 ? (
        <p className="text-muted-foreground text-sm text-pretty">
          Everything paid online has been returned{inFlight ? " or is on its way back" : ""}.
        </p>
      ) : (
        <div className="border-border space-y-4 rounded-md border p-3">
          {/* ------------------------------------------------------ cause -- */}
          <fieldset>
            <legend className="text-sm font-medium">Why is money going back?</legend>
            <div className="mt-2 space-y-2">
              {(
                [
                  ["normal", "The order stopped — cancelled, refused or undeliverable"],
                  ["shop_error", "Our mistake — wrong item, wrong size, damaged before dispatch"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="refund-cause"
                    checked={cause === value}
                    onChange={() => {
                      setCause(value);
                      setArmed(false);
                    }}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          {/* ---------------------------------------------------- verdict -- */}
          <div>
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-xs tracking-[0.06em] uppercase">
                Comes back
              </span>
              <span className="font-mono text-xl font-extrabold tabular-nums">
                {formatPaise(verdict.refundPaise)}
              </span>
            </div>
            {verdict.deductions.length > 0 ? (
              <ul className="text-muted-foreground mt-1 text-xs">
                {verdict.deductions.map((line) => (
                  <li key={line.label} className="flex items-baseline justify-between">
                    <span>{line.label}</span>
                    <span className="font-mono tabular-nums">
                      −{formatPaise(line.amountPaise)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-muted-foreground mt-2 text-sm text-pretty">
              {verdict.explanation}
            </p>
          </div>

          {verdict.replacementOnly || verdict.refundPaise <= 0 ? null : (
            <>
              <Input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Note for the record (optional)"
                maxLength={500}
                disabled={busy !== null}
              />
              {inFlight ? (
                <p className="text-muted-foreground text-sm text-pretty">
                  A refund is already on its way to Razorpay. When it settles,
                  more can be sent.
                </p>
              ) : (
                <Button
                  type="button"
                  className="min-h-11 w-full"
                  variant={armed ? "destructive" : "default"}
                  disabled={busy !== null}
                  onClick={() => {
                    if (!armed) {
                      setArmed(true);
                      return;
                    }
                    void run(
                      "create",
                      () =>
                        createRefund({
                          orderId,
                          cause,
                          note: note.trim().length ? note.trim() : undefined,
                          expectedPaise: verdict.refundPaise,
                        }),
                      (result) =>
                        "ok" in result && result.ok
                          ? `${formatPaise(verdict.refundPaise)} sent to Razorpay. It is done when the webhook confirms it.`
                          : "Refund sent.",
                    );
                  }}
                >
                  {busy === "create"
                    ? "Sending…"
                    : armed
                      ? `Press again to refund ${formatPaise(verdict.refundPaise)}`
                      : `Refund ${formatPaise(verdict.refundPaise)}`}
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {/* -------------------------------------------------------- import -- */}
      {state.providerPaymentId ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs text-pretty">
            Refunded in the Razorpay dashboard instead? Pull it in so this page
            stops being wrong.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 shrink-0"
            disabled={busy !== null}
            onClick={() =>
              void run(
                "import",
                () => importRefunds({ orderId }),
                (result) =>
                  "checked" in result
                    ? result.recorded === 0 && result.settled === 0
                      ? `Checked Razorpay — ${result.checked} refund${result.checked === 1 ? "" : "s"} there, nothing new.`
                      : `Recorded ${result.recorded} and settled ${result.settled} from Razorpay.`
                    : "Checked Razorpay.",
              )
            }
          >
            {busy === "import" ? "Checking…" : "Check Razorpay"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
