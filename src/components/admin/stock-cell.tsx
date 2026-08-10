"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Minus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { adjustStock, loadMovements } from "@/lib/actions/admin/inventory";
import type { MovementRow } from "@/lib/inventory-types";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * The stock number, and everything behind it.
 *
 * "Inline-editable" for stock cannot mean a bare number input, and it is worth
 * saying why rather than looking like a missed requirement. Every change to
 * stock writes a ledger row that carries the admin's name and a required note —
 * that is the whole point of building the ledger first — and a note is not
 * something you type into a table cell. So the cell is a button that opens the
 * one place where a change can be made properly: the current count, a delta,
 * why, and the history of every previous change to that same size.
 *
 * The history is the half that stops this being a form. When the count is wrong
 * the owner's question is never "what should it be", it is "what happened", and
 * that question is answerable here without leaving the row.
 *
 * **A delta, not a new total.** The owner counts what is on the shelf and the
 * instinct is to type that number — so the form asks for the difference and
 * shows the resulting total live, which is the only way both readings stay
 * correct when two people are counting at once.
 */
export function StockCell({
  variantId,
  productName,
  size,
  color,
  sku,
  stock,
  lowThreshold,
}: {
  variantId: string;
  productName: string;
  size: string;
  color: string;
  sku: string;
  stock: number;
  lowThreshold: number;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [current, setCurrent] = React.useState(stock);
  const [delta, setDelta] = React.useState(0);
  const [reason, setReason] = React.useState<"admin_adjustment" | "restock">(
    "restock",
  );
  const [note, setNote] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [movements, setMovements] = React.useState<MovementRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // The server is the source of truth for this number. If the page re-renders
  // with a different count — somebody bought a pair while this was open — the
  // dialog has to follow it rather than keep showing a stale total.
  const [lastServerStock, setLastServerStock] = React.useState(stock);
  if (lastServerStock !== stock) {
    setLastServerStock(stock);
    setCurrent(stock);
  }

  async function openDialog(next: boolean) {
    setOpen(next);
    if (!next) {
      setDelta(0);
      setNote("");
      setError(null);
      return;
    }
    if (movements === null) {
      const result = await loadMovements({ variantId });
      if (result.ok) setMovements(result.movements);
      else setMovements([]);
    }
  }

  async function save() {
    setPending(true);
    setError(null);
    const result = await adjustStock({ variantId, delta, reason, note });
    setPending(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    setCurrent(result.stock);
    setMovements(result.movements);
    setDelta(0);
    setNote("");
    toast.done(
      `${productName} UK ${size} is now ${result.stock}`,
      `${delta > 0 ? "Added" : "Removed"} ${Math.abs(delta)}, recorded against your name.`,
    );
    // The table row behind the dialog still shows the old number until the
    // server re-renders it.
    router.refresh();
  }

  const projected = current + delta;
  const invalid = delta === 0 || projected < 0 || note.trim().length === 0;

  return (
    <Dialog open={open} onOpenChange={openDialog}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            // 36px visual with a 44px reach, matching the `sm` button bargain —
            // this is the most-tapped control in the panel and it is on a tablet.
            "relative inline-flex min-h-9 min-w-14 items-center justify-end rounded-sm px-2 font-mono text-sm tabular-nums transition-colors",
            "before:absolute before:top-1/2 before:left-1/2 before:h-11 before:w-full before:min-w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']",
            "hover:bg-muted",
            current === 0 && "text-destructive font-semibold",
            current > 0 &&
              current <= lowThreshold &&
              "text-orange-ink font-semibold",
          )}
          aria-label={`${productName}, UK ${size}, ${color}. ${current} in stock. Change it.`}
        >
          {current}
        </button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-pretty">
            {productName} — UK {size}
          </DialogTitle>
          <DialogDescription className="text-pretty">
            {color} · <span className="font-mono text-xs">{sku}</span> ·{" "}
            {current} in stock
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <span className="text-sm font-medium">
              How many, and which way?
            </span>
            <div className="mt-1.5 flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="One fewer"
                onClick={() => setDelta((value) => value - 1)}
                disabled={pending}
              >
                <Minus className="size-4" />
              </Button>
              <Input
                type="number"
                inputMode="numeric"
                value={delta === 0 ? "" : String(delta)}
                placeholder="0"
                aria-label="Change in pairs, negative to remove"
                onChange={(event) => {
                  const next = Number.parseInt(event.target.value, 10);
                  setDelta(Number.isFinite(next) ? next : 0);
                }}
                className="w-24 text-center font-mono tabular-nums"
                disabled={pending}
              />
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="One more"
                onClick={() => setDelta((value) => value + 1)}
                disabled={pending}
              >
                <Plus className="size-4" />
              </Button>
              <p
                className={cn(
                  "text-sm tabular-nums",
                  projected < 0
                    ? "text-destructive font-medium"
                    : "text-muted-foreground",
                )}
                aria-live="polite"
              >
                {delta === 0
                  ? "No change"
                  : projected < 0
                    ? `Would be ${projected} — not possible`
                    : `${current} → ${projected}`}
              </p>
            </div>
          </div>

          <fieldset>
            <legend className="text-sm font-medium">Why?</legend>
            <div className="mt-1.5 flex flex-wrap gap-2">
              <ReasonChip
                checked={reason === "restock"}
                onSelect={() => setReason("restock")}
                label="New stock arrived"
                hint="A delivery from the supplier"
              />
              <ReasonChip
                checked={reason === "admin_adjustment"}
                onSelect={() => setReason("admin_adjustment")}
                label="Correcting the count"
                hint="Damaged, miscounted, returned to shelf"
              />
            </div>
          </fieldset>

          <div>
            <label
              htmlFor={`note-${variantId}`}
              className="text-sm font-medium"
            >
              Note{" "}
              <span className="text-muted-foreground font-normal">
                (required)
              </span>
            </label>
            <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
              This is saved with your name against it, and it is what the ledger
              shows when somebody asks why the count changed.
            </p>
            <Input
              id={`note-${variantId}`}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Delivery from Bata, invoice 4471"
              className="mt-1.5"
              disabled={pending}
            />
          </div>

          {error ? (
            <p className="text-destructive text-sm text-pretty" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => openDialog(false)}
              disabled={pending}
            >
              Close
            </Button>
            <Button size="sm" onClick={save} disabled={invalid || pending}>
              {pending ? "Saving…" : "Record the change"}
            </Button>
          </div>
        </div>

        <section className="border-border border-t pt-3">
          <h3 className="text-sm font-semibold">
            What has happened to this size
          </h3>
          {movements === null ? (
            <p className="text-muted-foreground mt-2 text-sm">Loading…</p>
          ) : movements.length === 0 ? (
            <p className="text-muted-foreground mt-2 text-sm text-pretty">
              Nothing recorded yet. Every change from here on appears in this
              list.
            </p>
          ) : (
            <ol className="mt-2 max-h-56 space-y-2 overflow-y-auto pr-1">
              {movements.map((movement) => (
                <li key={movement.id} className="flex gap-3 text-sm">
                  <span
                    className={cn(
                      "w-10 shrink-0 text-right font-mono tabular-nums",
                      movement.delta > 0
                        ? "text-[var(--fv-green)]"
                        : "text-destructive",
                    )}
                  >
                    {movement.delta > 0 ? `+${movement.delta}` : movement.delta}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block">
                      <span className="font-medium">
                        {REASON_LABEL[movement.reason] ?? movement.reason}
                      </span>
                      <span className="text-muted-foreground">
                        {" "}
                        → {movement.balanceAfter} left
                      </span>
                    </span>
                    {movement.note ? (
                      <span className="text-muted-foreground block text-xs text-pretty">
                        {movement.note}
                      </span>
                    ) : null}
                    <span className="text-muted-foreground block text-xs">
                      {new Date(movement.createdAt).toLocaleString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZone: "Asia/Kolkata",
                      })}
                      {movement.actorName
                        ? ` · ${movement.actorName}`
                        : " · automatic"}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}

/** Plain English for the enum. The owner never sees `admin_adjustment`. */
const REASON_LABEL: Record<string, string> = {
  opening_balance: "Opening count",
  order: "Sold",
  cancellation: "Order cancelled",
  sweep: "Unpaid order released",
  admin_adjustment: "Count corrected",
  restock: "New stock",
  shipment: "Shipped",
  unspecified: "Changed outside the panel",
};

function ReasonChip({
  checked,
  onSelect,
  label,
  hint,
}: {
  checked: boolean;
  onSelect: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        "min-h-11 rounded-sm border px-3 py-1.5 text-left transition-colors",
        checked
          ? "border-foreground bg-foreground text-background"
          : "border-border hover:border-foreground/40",
      )}
    >
      <span className="block text-sm font-medium">{label}</span>
      <span
        className={cn(
          "block text-xs",
          checked ? "opacity-80" : "text-muted-foreground",
        )}
      >
        {hint}
      </span>
    </button>
  );
}
