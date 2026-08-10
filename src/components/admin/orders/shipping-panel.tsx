"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, ExternalLink, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  assignAwbForOrder,
  createShipmentForOrder,
  generateDocumentsForOrder,
  schedulePickupForOrder,
  trackOrder,
} from "@/lib/actions/admin/shipping";
import { formatPaise } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * Fulfilment, as five buttons a human presses.
 *
 * The actions behind these have existed since the last phase — guarded,
 * rate-limited and covered by `npm run audit:shipping` — and until now nothing
 * in the interface called them. That is why this panel exists and why it is
 * deliberately plain: the work was already done, what was missing was a way to
 * reach it.
 *
 * **A human presses the button, and that is the design, not a shortcut.**
 * Shiprocket's API acts on the live account: creating an order creates a real
 * order in the panel, and assigning an AWB can commit real money. Automatic
 * fulfilment on payment means a bug ships real parcels.
 *
 * Every step is idempotent server-side and shows the state it already reached,
 * so a double-tap on a slow connection — the commonest way an admin panel
 * creates two of something — cannot produce a second shipment. The button
 * disables itself while a step is in flight for the same reason, but the
 * guarantee is the server's, not this component's.
 *
 * The steps gate on each other because Shiprocket does: there is no AWB without
 * an order, no pickup without an AWB. A disabled button here says "not yet",
 * and the line under it says what is missing.
 *
 * **Why the failure message is not rendered here.** It would be the obvious
 * place, and it would be wrong: this component only knows about failures it
 * caused itself, in this tab, since the page loaded. The reason a parcel is
 * stuck has to survive a reload and be visible to the second admin who opens
 * the order — so it is stored by the step, read by the page, and rendered above
 * this panel by `ShipmentErrorNotice`.
 */

export type ShipmentView = {
  status: string;
  shiprocketOrderId: string | null;
  shipmentId: string | null;
  awbCode: string | null;
  /** Which rule picked the courier, and the sentence the selector produced. */
  courierSelectionMode: string | null;
  courierSelectionReason: string | null;
  courierName: string | null;
  labelUrl: string | null;
  manifestUrl: string | null;
  invoiceUrl: string | null;
  pickupScheduledAt: string | null;
  deliveredAt: string | null;
  codCollectableAmount: number;
  trackedAt: string | null;
};

type Step = "create" | "awb" | "pickup" | "documents" | "track";

export function ShippingPanel({
  orderId,
  shipment,
  balanceDueOnDelivery,
  paysOnDelivery,
  canShip,
}: {
  orderId: string;
  shipment: ShipmentView | null;
  balanceDueOnDelivery: number;
  paysOnDelivery: boolean;
  /** False while the order is still pending — nothing ships before it is paid for. */
  canShip: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<Step | null>(null);

  async function run(step: Step, action: () => Promise<{ ok: boolean; message?: string }>) {
    if (busy) return;
    setBusy(step);
    try {
      const result = await action();
      if (result.ok) {
        toast.done(result.message ?? "Done.");
      } else {
        toast.failed(result.message ?? "That did not work.");
      }
      /**
       * Refreshed on failure too, not only on success.
       *
       * The toast is three and a half seconds of red text, and it used to be
       * the only trace a Shiprocket refusal left anywhere. The step now writes
       * the reason to the database before it returns, and the server component
       * above renders it — so the refresh is what turns a message that vanishes
       * into one that is still on the page when the owner looks up.
       */
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const created = Boolean(shipment?.shiprocketOrderId);
  const hasAwb = Boolean(shipment?.awbCode);

  if (!canShip) {
    return (
      <p className="text-muted-foreground text-sm text-pretty">
        This order has not been paid for yet. Nothing can be shipped until the
        payment confirms — for Pay on Delivery that is the advance, not the whole
        order.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {/*
        The number the courier will be asked for, stated before any button is
        pressed. It is the single most expensive figure on this page to get
        wrong, and the shipment carries it from the moment it is created.
      */}
      {paysOnDelivery ? (
        <p className="border-border rounded-md border p-3 text-sm text-pretty">
          The courier will be asked to collect{" "}
          <strong className="font-mono">
            {formatPaise(
              shipment?.shiprocketOrderId
                ? shipment.codCollectableAmount
                : balanceDueOnDelivery,
            )}
          </strong>{" "}
          in cash. That is the balance, not the order total — the delivery
          charge was already paid online.
        </p>
      ) : (
        <p className="text-muted-foreground text-sm text-pretty">
          Prepaid. The courier collects nothing at the door.
        </p>
      )}

      <StepRow
        title="1 · Create the shipment"
        state={
          created
            ? `Shiprocket order ${shipment?.shiprocketOrderId}${shipment?.shipmentId ? ` · shipment ${shipment.shipmentId}` : ""}`
            : null
        }
        blocked={null}
        busy={busy === "create"}
        disabled={busy !== null || created}
        label={created ? "Created" : "Create shipment"}
        onPress={() => run("create", () => createShipmentForOrder({ orderId }))}
      />

      {/*
        Why this courier, not just which.

        Shiprocket's recommendation scored worst of the available set on both
        lanes measured, so the shop now chooses — and a choice whose reasoning
        is invisible is indistinguishable from the old behaviour. The sentence
        carries the tolerance and the score that were in force, neither of which
        can be recovered from the mode alone once the setting changes.
      */}
      <StepRow
        title="2 · Assign a courier (AWB)"
        state={
          hasAwb
            ? [
                shipment?.awbCode,
                shipment?.courierName,
                shipment?.courierSelectionReason,
              ]
                .filter(Boolean)
                .join(" · ")
            : null
        }
        blocked={created ? null : "Create the shipment first."}
        busy={busy === "awb"}
        disabled={busy !== null || !created || hasAwb}
        label={hasAwb ? "Assigned" : "Assign AWB"}
        onPress={() => run("awb", () => assignAwbForOrder({ orderId }))}
      />

      <StepRow
        title="3 · Book the pickup"
        state={
          shipment?.pickupScheduledAt
            ? `Booked ${new Date(shipment.pickupScheduledAt).toLocaleString()}`
            : null
        }
        blocked={hasAwb ? null : "Assign a courier first."}
        busy={busy === "pickup"}
        disabled={busy !== null || !hasAwb || Boolean(shipment?.pickupScheduledAt)}
        label={shipment?.pickupScheduledAt ? "Booked" : "Book pickup"}
        onPress={() => run("pickup", () => schedulePickupForOrder({ orderId }))}
        /* This is the step that summons a real courier to the shop. */
        caution="A courier will be asked to come and collect."
      />

      <StepRow
        title="4 · Label, manifest and invoice"
        state={
          shipment?.labelUrl || shipment?.manifestUrl || shipment?.invoiceUrl ? (
            <span className="flex flex-wrap gap-3">
              <DocLink href={shipment.labelUrl} label="Label" />
              <DocLink href={shipment.manifestUrl} label="Manifest" />
              <DocLink href={shipment.invoiceUrl} label="Invoice" />
            </span>
          ) : null
        }
        blocked={hasAwb ? null : "Assign a courier first."}
        busy={busy === "documents"}
        disabled={busy !== null || !hasAwb}
        label="Generate documents"
        onPress={() =>
          run("documents", () => generateDocumentsForOrder({ orderId }))
        }
      />

      <StepRow
        title="5 · Track"
        state={
          shipment?.trackedAt
            ? `${shipment.status}${shipment.deliveredAt ? ` · delivered ${new Date(shipment.deliveredAt).toLocaleString()}` : ""} · checked ${new Date(shipment.trackedAt).toLocaleString()}`
            : null
        }
        blocked={hasAwb ? null : "Assign a courier first."}
        busy={busy === "track"}
        disabled={busy !== null || !hasAwb}
        label="Refresh tracking"
        onPress={() => run("track", () => trackOrder({ orderId }))}
      />
    </div>
  );
}

function StepRow({
  title,
  state,
  blocked,
  busy,
  disabled,
  label,
  onPress,
  caution,
}: {
  title: string;
  state: React.ReactNode | null;
  blocked: string | null;
  busy: boolean;
  disabled: boolean;
  label: string;
  onPress: () => void;
  caution?: string;
}) {
  const done = state !== null;
  return (
    <div
      className={cn(
        "border-border flex flex-wrap items-center justify-between gap-3 rounded-md border p-3",
        done && "bg-muted/40",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          {done ? (
            <Check aria-hidden className="text-[var(--fv-green)] size-4" />
          ) : null}
          {title}
        </p>
        <p className="text-muted-foreground mt-0.5 font-mono text-xs break-words">
          {done ? state : (blocked ?? caution ?? "Not done yet.")}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant={done ? "outline" : "default"}
        disabled={disabled}
        onClick={onPress}
        className="min-h-11"
      >
        {busy ? (
          <>
            <Loader2 aria-hidden className="size-4 animate-spin" />
            Working…
          </>
        ) : (
          label
        )}
      </Button>
    </div>
  );
}

function DocLink({ href, label }: { href: string | null; label: string }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 underline underline-offset-2"
    >
      {label}
      <ExternalLink aria-hidden className="size-3" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}
