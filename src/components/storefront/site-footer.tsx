import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { footerNav, siteConfig } from "@/lib/site-config";

/**
 * Navy footer. Contact details and social links arrive from site_settings in
 * Phase 7 — the owner changing the shop phone number must update the footer and
 * the contact page together, which is why nothing here is hard-coded copy that
 * a customer would act on.
 */
export function SiteFooter() {
  return (
    <footer data-surface="ink" className="mt-auto">
      <div className="tread-rule" aria-hidden="true" />
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:py-16">
        <div className="grid gap-10 md:grid-cols-[1.2fr_repeat(3,1fr)]">
          <div>
            <Logo showTagline />
            <p className="text-muted-foreground mt-5 max-w-xs text-sm">
              {siteConfig.description}
            </p>
          </div>

          {footerNav.map((column) => (
            <nav key={column.heading} aria-labelledby={`footer-${column.heading}`}>
              <h2
                id={`footer-${column.heading}`}
                className="font-mono text-xs tracking-[0.06em] uppercase"
              >
                {column.heading}
              </h2>
              <ul className="mt-2">
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-muted-foreground hover:text-orange flex min-h-11 items-center text-sm transition-colors"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-white/10 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground font-mono text-xs">
            © {new Date().getFullYear()} {siteConfig.name}
          </p>
          <p className="text-muted-foreground font-mono text-xs">
            Prices in INR, inclusive of all taxes
          </p>
        </div>
      </div>
    </footer>
  );
}
