"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";

import type { NavItem } from "@/components/storefront/nav-types";
import { cn } from "@/lib/utils";

/**
 * Desktop navigation.
 *
 * A hover-only CSS dropdown looks the same and fails three ways: it cannot be
 * closed with Escape, it re-opens the moment the pointer crosses it on the way
 * somewhere else, and it either drops out of the tab order (`hidden`) or leaves
 * a dozen invisible links in it (`opacity: 0`). This is a small amount of state
 * to get those three right.
 *
 * Open on hover *and* on focus, close on Escape, on blur out of the group, and
 * on navigation. A 120ms close delay covers the diagonal path from the trigger
 * to the first link in the panel, which is the movement that makes an
 * instant-close menu feel broken.
 */
export function MegaNav({ items }: { items: NavItem[] }) {
  const [open, setOpen] = React.useState<string | null>(null);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathname = usePathname();

  // Reset during render rather than in an effect: an effect would paint the
  // menu still open on the new page and close it a frame later.
  const [lastPath, setLastPath] = React.useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setOpen(null);
  }

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(null), 120);
  };

  React.useEffect(() => () => cancelClose(), []);

  return (
    <nav
      aria-label="Main"
      className="mr-auto hidden lg:block"
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(null);
      }}
    >
      <ul className="flex items-center gap-1">
        {items.map((item) => {
          const hasPanel = Boolean(item.children?.length);
          const isOpen = open === item.href;
          const isCurrent = pathname === item.href || pathname.startsWith(`${item.href}/`);

          return (
            <li
              key={item.href}
              className="relative"
              onMouseEnter={() => {
                cancelClose();
                if (hasPanel) setOpen(item.href);
              }}
              onMouseLeave={scheduleClose}
              onFocus={() => {
                cancelClose();
                if (hasPanel) setOpen(item.href);
              }}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                  scheduleClose();
                }
              }}
            >
              <Link
                href={item.href}
                aria-current={isCurrent ? "page" : undefined}
                aria-expanded={hasPanel ? isOpen : undefined}
                className={cn(
                  "after:bg-orange relative flex min-h-11 items-center gap-1 px-3 text-sm font-medium transition-colors after:absolute after:inset-x-3 after:bottom-3 after:h-px after:origin-left after:transition-transform",
                  isCurrent || isOpen ? "after:scale-x-100" : "after:scale-x-0",
                  "hover:text-orange-ink",
                )}
              >
                {item.label}
                {hasPanel ? (
                  <ChevronDown
                    className={cn("size-3.5 transition-transform", isOpen && "rotate-180")}
                    aria-hidden
                  />
                ) : null}
              </Link>

              {hasPanel ? (
                <div
                  // `hidden` rather than opacity: a panel nobody can see must
                  // not be a dozen tab stops on the way to the bag icon.
                  hidden={!isOpen}
                  className="absolute top-full left-0 z-50 pt-1"
                >
                  <div className="border-border bg-background min-w-64 rounded-lg border p-2 shadow-lg">
                    <ul>
                      {item.children!.map((child) => (
                        <li key={child.href}>
                          <Link
                            href={child.href}
                            className="hover:bg-muted flex min-h-11 flex-col justify-center rounded-lg px-3 py-1.5"
                          >
                            <span className="text-sm font-medium">{child.label}</span>
                            {child.description ? (
                              <span className="text-muted-foreground text-xs">
                                {child.description}
                              </span>
                            ) : null}
                          </Link>
                        </li>
                      ))}
                      <li className="border-border mt-1 border-t pt-1">
                        <Link
                          href={item.href}
                          className="hover:bg-muted text-orange-ink flex min-h-11 items-center rounded-lg px-3 font-mono text-xs tracking-[0.06em] uppercase"
                        >
                          Everything in {item.label}
                        </Link>
                      </li>
                    </ul>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
