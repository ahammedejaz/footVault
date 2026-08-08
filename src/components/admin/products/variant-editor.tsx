"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";

import { ConfirmAction } from "@/components/admin/confirm-action";
import { StockCell } from "@/components/admin/stock-cell";
import { Table, TableWrap, Td, Th } from "@/components/admin/table";
import { describedBy, Field } from "@/components/admin/products/field";
import { Chip, EmptyState, Panel } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { deleteVariant, saveVariant } from "@/lib/actions/admin/products";
import { formatPaise } from "@/lib/format";
import { toast } from "@/lib/toast";
import type { AdminVariant } from "@/components/admin/products/types";

/**
 * The size run: one row per size and colourway, which is what a variant is.
 *
 * **The stock column is `StockCell`, the same control the inventory screen
 * uses.** It is not a number input, and that is the point: every change to
 * stock writes a ledger row carrying the admin's name and a required note, and
 * a note is not something you type into a table cell. Reusing the component
 * rather than building a second stock editor here is what stops the two screens
 * from disagreeing about what changing a count involves.
 *
 * Everything else about a size — its SKU, its price, whether it is sold at all
 * — is edited in a dialog, because those fields belong together and a row of
 * seven inline inputs on a tablet is a row of seven mis-taps.
 */
export function VariantEditor({
  productId,
  productName,
  productSlug,
  basePrice,
  salePrice,
  variants,
  lowStockThreshold,
}: {
  productId: string;
  productName: string;
  productSlug: string;
  basePrice: number;
  salePrice: number | null;
  variants: AdminVariant[];
  lowStockThreshold: number;
}) {
  const [editing, setEditing] = React.useState<AdminVariant | null>(null);
  const [adding, setAdding] = React.useState(false);

  const productPrice = salePrice ?? basePrice;

  return (
    <Panel
      title="Sizes"
      description="One row per size and colourway. This is what a customer picks and what stock is counted against."
      actions={
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="size-4" aria-hidden />
          Add a size
        </Button>
      }
    >
      {variants.length === 0 ? (
        <EmptyState
          title="No sizes yet"
          body="A product with no sizes cannot be bought — the shop has nothing to put in the bag. Use “Add a size” above for each size and colourway you have on the shelf, with the count of each."
        />
      ) : (
        <TableWrap label={`Sizes for ${productName}`}>
          <Table className="min-w-[44rem]">
            <thead>
              <tr>
                <Th>Size</Th>
                <Th>Colour</Th>
                <Th>SKU</Th>
                <Th numeric>Price</Th>
                <Th>Sold</Th>
                <Th numeric>In stock</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {variants.map((variant) => (
                <tr key={variant.id} className="hover:bg-muted/40">
                  <Td className="font-mono text-xs whitespace-nowrap">
                    {variant.size}
                  </Td>
                  <Td className="max-w-[12rem]">
                    <span className="flex items-center gap-2">
                      {variant.colorHex ? (
                        <span
                          aria-hidden
                          className="border-border size-4 shrink-0 rounded-full border"
                          style={{ backgroundColor: variant.colorHex }}
                        />
                      ) : null}
                      <span className="truncate">{variant.color}</span>
                    </span>
                  </Td>
                  <Td className="text-muted-foreground font-mono text-xs">
                    {variant.sku}
                  </Td>
                  <Td numeric className="whitespace-nowrap">
                    {variant.priceOverride ? (
                      <span className="font-medium">
                        {formatPaise(variant.priceOverride)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        {formatPaise(productPrice)}
                      </span>
                    )}
                  </Td>
                  <Td>
                    {variant.isActive ? (
                      <Chip tone="good">on</Chip>
                    ) : (
                      <Chip tone="neutral">off</Chip>
                    )}
                  </Td>
                  <Td numeric className="pr-1">
                    <StockCell
                      variantId={variant.id}
                      productName={productName}
                      size={variant.size}
                      color={variant.color}
                      sku={variant.sku}
                      stock={variant.stock}
                      lowThreshold={lowStockThreshold}
                    />
                  </Td>
                  <Td>
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing(variant)}
                      >
                        Edit
                      </Button>
                      {variant.orderCount > 0 ? (
                        // No delete, and the reason is on screen rather than
                        // behind a refused click: severing this row would take
                        // `order_items.variant_id` to null on a real order.
                        <span className="text-muted-foreground text-xs whitespace-nowrap">
                          on {variant.orderCount}{" "}
                          {variant.orderCount === 1 ? "order" : "orders"}
                        </span>
                      ) : (
                        <ConfirmAction
                          subject={`Delete ${variant.size} in ${variant.color}?`}
                          consequence="This size has never been ordered, so it goes for good along with its stock history. This cannot be undone."
                          confirmLabel="Delete it"
                          triggerLabel="Delete"
                          triggerVariant="ghost"
                          action={() => deleteVariant({ id: variant.id })}
                          successMessage={`${variant.size} in ${variant.color} has gone`}
                        />
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}

      <VariantDialog
        key={editing?.id ?? (adding ? "new" : "closed")}
        open={adding || editing !== null}
        variant={editing}
        productId={productId}
        productSlug={productSlug}
        onClose={() => {
          setAdding(false);
          setEditing(null);
        }}
      />
    </Panel>
  );
}

/* ----------------------------------------------------------------- dialog -- */

type Draft = {
  size: string;
  color: string;
  colorHex: string;
  sku: string;
  priceOverride: string;
  isActive: boolean;
  openingStock: string;
};

/**
 * Add or correct one size.
 *
 * **The stock box only appears when creating.** A new variant's opening balance
 * rides along with the INSERT and the `product_variants_record_opening` trigger
 * turns it into an `opening_balance` ledger row; there is nothing to attribute
 * because nothing was there before. Changing an existing count is a different
 * act — it needs a reason and a note — and it happens through the count in the
 * table, which is the same control the inventory screen uses. Offering a second
 * way to do it here would be offering a way to do it without a note.
 */
function VariantDialog({
  open,
  variant,
  productId,
  productSlug,
  onClose,
}: {
  open: boolean;
  variant: AdminVariant | null;
  productId: string;
  productSlug: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = React.useState<Draft>(() => ({
    size: variant?.size ?? "",
    color: variant?.color ?? "",
    colorHex: variant?.colorHex ?? "",
    sku: variant?.sku ?? "",
    priceOverride:
      variant?.priceOverride === null || variant?.priceOverride === undefined
        ? ""
        : String(variant.priceOverride / 100),
    isActive: variant?.isActive ?? true,
    openingStock: "0",
  }));
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setError(null);
  }

  /**
   * A SKU nobody has to invent.
   *
   * Only ever a *suggestion*, written into the box on blur when it is empty, so
   * the owner can see it and change it. Generating it on the server instead
   * would produce a code that appears after saving, which is the point at which
   * it is too late to disagree with.
   */
  function suggestSku() {
    if (draft.sku.trim() || !draft.size.trim() || !draft.color.trim()) return;
    const part = (value: string) =>
      value
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "")
        .slice(0, 6);
    const prefix = productSlug
      .split("-")
      .map((word) => word.slice(0, 3).toUpperCase())
      .join("")
      .slice(0, 9);
    set(
      "sku",
      [prefix, part(draft.color), part(draft.size)].filter(Boolean).join("-"),
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const price = draft.priceOverride.trim();
    const parsedPrice = price ? Number(price) : null;
    if (price && (parsedPrice === null || !Number.isFinite(parsedPrice))) {
      setError(
        "That price is not a number. Leave it blank to use the product price.",
      );
      return;
    }
    const stock = Number(draft.openingStock.trim() || "0");
    if (!Number.isFinite(stock) || stock < 0) {
      setError("The opening count has to be zero or more.");
      return;
    }

    setPending(true);
    const result = await saveVariant({
      id: variant?.id,
      productId,
      size: draft.size,
      color: draft.color,
      colorHex: draft.colorHex,
      sku: draft.sku,
      priceOverrideRupees: parsedPrice,
      isActive: draft.isActive,
      openingStock: Math.round(stock),
    });
    setPending(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    toast.done(
      result.created
        ? `${draft.size} in ${draft.color} has been added`
        : `${draft.size} in ${draft.color} has been saved`,
      result.created && Math.round(stock) > 0
        ? `Opening count of ${Math.round(stock)} recorded in the ledger.`
        : undefined,
    );
    onClose();
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{variant ? "Edit this size" : "Add a size"}</DialogTitle>
          <DialogDescription className="text-pretty">
            {variant
              ? "The count is changed from the table, where it is recorded with your name and a reason."
              : "One row per size and colourway. The opening count goes straight into the stock ledger."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} noValidate className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field htmlFor="variant-size" label="Size" required>
              <Input
                id="variant-size"
                value={draft.size}
                onChange={(event) => set("size", event.target.value)}
                onBlur={suggestSku}
                placeholder="8"
                autoComplete="off"
                required
              />
            </Field>

            <Field htmlFor="variant-color" label="Colourway" required>
              <Input
                id="variant-color"
                value={draft.color}
                onChange={(event) => set("color", event.target.value)}
                onBlur={suggestSku}
                placeholder="Black / Volt"
                autoComplete="off"
                required
              />
            </Field>

            <Field
              htmlFor="variant-hex"
              label="Swatch colour"
              hint="Drives the colour swatch and the colour filter."
            >
              <div className="flex items-center gap-2">
                <Input
                  id="variant-hex"
                  value={draft.colorHex}
                  onChange={(event) => set("colorHex", event.target.value)}
                  placeholder="#1b1b1b"
                  autoComplete="off"
                  className="font-mono"
                />
                <input
                  type="color"
                  value={
                    /^#[0-9a-fA-F]{6}$/.test(draft.colorHex)
                      ? draft.colorHex
                      : "#000000"
                  }
                  onChange={(event) => set("colorHex", event.target.value)}
                  aria-label="Pick the swatch colour"
                  className="border-input size-11 shrink-0 cursor-pointer rounded-lg border bg-transparent p-1"
                />
              </div>
            </Field>

            <Field
              htmlFor="variant-sku"
              label="SKU"
              required
              hint="Unique across the whole shop."
            >
              <Input
                id="variant-sku"
                value={draft.sku}
                onChange={(event) => set("sku", event.target.value)}
                placeholder="NIKAIRMAX-BLACK-8"
                autoComplete="off"
                className="font-mono"
                aria-describedby={describedBy("variant-sku", { hint: true })}
                required
              />
            </Field>

            <Field
              htmlFor="variant-price"
              label="Price for this size"
              hint="Rupees. Blank uses the product price."
            >
              <Input
                id="variant-price"
                value={draft.priceOverride}
                onChange={(event) => set("priceOverride", event.target.value)}
                inputMode="decimal"
                placeholder="—"
                autoComplete="off"
                className="font-mono tabular-nums"
                aria-describedby={describedBy("variant-price", { hint: true })}
              />
            </Field>

            {variant ? null : (
              <Field
                htmlFor="variant-stock"
                label="Opening count"
                hint="How many pairs are on the shelf right now. It is written straight into the stock ledger."
              >
                <Input
                  id="variant-stock"
                  value={draft.openingStock}
                  onChange={(event) => set("openingStock", event.target.value)}
                  inputMode="numeric"
                  autoComplete="off"
                  className="font-mono tabular-nums"
                  aria-describedby={describedBy("variant-stock", {
                    hint: true,
                  })}
                />
              </Field>
            )}
          </div>

          <label className="flex min-h-11 cursor-pointer items-start gap-3 py-1">
            <input
              type="checkbox"
              checked={draft.isActive}
              onChange={(event) => set("isActive", event.target.checked)}
              className="accent-foreground mt-0.5 size-5 cursor-[inherit]"
            />
            <span>
              <span className="block text-sm font-medium">
                Customers can buy this size
              </span>
              <span className="text-muted-foreground block text-xs text-pretty">
                Turn it off to stop selling a size without losing its history.
              </span>
            </span>
          </label>

          {error ? (
            <p className="text-destructive text-sm text-pretty" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : variant ? "Save this size" : "Add it"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
