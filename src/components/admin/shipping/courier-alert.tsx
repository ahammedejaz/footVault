"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { resolveCourierEvent } from "@/lib/actions/admin/shipping";
import { formatPaise, relativeAge } from "@/lib/format";
import type { CourierQueue } from "@/lib/queries/admin/courier";
import { toast } from "@/lib/toast";

/**
 * What a courier said that this shop refused to act on by itself.
 *
 * Modelled on `RefundsOwedAlert` beside it, deliberately: same place, same red,
 * same shape of sentence. An owner who has learned to read one strip has
 * learned to read this one.
 *
 * **It renders nothing when there is nothing**, which is the property that
 * makes it credible the first time it does render. It also renders on failure —
 * "we could not check" is a different sentence from "there is nothing", and
 * conflating them is how a broken query becomes a quiet all-clear.
 *
 * The only control is "I have dealt with this". There is deliberately no refund
 * button here: the amount shown is what the shop *could* return, computed live,
 * and whether it *should* depends on a fact that lives in the Shiprocket portal
 * rather than in this database. The strip's job is to make sure nobody forgets
 * the decision exists.
 */
export function CourierAlert({ queue }: { queue: CourierQueue }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  if (queue.state === "unknown") {
    return (
      <p
        role="status"
        className="border-orange/50 bg-orange/5 rounded-md border p-3 text-sm text-pretty"
      >
        <strong>The courier queue could not be read.</strong> That is not the
        same as there being nothing to deal with — it means we could not check.
        Reload in a moment.
      </p>
    );
  }
  if (queue.count === 0) return null;

  async function dealtWith(id: string) {
    setBusy(id);
    const result = await resolveCourierEvent({ id });
    setBusy(null);
    if (!result.ok) {
      toast.failed(result.message);
      return;
    }
    toast.done("Marked as dealt with");
    router.refresh();
  }

  return (
    <div
      role="status"
      className="border-destructive/50 bg-destructive/5 rounded-md border p-3 text-sm text-pretty"
    >
      <p>
        <strong>
          {queue.count === 1
            ? "A courier said something about a parcel that this shop did not act on."
            : `${queue.count} courier updates are waiting for a decision.`}
        </strong>{" "}
        This shop only moves an order by itself for &ldquo;delivered&rdquo; and
        &ldquo;RTO&rdquo;. Everything else is recorded and left here on purpose,
        because acting on a status nobody has verified is how an order moves for
        the wrong reason.
      </p>

      <ul className="mt-3 space-y-3">
        {queue.rows.map((row) => (
          <li key={row.id} className="border-border/60 border-t pt-3">
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              {row.orderId && row.orderNumber ? (
                <Link
                  href={`/admin/orders/${row.orderId}`}
                  className="font-mono text-xs tracking-[0.06em] underline-offset-4 hover:underline"
                >
                  {row.orderNumber}
                </Link>
              ) : (
                <span className="font-mono text-xs">no matching order</span>
              )}
              {row.statusText ? (
                <span className="font-medium">
                  &ldquo;{row.statusText}&rdquo;
                </span>
              ) : null}
              <span className="text-muted-foreground text-xs">
                {row.source === "webhook"
                  ? "pushed by the courier"
                  : row.source === "sweep"
                    ? "found by the reconciliation sweep"
                    : "seen when tracking was refreshed"}{" "}
                &middot; {relativeAge(row.receivedAt)}
                {row.awb ? ` · AWB ${row.awb}` : ""}
              </span>
            </p>

            <p className="mt-1">{row.reason}</p>

            {/*
              Three states, and the middle one is the one worth spelling out.
              Null is "we could not work out what is owed", which is the
              opposite instruction to "nothing is owed" — rendering it as
              ₹0.00 would tell an operator to close the tab.
            */}
            {row.refundablePaise === null ? (
              row.orderId ? (
                <p className="text-muted-foreground mt-1 text-xs">
                  The refundable amount could not be read. Open the order.
                </p>
              ) : null
            ) : row.refundablePaise > 0 ? (
              <p className="mt-1">
                <strong>
                  {formatPaise(row.refundablePaise)} is refundable on this order
                  right now.
                </strong>{" "}
                Nothing here will return it. Refund it from the order&rsquo;s own
                panel, or in the Razorpay dashboard, once you have confirmed in
                the Shiprocket panel that the parcel is dead.
              </p>
            ) : (
              <p className="text-muted-foreground mt-1 text-xs">
                Nothing is refundable on this order — no money is being held.
              </p>
            )}

            <div className="mt-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => void dealtWith(row.id)}
              >
                {busy === row.id ? "Clearing…" : "I have dealt with this"}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {queue.count > queue.rows.length ? (
        <p className="text-muted-foreground mt-3 text-xs">
          Showing {queue.rows.length} of {queue.count}. The rest appear as these
          are cleared.
        </p>
      ) : null}
    </div>
  );
}
