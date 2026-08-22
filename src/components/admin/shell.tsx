"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ExternalLink, Menu } from "lucide-react";

import lockup from "../../../public/brand/logo.png";

import {
  ADMIN_NAV_SECTIONS,
  isActive,
  type AdminNavItem,
} from "@/components/admin/nav";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * The admin chrome.
 *
 * Utilitarian on purpose, and distinct from the storefront on purpose — the
 * owner should never be a second unsure which one they are looking at, because
 * the two have destructive actions in them that the other does not. It gets
 * there without a second design system: same tokens, same primitives, and a
 * navy `[data-surface="ink"]` sidebar that `globals.css` already inverts the
 * semantic layer inside. Density does the rest.
 *
 * **Tablet is the target, not a fallback.** The owner uses this standing in the
 * shop with a tablet in one hand, so the sidebar is a persistent rail from
 * `md` — 768px, which is tablet portrait — and a drawer below it. That is the
 * opposite of the usual breakpoint choice, where a sidebar appears at `lg` and
 * a tablet gets the phone layout it does not need.
 *
 * The active item is decided by `isActive`, not by `startsWith` at the call
 * site: `/admin` is a prefix of every route in the panel, so the naive version
 * lights up Dashboard permanently.
 */
export function AdminShell({
  actorName,
  children,
}: {
  actorName: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  /**
   * Any navigation closes the drawer. Without this the panel stays open over
   * the page it just navigated to, which on a tablet means the owner taps a
   * link and appears to land nowhere.
   *
   * Adjusted during render rather than in an effect on `[pathname]`. The effect
   * form paints the new page once with the drawer still over it and closes it
   * on the following commit, which is a visible flash on exactly the device
   * this panel is built for — and it is the cascading-render shape React's lint
   * rule exists to catch.
   */
  const [renderedPath, setRenderedPath] = React.useState(pathname);
  if (renderedPath !== pathname) {
    setRenderedPath(pathname);
    if (drawerOpen) setDrawerOpen(false);
  }

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      {/*
        Same skip link as the storefront, same reason, same Safari caveat: the
        target carries tabIndex={-1} because following `href="#main"` moves
        real focus only when the target can hold it — see the note in
        storefront/chrome.tsx. The admin went without either landmark until
        2026-08-20; fifteen rail links is a shorter walk than the storefront's
        127 stops, but a keyboard user still pays it on every page.
      */}
      <a
        href="#main"
        className="bg-orange text-ink sr-only rounded-lg font-medium focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-100 focus:inline-flex focus:min-h-11 focus:items-center focus:px-4"
      >
        Skip to content
      </a>
      {/* The rail. `sticky` rather than `fixed` so it participates in the flow
          and the content column does not need a matching margin to avoid it. */}
      <aside
        data-surface="ink"
        className="bg-sidebar text-sidebar-foreground hidden md:sticky md:top-0 md:flex md:h-dvh md:w-52 md:shrink-0 md:flex-col lg:w-60"
      >
        <Wordmark />
        <nav
          aria-label="Admin sections"
          className="flex-1 overflow-y-auto px-2 pb-4"
        >
          {ADMIN_NAV_SECTIONS.map((section) => (
            <div key={section.label} className="mb-3 last:mb-0">
              <SectionHeading>{section.label}</SectionHeading>
              <ul className="space-y-0.5">
                {section.items.map((item) => (
                  <li key={item.href}>
                    <RailLink item={item} active={isActive(item, pathname)} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <StorefrontLink />
      </aside>

      {/* The small-screen bar. Below `md` only, so a tablet never sees it. */}
      <header
        data-surface="ink"
        className="bg-sidebar text-sidebar-foreground sticky top-0 z-40 flex items-center gap-2 px-3 py-2 md:hidden"
      >
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open admin menu">
              <Menu />
            </Button>
          </SheetTrigger>
          {/*
            `gap-0` and the three `shrink-0`/`flex-1` children below are what
            make this drawer scroll. See the note on the `<nav>`.
          */}
          <SheetContent
            side="left"
            data-surface="ink"
            className="bg-sidebar text-sidebar-foreground w-[17rem] gap-0 border-r-0 p-0"
          >
            <SheetHeader className="shrink-0 px-4 pt-4 pb-2">
              <SheetTitle className="font-display text-lg font-extrabold tracking-[-0.02em] uppercase">
                Foot Vault admin
              </SheetTitle>
              <SheetDescription className="text-sidebar-foreground/70 text-sm">
                Signed in as {actorName}
              </SheetDescription>
            </SheetHeader>
            {/*
              **The scroll container, and the reason this drawer was broken.**
              Fifteen sections at two lines each is about 810px of list; add
              the header and the shop link and the drawer wants ~950px inside a
              sheet that is exactly one viewport tall. On a phone that is 250px
              of menu with nowhere to go — Radix locks `<body>` while the sheet
              is open, so the page cannot scroll either, and Settings, Media,
              Appearance and Health were simply not reachable on a phone.

              `min-h-0` is the half that is easy to leave out and does nothing
              visible until the list is long: a flex child's default
              `min-height: auto` refuses to shrink below its content, so
              `flex-1` alone grows the nav past the sheet and `overflow-y-auto`
              never has an overflow to act on.

              The rail on `md` and up has had `overflow-y-auto` since it was
              written. Only the drawer went without, which is why this survived
              — the panel is developed on the desktop layout.
            */}
            <nav
              aria-label="Admin sections"
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2"
            >
              {ADMIN_NAV_SECTIONS.map((section) => (
                <div key={section.label} className="mb-3 last:mb-0">
                  <SectionHeading>{section.label}</SectionHeading>
                  <ul className="space-y-0.5">
                    {section.items.map((item) => (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={
                            isActive(item, pathname) ? "page" : undefined
                          }
                          className={cn(
                            "flex min-h-11 flex-col justify-center rounded-sm px-3 py-2 transition-colors",
                            isActive(item, pathname)
                              ? "bg-sidebar-accent text-sidebar-accent-foreground"
                              : "hover:bg-sidebar-accent/60",
                          )}
                        >
                          <span className="text-sm font-medium">
                            {item.label}
                          </span>
                          <span className="text-sidebar-foreground/60 text-xs">
                            {item.hint}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
            <div className="shrink-0 px-2 pb-4">
              <StorefrontLink />
            </div>
          </SheetContent>
        </Sheet>
        <span className="inline-flex items-center gap-2">
          <Image src={lockup} alt="" className="h-8 w-auto" sizes="32px" />
          <span className="font-display text-base font-extrabold tracking-[-0.02em] uppercase">
            Admin
          </span>
        </span>
      </header>

      <main id="main" tabIndex={-1} className="min-w-0 flex-1">
        {children}
      </main>
    </div>
  );
}

function Wordmark() {
  return (
    <div className="px-4 pt-5 pb-4">
      <Link
        href="/admin"
        className="flex items-center gap-2.5"
      >
        <Image src={lockup} alt="" className="h-10 w-auto" sizes="40px" />
        <span className="flex flex-col">
          <span className="font-display text-lg leading-none font-extrabold tracking-[-0.02em] uppercase">
            Foot Vault
          </span>
          <span className="text-sidebar-foreground/60 mt-1 font-mono text-xs tracking-[0.06em] uppercase">
            Admin
          </span>
        </span>
      </Link>
    </div>
  );
}

/**
 * A heading over a run of links.
 *
 * `aria-hidden` and not a real heading element. The two navs already have
 * `aria-label="Admin sections"` and every link inside carries its own name; a
 * screen reader user navigating by link or by landmark gets the whole list
 * either way. Adding six `<h3>`s inside a `<nav>` would put six more stops in
 * the heading rotor of every admin page for a grouping that exists to help the
 * eye scan — and the alternative, marking each group as its own labelled nav
 * landmark, turns one landmark into seven.
 *
 * The visual grouping does the work; the accessible name of each link already
 * says where it goes.
 */
function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <p
      aria-hidden
      /*
        `/70`, not `/45`. The first version was `/45` and axe found six
        contrast failures on every admin page — one per heading — because a
        12px uppercase label needs 4.5:1 and 45% of the sidebar's foreground
        over the sidebar's own ink does not reach it. The hint lines under each
        link have been `/60` since they were written; a heading must not be
        quieter than the thing it labels.
      */
      className="text-sidebar-foreground/70 px-3 pt-2 pb-1 font-mono text-xs tracking-[0.1em] uppercase"
    >
      {children}
    </p>
  );
}

function RailLink({ item, active }: { item: AdminNavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        // 40px rows rather than 44: this is a rail of nine items on a screen
        // that is 1024 tall at most, and the touch floor is met by the row's
        // full width being the target, not by its height alone.
        "flex min-h-10 items-center rounded-sm px-3 text-sm transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
          : "text-sidebar-foreground/85 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
      )}
    >
      {/* The active marker is a left rule in orange, drawn inside the row so it
          cannot shift the label. A background alone is not enough of a signal
          on navy at this density. */}
      <span
        aria-hidden
        className={cn(
          "mr-2 h-4 w-0.5 rounded-full transition-colors",
          active ? "bg-sidebar-primary" : "bg-transparent",
        )}
      />
      {item.label}
    </Link>
  );
}

function StorefrontLink() {
  return (
    <div className="border-sidebar-border border-t px-2 py-3">
      <Link
        href="/"
        target="_blank"
        rel="noreferrer"
        className="text-sidebar-foreground/85 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground flex min-h-11 items-center gap-2 rounded-sm px-3 text-sm transition-colors"
      >
        <ExternalLink className="size-4 shrink-0" aria-hidden />
        View the shop
        <span className="sr-only">(opens in a new tab)</span>
      </Link>
    </div>
  );
}
