import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { SITE_URL } from "@/lib/env";

export type Crumb = { label: string; href?: string };

/**
 * Breadcrumbs, and the BreadcrumbList that matches them.
 *
 * The JSON-LD is generated from the same array the customer sees, so the two
 * cannot disagree — a structured-data trail that claims a path the page does
 * not show is worse than none at all.
 */
export function Breadcrumbs({
  crumbs,
  className,
}: {
  crumbs: Crumb[];
  className?: string;
}) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.label,
      ...(crumb.href ? { item: new URL(crumb.href, SITE_URL).toString() } : {}),
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <nav aria-label="Breadcrumb" className={className}>
        <ol className="text-muted-foreground flex flex-wrap items-center gap-1 font-mono text-xs tracking-[0.06em]">
          {crumbs.map((crumb, index) => (
            <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
              {index > 0 ? (
                <ChevronRight className="size-3 shrink-0 opacity-60" aria-hidden />
              ) : null}
              {crumb.href ? (
                <Link
                  href={crumb.href}
                  className="hit-44 hover:text-foreground inline-flex min-h-8 items-center transition-colors"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-foreground inline-flex min-h-8 items-center" aria-current="page">
                  {crumb.label}
                </span>
              )}
            </li>
          ))}
        </ol>
      </nav>
    </>
  );
}
