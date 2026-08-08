"use client";

import * as React from "react";
import { Copy, Trash2 } from "lucide-react";

import { ConfirmAction } from "@/components/admin/confirm-action";
import { Button } from "@/components/ui/button";
import { deleteMedia } from "@/lib/actions/admin/media";
import { toast } from "@/lib/toast";

export type MediaUsageSummary = {
  productId: string;
  productName: string;
  isPrimary: boolean;
};

/**
 * Copy the address, and delete the file.
 *
 * **The confirmation names the products.** A photograph in this bucket is not
 * a loose file — a `product_images` row points at it, and deleting the object
 * alone would leave the product page rendering an image element for something
 * that 404s. So the delete takes those rows with it, and the sentence the owner
 * reads before pressing says which products change and whether one of them
 * loses its main picture. When anything is using it, the confirmation also asks
 * for the word to be typed: this is the one action on these four screens that
 * changes a page customers are looking at right now.
 *
 * Copying the address is here because it is what makes the rest of the panel
 * work — the brand form and the product editor both take a pasted URL.
 */
export function MediaItemActions({
  path,
  fileName,
  publicUrl,
  usedBy,
}: {
  path: string;
  fileName: string;
  publicUrl: string;
  usedBy: MediaUsageSummary[];
}) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.done("Address copied", "Paste it into a product or a brand.");
    } catch {
      toast.failed(
        "This browser would not let the page copy. Select the address by hand.",
      );
    }
  }

  const names = [...new Set(usedBy.map((row) => row.productName))];
  const primaryFor = usedBy.filter((row) => row.isPrimary).length;

  return (
    <div className="flex items-center justify-between gap-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={copy}
        aria-label={`Copy the address of ${fileName}`}
      >
        <Copy className="size-4" aria-hidden />
        {copied ? "Copied" : "Copy address"}
      </Button>

      <ConfirmAction
        subject={`Delete ${fileName}?`}
        consequence={
          names.length === 0
            ? "No product is using this photograph, so nothing on the shop changes. It cannot be recovered."
            : `${listOut(names)} ${names.length === 1 ? "is" : "are"} using it. Deleting takes the photograph off ${names.length === 1 ? "that product" : "those products"} as well as out of storage${primaryFor > 0 ? `, and it is the main picture on ${primaryFor} of them` : ""}. It cannot be recovered.`
        }
        confirmLabel={names.length === 0 ? "Delete it" : "Delete it anyway"}
        triggerLabel={
          <>
            <Trash2 className="size-4" aria-hidden />
            <span className="sr-only">Delete {fileName}</span>
          </>
        }
        triggerVariant="ghost"
        triggerSize="icon-sm"
        triggerClassName="text-muted-foreground hover:text-destructive"
        // Typing is reserved for the case that changes a live page. Asking for
        // it on an unused file would make it noise, and noise is what makes a
        // typed confirmation stop being read.
        requireTyping={names.length === 0 ? undefined : "delete"}
        action={() => deleteMedia({ path, acknowledgeUsage: true })}
        successMessage={
          names.length === 0
            ? `${fileName} deleted`
            : `${fileName} deleted and taken off ${names.length === 1 ? "1 product" : `${names.length} products`}`
        }
      />
    </div>
  );
}

function listOut(names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}
