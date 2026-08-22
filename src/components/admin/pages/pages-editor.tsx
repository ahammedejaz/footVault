"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, Eye, Plus, Trash2 } from "lucide-react";

import { FieldLabel } from "@/components/admin/ui";
import { ProseBlocks, hasProse } from "@/components/storefront/prose";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createPage, deletePage, updatePage } from "@/lib/actions/admin/pages";
import type { AdminPageRow } from "@/lib/queries/admin/pages";
import { fillTokens, type ContentTokens } from "@/lib/tokens";
import { toast } from "@/lib/toast";

/**
 * The shop's own pages: About, Contact, the policies.
 *
 * ## Why an accordion and not a page per page
 *
 * Seven rows, edited a handful of times a year. A list that expands in place is
 * one screen, one back button and one mental model — and it is the model the
 * owner already has, because `/admin/appearance` works the same way. A route
 * per page would be three more files and a navigation the owner has to learn
 * to do the same work.
 *
 * ## The preview is the real renderer
 *
 * `ProseBlocks` is imported from the storefront, not reimplemented. It is a
 * pure function of a string with no server dependency, so the preview beside
 * the textarea is byte-for-byte the component that draws `/page/returns`. A
 * hand-rolled preview would agree until somebody taught one of them a rule —
 * which is the exact failure `prose.tsx` was consolidated to prevent, written
 * out in its own header.
 *
 * Tokens are filled in the preview too, through the same `fillTokens` the
 * server uses. That matters more than it looks: `audit:literals` **fails the
 * build** on a rupee figure typed into `pages.body`, so the owner is *required*
 * to write `{{free_shipping_threshold}}` — and a preview that showed them the
 * braces would teach them the token is broken and to type the number instead.
 *
 * ## The web address of an existing page cannot be changed
 *
 * It is linked from the footer of every page, from the checkout's terms
 * acceptance, from Google and from customers' bookmarks. Renaming it does not
 * redirect the old address, it 404s it — and the person who finds out is
 * somebody looking for the returns policy after a parcel arrived damaged. New
 * pages choose their address once; after that the field is read-only and says
 * why. The server enforces this too; this is the half that explains it.
 */

type Draft = {
  title: string;
  body: string;
  metaTitle: string;
  metaDescription: string;
  isPublished: boolean;
};

const META_DESCRIPTION_MAX = 300;

/** Roughly where Google stops printing. Not a limit — a mark on the ruler. */
const META_DESCRIPTION_USEFUL = 160;

export function PagesEditor({
  pages,
  tokens,
}: {
  pages: AdminPageRow[];
  /** What each `{{token}}` resolves to right now, for the preview. */
  tokens: ContentTokens;
}) {
  const [open, setOpen] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);

  return (
    <div className="space-y-4">
      <ol className="space-y-2">
        {pages.map((page) => (
          <li
            key={page.id}
            className="border-border overflow-hidden rounded-lg border"
          >
            <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
              <button
                type="button"
                className="min-h-11 flex-1 text-left"
                aria-expanded={open === page.id}
                onClick={() => setOpen(open === page.id ? null : page.id)}
              >
                <span className="block font-medium">{page.title}</span>
                <span className="text-muted-foreground block font-mono text-xs">
                  /page/{page.slug}
                </span>
              </button>

              {page.isPublished ? (
                <Link
                  href={`/page/${page.slug}`}
                  target="_blank"
                  className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center gap-1.5 text-sm underline-offset-4 hover:underline"
                >
                  <ExternalLink className="size-4" aria-hidden />
                  View
                  <span className="sr-only"> {page.title} on the shop</span>
                </Link>
              ) : (
                <span className="text-muted-foreground border-border rounded-full border px-2 py-0.5 text-xs">
                  Draft — customers cannot see it
                </span>
              )}
            </div>

            {open === page.id ? (
              <PageForm
                page={page}
                tokens={tokens}
                onDone={() => setOpen(null)}
              />
            ) : null}
          </li>
        ))}
      </ol>

      {adding ? (
        <div className="border-border overflow-hidden rounded-lg border">
          <PageForm tokens={tokens} onDone={() => setAdding(false)} />
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          onClick={() => setAdding(true)}
          className="min-h-11"
        >
          <Plus className="size-4" aria-hidden />
          Add a page
        </Button>
      )}
    </div>
  );
}

function PageForm({
  page,
  tokens,
  onDone,
}: {
  /** Absent when adding. */
  page?: AdminPageRow;
  tokens: ContentTokens;
  onDone: () => void;
}) {
  const router = useRouter();
  const editing = page !== undefined;
  const fieldId = React.useId().replace(/:/g, "");

  const [slug, setSlug] = React.useState(page?.slug ?? "");
  const [v, setV] = React.useState<Draft>({
    title: page?.title ?? "",
    body: page?.body ?? "",
    metaTitle: page?.metaTitle ?? "",
    metaDescription: page?.metaDescription ?? "",
    isPublished: page?.isPublished ?? false,
  });
  const [preview, setPreview] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setV((prev) => ({ ...prev, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = editing
      ? await updatePage({ ...v, id: page.id })
      : await createPage({ ...v, slug: slug.trim().toLowerCase() || slugify(v.title) });

    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    toast.done(
      editing ? `${v.title} saved` : `${v.title} added`,
      v.isPublished
        ? "It is live on the shop now."
        : "Saved as a draft — customers cannot see it until you publish it.",
    );
    onDone();
    router.refresh();
  }

  return (
    <form
      onSubmit={submit}
      className="border-border space-y-5 border-t px-3 py-4"
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <FieldLabel htmlFor={`${fieldId}-title`} required>
            Title
          </FieldLabel>
          <Input
            id={`${fieldId}-title`}
            value={v.title}
            onChange={(event) => set("title", event.target.value)}
            maxLength={120}
            required
            disabled={pending}
          />
        </div>

        <div>
          <FieldLabel
            htmlFor={`${fieldId}-slug`}
            required={!editing}
            hint={
              editing
                ? "Fixed. This address is in the footer of every page, in the terms customers agreed to, and in Google — changing it would break all three with no redirect."
                : "This becomes the web address: /page/refunds"
            }
          >
            Web address
          </FieldLabel>
          <Input
            id={`${fieldId}-slug`}
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="refunds"
            maxLength={80}
            required={!editing}
            readOnly={editing}
            spellCheck={false}
            className={`font-mono text-sm${editing ? " bg-muted" : ""}`}
            disabled={pending}
          />
        </div>
      </div>

      <div>
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <FieldLabel htmlFor={`${fieldId}-body`}>The words</FieldLabel>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={preview}
            onClick={() => setPreview((on) => !on)}
          >
            <Eye className="size-4" aria-hidden />
            {preview ? "Back to editing" : "Preview"}
          </Button>
        </div>

        {preview ? (
          <div className="border-border bg-background min-h-40 rounded-lg border p-4">
            {hasProse(v.body) ? (
              <div className="space-y-4">
                <ProseBlocks text={fillTokens(v.body, tokens)} />
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                Nothing typed yet.
              </p>
            )}
          </div>
        ) : (
          <textarea
            id={`${fieldId}-body`}
            value={v.body}
            onChange={(event) => set("body", event.target.value)}
            rows={14}
            maxLength={30_000}
            disabled={pending}
            spellCheck
            className="border-input placeholder:text-muted-foreground disabled:bg-muted w-full rounded-lg border bg-transparent px-3 py-2 font-mono text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          />
        )}

        <p className="text-muted-foreground mt-1.5 text-sm text-pretty">
          Leave a blank line between paragraphs. A block of lines that all start
          with <code>- </code> becomes a bulleted list, and{" "}
          <code>**words**</code> come out bold. That is the whole format —
          nothing else is interpreted, which is why nothing typed here can break
          the page.
        </p>
        <TokenHelp tokens={tokens} />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <FieldLabel
            htmlFor={`${fieldId}-meta-title`}
            hint="What Google shows as the blue link. Leave it empty to use the title above."
          >
            Search title
          </FieldLabel>
          <Input
            id={`${fieldId}-meta-title`}
            value={v.metaTitle}
            onChange={(event) => set("metaTitle", event.target.value)}
            maxLength={120}
            disabled={pending}
          />
        </div>

        <div>
          <FieldLabel
            htmlFor={`${fieldId}-meta-description`}
            hint="The grey sentence under it."
          >
            Search description
          </FieldLabel>
          <Input
            id={`${fieldId}-meta-description`}
            value={v.metaDescription}
            onChange={(event) => set("metaDescription", event.target.value)}
            maxLength={META_DESCRIPTION_MAX}
            disabled={pending}
          />
          {/*
            This field is why the pages editor exists as much as anything does.
            `/page/returns` shipped a meta description promising a seven-day
            free return and size exchange, against a body saying replacement
            only, no refunds, within 24 hours — the single worst sentence on the
            shop, sitting in a column nobody could edit. So the count is on
            screen and the sentence next to it says what the field is *for*.
          */}
          <p className="text-muted-foreground mt-1 text-sm text-pretty">
            {v.metaDescription.length} of {META_DESCRIPTION_MAX} used
            {v.metaDescription.length > META_DESCRIPTION_USEFUL
              ? ` — Google stops printing at about ${META_DESCRIPTION_USEFUL}, so the first sentence is the one that counts.`
              : "."}{" "}
            Make sure it says the same thing the page does.
          </p>
        </div>
      </div>

      <label className="flex min-h-11 items-center gap-2.5">
        <input
          type="checkbox"
          checked={v.isPublished}
          onChange={(event) => set("isPublished", event.target.checked)}
          disabled={pending}
          className="accent-foreground size-5"
        />
        <span className="text-sm">
          Show it on the shop
          <span className="text-muted-foreground block text-xs">
            Off, it is a draft: the page 404s for customers and disappears from
            the footer. Your own link above still opens it.
          </span>
        </span>
      </label>

      {error ? (
        <p className="text-destructive text-sm text-pretty" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending || !v.title.trim()}>
          {pending ? "Saving…" : editing ? "Save" : "Add the page"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onDone}
          disabled={pending}
        >
          Cancel
        </Button>
        {editing ? <DeletePage page={page} onDone={onDone} /> : null}
      </div>
    </form>
  );
}

/**
 * Deleting a page, guarded by its own address typed out.
 *
 * Not because one row is hard to restore — because the seven that exist are
 * linked from the footer of every page and two of them are the terms a customer
 * agreed to at checkout. This panel is used on a phone; a destructive action
 * one tap from an edit form is a destructive action that eventually happens by
 * accident.
 */
function DeletePage({
  page,
  onDone,
}: {
  page: AdminPageRow;
  onDone: () => void;
}) {
  const router = useRouter();
  const [arming, setArming] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const fieldId = React.useId().replace(/:/g, "");

  if (!arming) {
    return (
      <Button
        type="button"
        variant="ghost"
        className="text-destructive ml-auto"
        onClick={() => setArming(true)}
      >
        <Trash2 className="size-4" aria-hidden />
        Delete
      </Button>
    );
  }

  return (
    <div className="border-destructive/40 w-full space-y-2 rounded-lg border p-3">
      <label htmlFor={`${fieldId}-confirm`} className="block text-sm">
        This removes <strong>{page.title}</strong> and the address{" "}
        <code>/page/{page.slug}</code> stops working for anyone who has it
        saved. Type <code>{page.slug}</code> to confirm.
      </label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={`${fieldId}-confirm`}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          className="max-w-56 font-mono text-sm"
          autoComplete="off"
          spellCheck={false}
          disabled={pending}
        />
        <Button
          type="button"
          variant="destructive"
          disabled={pending || typed.trim().toLowerCase() !== page.slug}
          onClick={async () => {
            setPending(true);
            const result = await deletePage({
              id: page.id,
              confirmSlug: typed.trim().toLowerCase(),
            });
            setPending(false);
            if (!result.ok) {
              toast.failed(result.message);
              return;
            }
            toast.done(`${page.title} deleted`);
            onDone();
            router.refresh();
          }}
        >
          {pending ? "Deleting…" : "Delete this page"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setArming(false);
            setTyped("");
          }}
          disabled={pending}
        >
          Keep it
        </Button>
      </div>
    </div>
  );
}

/**
 * The tokens, with what each one says today.
 *
 * Not a link to documentation. `audit:literals` fails the build on a rupee
 * figure, a day count or a clock time typed into `pages.body`, so the owner is
 * *required* to use these — and a requirement whose vocabulary lives somewhere
 * else is a requirement people work around by typing the number. Showing the
 * current value beside each name is what makes the trade obvious: type the
 * token, get the number, and it stays right when the number changes.
 */
function TokenHelp({ tokens }: { tokens: ContentTokens }) {
  const [open, setOpen] = React.useState(false);
  const names = Object.keys(tokens).sort();
  if (names.length === 0) return null;

  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((on) => !on)}
        className="min-h-11 text-sm underline underline-offset-4"
      >
        {open ? "Hide" : "Show"} the {names.length} things the shop fills in for
        you
      </button>
      {open ? (
        <>
          <p className="text-muted-foreground mt-1 text-sm text-pretty">
            Type the name in braces and the shop prints the live value. Use
            these instead of typing a price, a number of days or a time —
            otherwise the page keeps promising an old figure after you change
            it, and the build will refuse the page anyway.
          </p>
          <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
            {names.map((name) => (
              <div key={name} className="flex flex-wrap gap-x-2">
                <dt className="font-mono text-xs">{`{{${name}}}`}</dt>
                <dd className="text-muted-foreground">{tokens[name]}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}
    </div>
  );
}

/** The address a title suggests, for a new page only. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
