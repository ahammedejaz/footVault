"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";

import { FieldLabel } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { deleteCategory } from "@/lib/actions/admin/categories";
import { toast } from "@/lib/toast";

/**
 * Deleting a category, which is three different conversations.
 *
 * `ConfirmAction` is the panel's confirmation and every other destructive
 * control on these screens uses it. It cannot express this one, because two of
 * the three outcomes are not a yes/no: a category with sub-categories has no
 * safe delete at all, and a category with products needs somewhere to put them
 * before the question can even be asked. So this is the same dialog primitive
 * with a decision in the middle of it, rather than a second confirmation
 * pattern — the copy rules are `ConfirmAction`'s: name the thing, then say what
 * happens to what depends on it.
 *
 * Both foreign keys pointing at a category are `on delete set null`, so the
 * outcome this is preventing is silent. The server enforces all of it again;
 * this exists so the owner is not told "no" after pressing a red button.
 */
export function DeleteCategory({
  id,
  name,
  childNames,
  productCount,
  destinations,
}: {
  id: string;
  name: string;
  childNames: string[];
  /** Including hidden products — the foreign key does not care that they are hidden. */
  productCount: number;
  /** Everywhere the products could go. Excludes this category. */
  destinations: { id: string; path: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [destination, setDestination] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const selectId = React.useId();

  const blocked = childNames.length > 0;
  const needsDestination = !blocked && productCount > 0;
  const armed = !blocked && (!needsDestination || destination !== "");

  async function run() {
    setPending(true);
    setError(null);
    const result = await deleteCategory({
      id,
      moveProductsTo: destination || null,
    });
    setPending(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    setOpen(false);
    toast.done(
      `${name} deleted`,
      result.movedProducts > 0
        ? `${result.movedProducts} product${result.movedProducts === 1 ? "" : "s"} moved across first.`
        : "It has gone from the shop's menu.",
    );
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (!next) {
          setDestination("");
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Delete ${name}`}>
          <Trash2 className="size-4" />
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-pretty">
            {blocked ? `${name} cannot be deleted yet` : `Delete ${name}?`}
          </DialogTitle>
          <DialogDescription className="text-pretty">
            {blocked
              ? `It has ${childNames.length} sub-categor${childNames.length === 1 ? "y" : "ies"} — ${listOut(childNames)}. Deleting it would leave ${childNames.length === 1 ? "that one" : "them"} loose at the top of the shop's menu, so move or delete ${childNames.length === 1 ? "it" : "them"} first.`
              : productCount > 0
                ? `${productCount} product${productCount === 1 ? " is" : "s are"} filed under it. They have to go somewhere — deleting the category would otherwise leave ${productCount === 1 ? "it" : "them"} with no category at all.`
                : "Nothing is filed under it, so nothing else changes. This cannot be undone."}
          </DialogDescription>
        </DialogHeader>

        {needsDestination ? (
          <div>
            <FieldLabel htmlFor={selectId} required>
              Move {productCount === 1 ? "it" : "them"} to
            </FieldLabel>
            {destinations.length === 0 ? (
              <p className="text-muted-foreground text-sm text-pretty">
                There is nowhere else to put them. Add another category first.
              </p>
            ) : (
              <Select
                id={selectId}
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                disabled={pending}
              >
                <option value="">Choose a category…</option>
                {destinations.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.path}
                  </option>
                ))}
              </Select>
            )}
          </div>
        ) : null}

        {error ? (
          <p className="text-destructive text-sm text-pretty" role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            {blocked ? "Close" : "Keep it"}
          </Button>
          {blocked ? null : (
            <Button
              variant="destructive"
              size="sm"
              onClick={run}
              disabled={pending || !armed}
            >
              {pending
                ? "Working…"
                : needsDestination
                  ? "Move them and delete"
                  : "Delete it"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function listOut(names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}
