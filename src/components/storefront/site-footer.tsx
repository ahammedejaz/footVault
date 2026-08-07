import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import {
  FacebookIcon,
  InstagramIcon,
  WhatsAppIcon,
} from "@/components/brand/social-icons";
import { prerenderOrDefer } from "@/lib/prerender";
import { getCategoryTree } from "@/lib/queries/catalog";
import {
  getSiteSettings,
  listPages,
  setting,
  type ContactSettings,
  type SocialSettings,
} from "@/lib/queries/content";
import { siteConfig } from "@/lib/site-config";

/**
 * Navy footer, assembled entirely from the database.
 *
 * Nothing here is a hard-coded list the owner will later expect to edit: the
 * shop column is the live category tree, the help column is every published CMS
 * page, and the contact block and the social links are `site_settings`. Adding
 * a returns policy page in Phase 7 puts it in the footer with no deploy — which
 * is the whole promise of the admin panel, made concrete in the one component
 * that appears on every page.
 */
const SOCIAL_ICONS = {
  instagram: InstagramIcon,
  facebook: FacebookIcon,
  whatsapp: WhatsAppIcon,
} as const;

function iconFor(name: string) {
  return SOCIAL_ICONS[name as keyof typeof SOCIAL_ICONS];
}

export async function SiteFooter() {
  const [settings, pages, tree] = await prerenderOrDefer("footer", () =>
    Promise.all([getSiteSettings(), listPages(), getCategoryTree()]),
  );

  const contact = setting<ContactSettings>(settings, "contact", {
    email: "",
    phone: "",
    whatsapp: "",
    address: "",
  });
  const social = setting<SocialSettings>(settings, "social", {});
  const socialLinks = Object.entries(social).filter(([, href]) => Boolean(href));

  return (
    <footer data-surface="ink" className="mt-auto">
      <div className="tread-rule" aria-hidden="true" />
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:py-16">
        <div className="grid gap-10 md:grid-cols-[1.2fr_repeat(3,1fr)]">
          <div>
            <Logo showTagline />
            <p className="text-muted-foreground mt-5 max-w-xs text-sm text-pretty">
              {siteConfig.description}
            </p>
            {contact.phone || contact.email || contact.address ? (
              <address className="mt-5 space-y-1 text-sm not-italic">
                {contact.phone ? (
                  <p>
                    <a
                      href={`tel:${contact.phone.replace(/\s/g, "")}`}
                      className="hit-44 hover:text-orange inline-flex min-h-9 items-center font-mono transition-colors"
                    >
                      {contact.phone}
                    </a>
                  </p>
                ) : null}
                {contact.email ? (
                  <p>
                    <a
                      href={`mailto:${contact.email}`}
                      className="hit-44 text-muted-foreground hover:text-orange inline-flex min-h-9 items-center transition-colors"
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

            {socialLinks.length > 0 ? (
              <ul className="mt-4 flex gap-1">
                {socialLinks.map(([name, href]) => {
                  const Icon = iconFor(name);
                  return (
                    <li key={name}>
                      <a
                        href={href}
                        rel="noopener noreferrer me"
                        target="_blank"
                        className="hover:text-orange flex size-11 items-center justify-center rounded-lg transition-colors"
                      >
                        {Icon ? <Icon className="size-4" aria-hidden /> : null}
                        <span className="sr-only">
                          Foot Vault on {name.charAt(0).toUpperCase() + name.slice(1)}
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>

          <FooterColumn
            heading="Shop"
            links={[
              { label: "All footwear", href: "/shop" },
              ...tree.map((node) => ({
                label: node.name,
                href: `/shop/${node.slug}`,
              })),
              { label: "Sale", href: "/shop?on_sale=true" },
            ]}
          />

          <FooterColumn
            heading="Help"
            links={pages.map((page) => ({
              label: page.title,
              href: `/page/${page.slug}`,
            }))}
          />

          <FooterColumn
            heading="Your account"
            links={[
              { label: "Your bag", href: "/cart" },
              { label: "Saved items", href: "/wishlist" },
              { label: "Search", href: "/search" },
            ]}
          />
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

function FooterColumn({
  heading,
  links,
}: {
  heading: string;
  links: Array<{ label: string; href: string }>;
}) {
  if (links.length === 0) return null;
  const id = `footer-${heading.toLowerCase().replace(/\s+/g, "-")}`;

  return (
    <nav aria-labelledby={id}>
      <h2 id={id} className="font-mono text-xs tracking-[0.06em] uppercase">
        {heading}
      </h2>
      <ul className="mt-2">
        {links.map((link) => (
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
  );
}
