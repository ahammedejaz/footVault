"use client";

import * as React from "react";
import { Dialog } from "radix-ui";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Gender } from "@/lib/catalog-types";
import { conversionsFor } from "@/lib/size-guide";
import { cn } from "@/lib/utils";

/**
 * The size guide.
 *
 * A modal rather than a separate page because it is consulted *while* choosing
 * a size — sending someone to /page/size-guide loses the product they were
 * looking at, and asking them to come back with a number in their head is how
 * a return gets created.
 *
 * Radix handles the focus trap, the Escape key, the scroll lock and the return
 * of focus to the trigger. The table shows only the run for this product's
 * gender, because a woman looking at a women's shoe has no use for the men's
 * column and every extra column is a column to get lost in on a 390px screen.
 */
export function SizeGuidePanel({
  gender,
  highlight,
  open,
  onOpenChange,
}: {
  gender: Gender;
  highlight?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rows = conversionsFor(gender);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="bg-background data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 fixed top-1/2 left-1/2 z-50 flex max-h-[88vh] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border shadow-lg">
          <div className="flex items-start justify-between gap-4 p-5 pb-3">
            <div>
              <Dialog.Title className="font-display text-lg font-bold tracking-[-0.02em] uppercase">
                Size guide
              </Dialog.Title>
              <Dialog.Description className="text-muted-foreground mt-1 text-sm">
                UK is what we list. Conversions are approximate — brands differ by
                up to half a size.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close the size guide">
                <X />
              </Button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
            <table className="w-full border-collapse text-left font-mono text-sm tabular-nums">
              <caption className="sr-only">
                UK, EU, US and foot length in centimetres for every size in this run
              </caption>
              <thead>
                <tr className="border-border border-b">
                  {["UK", "EU", "US", "Foot (cm)"].map((head) => (
                    <th
                      key={head}
                      scope="col"
                      className="text-muted-foreground py-2 text-xs font-normal tracking-[0.06em] uppercase"
                    >
                      {head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.uk}
                    className={cn(
                      "border-border/60 border-b last:border-0",
                      row.uk === highlight && "bg-orange/15",
                    )}
                  >
                    <th scope="row" className="py-2.5 font-medium">
                      {row.uk}
                      {row.uk === highlight ? (
                        <span className="sr-only"> — the size you have selected</span>
                      ) : null}
                    </th>
                    <td className="py-2.5">{row.eu}</td>
                    <td className="py-2.5">{row.us}</td>
                    <td className="py-2.5">{row.cm}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="border-border mt-6 border-t pt-4">
              <h3 className="font-mono text-xs tracking-[0.06em] uppercase">
                Measuring a foot
              </h3>
              <ol className="text-muted-foreground mt-3 list-decimal space-y-2 pl-5 text-sm">
                <li>Stand on a sheet of paper against a wall, heel touching it.</li>
                <li>Mark the end of the longest toe and measure heel to mark.</li>
                <li>
                  Measure both feet in the evening, when they are at their largest,
                  and use the longer one.
                </li>
                <li>Match that number to the centimetre column above.</li>
              </ol>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
