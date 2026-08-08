"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

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
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { createCategory, updateCategory } from "@/lib/actions/admin/categories";
import { toast } from "@/lib/toast";

/**
 * One form for adding a category and for editing one.
 *
 * Two shapes of the same thing would drift — the add form would grow a field
 * the edit form never got — and the fields are identical because the row is.
 *
 * **The web address is derived until it is touched.** A slug the owner has to
 * think about is a slug that ends up as "mens-shoes-2". So it follows the name
 * while the field is untouched, and stops the moment it is edited by hand. When
 * editing an existing category it never follows: the address is already in
 * customers' history and on Google, and quietly changing it because somebody
 * fixed a typo in the name is how a live page 404s.
 *
 * The parent list arrives as a prop rather than being fetched here. It is
 * filtered on the server against the depth the storefront can render, so this
 * component cannot offer a nesting that the action would then refuse.
 */

export type ParentChoice = { id: string; path: string };

export type CategoryDraft = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parentId: string | null;
  isActive: boolean;
};

export function CategoryForm({
  category,
  parents,
  triggerLabel,
  triggerVariant = "outline",
  triggerSize = "sm",
  triggerClassName,
}: {
  /** Absent when adding. */
  category?: CategoryDraft;
  parents: ParentChoice[];
  triggerLabel: React.ReactNode;
  triggerVariant?: "default" | "outline" | "ghost" | "secondary";
  triggerSize?: "sm" | "default" | "icon-sm";
  triggerClassName?: string;
}) {
  const router = useRouter();
  const editing = category !== undefined;

  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState(category?.name ?? "");
  const [slug, setSlug] = React.useState(category?.slug ?? "");
  const [slugTouched, setSlugTouched] = React.useState(editing);
  const [description, setDescription] = React.useState(
    category?.description ?? "",
  );
  const [parentId, setParentId] = React.useState(category?.parentId ?? "");
  const [isActive, setIsActive] = React.useState(category?.isActive ?? true);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const fieldId = React.useId();

  function reset() {
    setName(category?.name ?? "");
    setSlug(category?.slug ?? "");
    setSlugTouched(editing);
    setDescription(category?.description ?? "");
    setParentId(category?.parentId ?? "");
    setIsActive(category?.isActive ?? true);
    setError(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const payload = {
      name,
      slug: slug || slugify(name),
      description: description.trim() ? description : null,
      parentId: parentId || null,
      isActive,
    };
    const result = editing
      ? await updateCategory({ ...payload, id: category.id })
      : await createCategory(payload);
    setPending(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    setOpen(false);
    if (!editing) reset();
    toast.done(
      editing ? `${name} saved` : `${name} added`,
      editing
        ? "The shop's menu updates straight away."
        : "It is in the shop's menu now — give it some products next.",
    );
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        // Reset on the way in as well as on the way out. The dialog keeps its
        // state across a `router.refresh()`, so without this an owner who edits
        // a category, closes, and reopens it sees what they typed rather than
        // what the row now says — which differ the moment somebody else saves.
        reset();
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant={triggerVariant}
          size={triggerSize}
          className={triggerClassName}
        >
          {triggerLabel}
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-pretty">
            {editing ? `Edit ${category.name}` : "Add a category"}
          </DialogTitle>
          <DialogDescription className="text-pretty">
            {editing
              ? "Customers see this in the shop's menu and at the top of its listing page."
              : "A group in the shop's menu. You can nest it under an existing one."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <FieldLabel htmlFor={`${fieldId}-name`} required>
              Name
            </FieldLabel>
            <Input
              id={`${fieldId}-name`}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (!slugTouched) setSlug(slugify(event.target.value));
              }}
              placeholder="Sneakers"
              maxLength={60}
              required
              autoComplete="off"
              disabled={pending}
            />
          </div>

          <div>
            <FieldLabel
              htmlFor={`${fieldId}-slug`}
              required
              hint={
                editing
                  ? "Changing this breaks any link a customer has already saved."
                  : "This becomes the web address: /shop/sneakers"
              }
            >
              Web address
            </FieldLabel>
            <Input
              id={`${fieldId}-slug`}
              value={slug}
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(event.target.value);
              }}
              placeholder="sneakers"
              maxLength={60}
              required
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-sm"
              disabled={pending}
            />
          </div>

          <div>
            <FieldLabel
              htmlFor={`${fieldId}-parent`}
              hint="The shop's menu shows two levels, so a sub-category cannot have its own."
            >
              Sits under
            </FieldLabel>
            <Select
              id={`${fieldId}-parent`}
              value={parentId}
              onChange={(event) => setParentId(event.target.value)}
              disabled={pending}
            >
              <option value="">Nothing — show it at the top level</option>
              {parents.map((parent) => (
                <option key={parent.id} value={parent.id}>
                  {parent.path}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <FieldLabel
              htmlFor={`${fieldId}-description`}
              hint="Shown under the heading on the category's page. Optional."
            >
              Description
            </FieldLabel>
            <textarea
              id={`${fieldId}-description`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              maxLength={300}
              disabled={pending}
              className="border-input placeholder:text-muted-foreground disabled:bg-muted w-full rounded-lg border bg-transparent px-3 py-2 text-base transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          <label className="flex min-h-11 items-center gap-2.5">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
              disabled={pending}
              className="accent-foreground size-5"
            />
            <span className="text-sm">
              Show it in the shop
              <span className="text-muted-foreground block text-xs">
                Switched off, it disappears from the menu. Its products stay
                where they are.
              </span>
            </span>
          </label>

          {error ? (
            <p className="text-destructive text-sm text-pretty" role="alert">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending || !name.trim()}>
              {pending ? "Saving…" : editing ? "Save" : "Add it"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Mirrors what the action's schema will accept, so the field never fails it. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
