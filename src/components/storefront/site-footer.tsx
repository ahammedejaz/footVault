import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import {
  getSiteSettings,
  setting,
  type ContactSettings,
} from "@/lib/queries/content";
import { footerNav, siteConfig } from "@/lib/site-config";

/**
 * Navy footer.
 *
 * The contact block comes from `site_settings`, which is what makes "change the
 * shop's phone number and see it update in the footer and on the contact page"
 * true — one row, both places, no deploy.
 */
export async function SiteFooter() {
  const settings = await getSiteSettings();
  const contact = setting<ContactSettings>(settings, "contact", {
    email: "",
    phone: "",
    whatsapp: "",
    address: "",
  });

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
            {contact.phone || contact.email ? (
              <address className="mt-5 space-y-1 text-sm not-italic">
                {contact.phone ? (
                  <p>
                    <a
                      href={`tel:${contact.phone.replace(/\s/g, "")}`}
                      className="hover:text-orange font-mono transition-colors"
                    >
                      {contact.phone}
                    </a>
                  </p>
                ) : null}
                {contact.email ? (
                  <p>
                    <a
                      href={`mailto:${contact.email}`}
                      className="text-muted-foreground hover:text-orange transition-colors"
                    >
                      {contact.email}
                    </a>
                  </p>
                ) : null}
                {contact.address ? (
                  <p className="text-muted-foreground max-w-xs">{contact.address}</p>
                ) : null}
              </address>
            ) : null}
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
