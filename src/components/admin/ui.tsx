import Link from "next/link";
import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The admin's shared furniture.
 *
 * Everything here is a Server Component. The panel is mostly reading and
 * displaying, and shipping a client bundle for a page header is how an admin
 * panel ends up slower than the shop it administers — which matters more here
 * than it looks, because the owner is on shop wifi on a tablet.
 *
 * Density is the whole visual argument. Same tokens as the storefront, same
 * type scale, roughly half the vertical rhythm: `py-4` where the shop uses
 * `py-10`, 14px body where the shop uses 16px. It reads as a different place
 * without being a different design.
 */

export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  /** Primary actions, right-aligned on a wide screen and wrapped below it. */
  children?: React.ReactNode;
}) {
  return (
    <div className="border-border flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b px-4 py-4 sm:px-6">
      <div className="min-w-0">
        <h1 className="font-display text-2xl leading-none font-extrabold tracking-[-0.02em] uppercase">
          {title}
        </h1>
        {description ? (
          <p className="text-muted-foreground mt-1.5 max-w-prose text-sm text-pretty">
            {description}
          </p>
        ) : null}
      </div>
      {children ? (
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}

/** The content well every admin page sits in. */
export function AdminPage({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("px-4 py-5 sm:px-6", className)}>{children}</div>;
}

export function Panel({
  title,
  description,
  children,
  className,
  actions,
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  actions?: React.ReactNode;
}) {
  return (
    <section className={cn("border-border rounded-md border", className)}>
      {title ? (
        <header className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{title}</h2>
            {description ? (
              <p className="text-muted-foreground mt-0.5 text-sm text-pretty">
                {description}
              </p>
            ) : null}
          </div>
          {actions}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

/**
 * A panel that starts closed.
 *
 * **`<details>` rather than state, and that is the whole point of it.** This
 * file is Server Components throughout; a disclosure built on `useState` would
 * drag the panel it wraps across the client boundary along with every field
 * inside it. The element does open-and-close natively, keyboard included, and
 * — the part that is easy to miss — browser find-in-page opens a closed
 * `<details>` to reveal a match, which no hand-rolled version does.
 *
 * What goes in one: fields that are **optional and have a working default**.
 * Parcel dimensions fall back to the shop's box, the search title falls back to
 * the product name. Nothing required is ever hidden behind a summary, because a
 * form that cannot be submitted until you open something is worse than a long
 * form — the owner reads the error, looks at the fields in front of them, and
 * cannot see the one it refers to.
 *
 * The summary says what is inside *and* what happens if it is left alone. "What
 * the courier is told" is a heading; "left alone, the shop's usual box is used"
 * is the sentence that lets the owner skip it without wondering.
 */
export function Disclosure({
  title,
  hint,
  children,
  className,
}: {
  title: string;
  /** What happens if this is never opened. Always answerable, or leave it out. */
  hint: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <details className={cn("border-border rounded-md border", className)}>
      <summary
        className={cn(
          // `list-none` plus the marker reset kills the native triangle in both
          // engines; the chevron below is drawn from the open state instead so
          // it can sit on the right where the tap target already is.
          "flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-4 py-3",
          "marker:content-[''] [&::-webkit-details-marker]:hidden",
          "hover:bg-muted/40 rounded-md transition-colors",
        )}
      >
        <span className="min-w-0">
          <span className="block text-base font-semibold">{title}</span>
          <span className="text-muted-foreground block text-sm text-pretty">
            {hint}
          </span>
        </span>
        <ChevronDown
          className="text-muted-foreground size-4 shrink-0 transition-transform [details[open]_&]:rotate-180"
          aria-hidden
        />
      </summary>
      <div className="border-border border-t p-4">{children}</div>
    </details>
  );
}

/**
 * A number on the dashboard.
 *
 * `tabular-nums` so a column of these does not shuffle horizontally as the
 * digits change — the owner reads these at a glance, and a figure that jitters
 * reads as a figure that is loading.
 */
export function StatTile({
  label,
  value,
  hint,
  href,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  hint?: string;
  href?: string;
  tone?: "neutral" | "warn" | "good";
}) {
  const body = (
    <>
      <p className="text-muted-foreground font-mono text-xs tracking-[0.06em] uppercase">
        {label}
      </p>
      <p
        className={cn(
          "mt-1.5 text-2xl leading-none font-extrabold tabular-nums",
          tone === "warn" && "text-destructive",
          tone === "good" && "text-[var(--fv-green)]",
        )}
      >
        {value}
      </p>
      {hint ? (
        <p className="text-muted-foreground mt-1 text-xs text-pretty">{hint}</p>
      ) : null}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="border-border hover:border-foreground/40 block rounded-md border p-4 transition-colors"
      >
        {body}
      </Link>
    );
  }
  return <div className="border-border rounded-md border p-4">{body}</div>;
}

/**
 * What an empty table says.
 *
 * The brief asked for an empty state that tells the owner what to do first, and
 * that is a stricter requirement than it sounds: "No products yet" is not it.
 * Every caller passes an action, because a dead end in an admin panel is a
 * support call.
 */
export function EmptyState({
  title,
  body,
  actionHref,
  actionLabel,
}: {
  title: string;
  body: string;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <div className="border-border rounded-md border border-dashed px-6 py-12 text-center">
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="text-muted-foreground mx-auto mt-1.5 max-w-md text-sm text-pretty">
        {body}
      </p>
      {actionHref && actionLabel ? (
        <Button size="sm" className="mt-4" asChild>
          <Link href={actionHref}>{actionLabel}</Link>
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Chip colours, measured rather than eyeballed.
 *
 * A tinted background eats the contrast the text token was chosen for. The
 * orange ink is documented at 5.20:1 — but that is against paper, and behind a
 * 22% orange fill it measured 4.36:1, under AA for a 12px label. Green was
 * worse at 4.13:1, because `--fv-green` was serving as both the fill and the
 * text and cannot do both.
 *
 * Now: green gets its own ink (5.28:1 on its own tint) and the orange fill
 * drops to 14% (4.65:1). Both verified by `npm run audit:admin-pages`, which
 * runs axe over every admin screen and is what caught this.
 */
const CHIP_TONES = {
  neutral: "bg-muted text-foreground",
  good: "bg-[color-mix(in_srgb,var(--fv-green)_16%,transparent)] text-[var(--fv-green-ink)]",
  warn: "bg-[color-mix(in_srgb,var(--fv-orange)_14%,transparent)] text-orange-ink",
  bad: "bg-destructive/12 text-destructive",
} as const;

export function Chip({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: keyof typeof CHIP_TONES;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm px-1.5 py-0.5 font-mono text-xs tracking-[0.06em] whitespace-nowrap uppercase",
        CHIP_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Order status → chip tone. One mapping, so two screens cannot disagree. */
export const ORDER_STATUS_TONE: Record<string, keyof typeof CHIP_TONES> = {
  pending: "warn",
  confirmed: "good",
  packed: "neutral",
  shipped: "neutral",
  delivered: "good",
  cancelled: "bad",
  returned: "bad",
};

export function FieldLabel({
  children,
  htmlFor,
  hint,
  required,
}: {
  children: React.ReactNode;
  htmlFor: string;
  hint?: string;
  required?: boolean;
}) {
  return (
    <div className="mb-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {children}
        {required ? (
          <span className="text-destructive ml-0.5" aria-hidden>
            *
          </span>
        ) : null}
      </label>
      {hint ? (
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
