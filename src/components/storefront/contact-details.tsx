import type * as React from "react";

import { ClockIcon, MailIcon, MapPinIcon, PhoneIcon } from "lucide-react";

import { WhatsAppIcon } from "@/components/brand/social-icons";
import { whatsappHref } from "@/lib/contact";
import type { ContactSettings } from "@/lib/queries/content";

/**
 * The shop's own phone, WhatsApp, email and address, rendered once.
 *
 * ## Why this is a component and not two copies of an `<address>`
 *
 * The footer had a contact block and the contact page did not. What the contact
 * page had instead was a sentence — *"Our contact details and opening hours are
 * in the footer of every page"* — which is not a contact page; it is a note
 * explaining that there isn't one.
 *
 * And **WhatsApp was unreachable from anywhere on the site.** Zero `wa.me`
 * links, measured across every route on 2026-08-14, while the returns policy
 * told a customer with a damaged parcel to *"Call or WhatsApp the store"* within
 * 24 hours. The icon existed in `SOCIAL_ICONS` and had never been rendered,
 * because `site_settings.social` holds Instagram and Facebook and the WhatsApp
 * number lives in `site_settings.contact` — so the one place it could have
 * appeared was looking at the wrong row.
 *
 * The shop's single warranty commitment ran through a channel with no link.
 *
 * ## The two variants, and what differs
 *
 * `footer` is compact and repeats on every page. `page` is the version a
 * stranger reads before deciding to trust an unknown shop with a card number,
 * and is also the surface `LocalBusiness` and the local pack are judged
 * against — so it carries the opening hours and gives each detail its own line
 * with a label.
 *
 * Both take their values from `site_settings` and neither has a fallback. A
 * detail the owner has not filled in is simply absent, rather than rendering an
 * empty `tel:` link that looks like a phone number and dials nothing.
 */
export function ContactDetails({
  contact,
  hours,
  variant = "footer",
}: {
  contact: ContactSettings;
  /** Already-formatted opening hours. Only the `page` variant prints them. */
  hours?: string | null;
  variant?: "footer" | "page";
}) {
  const items = contactLinks(contact);
  if (items.length === 0) return null;

  if (variant === "footer") {
    return (
      <address className="mt-5 space-y-1 text-sm not-italic">
        {items.map((item) => (
          <p key={item.key}>
            {item.href ? (
              <a
                href={item.href}
                {...(item.external
                  ? { target: "_blank", rel: "noopener noreferrer" }
                  : {})}
                className={
                  "hit-44 hover:text-orange inline-flex min-h-9 items-center transition-colors " +
                  (item.key === "phone" ? "font-mono" : "text-muted-foreground")
                }
              >
                {item.label}
              </a>
            ) : (
              <span className="text-muted-foreground block max-w-xs">
                {item.label}
              </span>
            )}
          </p>
        ))}
      </address>
    );
  }

  return (
    <address className="not-italic">
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.key} className="flex items-start gap-3">
            <item.Icon
              className="text-orange mt-0.5 size-5 shrink-0"
              aria-hidden
            />
            <span className="text-base text-pretty">
              <span className="sr-only">{item.name}: </span>
              {item.href ? (
                <a
                  href={item.href}
                  {...(item.external
                    ? { target: "_blank", rel: "noopener noreferrer" }
                    : {})}
                  className="hover:text-orange underline underline-offset-4 transition-colors"
                >
                  {item.label}
                </a>
              ) : (
                item.label
              )}
            </span>
          </li>
        ))}
        {hours ? (
          <li className="flex items-start gap-3">
            <ClockIcon className="text-orange mt-0.5 size-5 shrink-0" aria-hidden />
            <span className="text-base text-pretty">
              <span className="sr-only">Opening hours: </span>
              {hours}
            </span>
          </li>
        ) : null}
      </ul>
    </address>
  );
}

type ContactLink = {
  key: string;
  name: string;
  label: string;
  href: string | null;
  external?: boolean;
  /*
    Widened past lucide's `ForwardRefExoticComponent`, because `WhatsAppIcon` is
    a hand-drawn SVG function component and the whole point of this list is that
    the two sit beside each other.
  */
  Icon: React.ComponentType<{ className?: string }>;
};

/**
 * The details that are actually set, in the order a customer wants them.
 *
 * Phone first because a shop with a damaged parcel to report is calling, not
 * writing. WhatsApp second for the same reason — the returns policy names both,
 * in that order.
 */
function contactLinks(contact: ContactSettings): ContactLink[] {
  const links: ContactLink[] = [];

  if (contact.phone?.trim()) {
    links.push({
      key: "phone",
      name: "Phone",
      label: contact.phone.trim(),
      href: `tel:${contact.phone.replace(/\s/g, "")}`,
      Icon: PhoneIcon,
    });
  }

  if (contact.whatsapp?.trim()) {
    links.push({
      key: "whatsapp",
      name: "WhatsApp",
      label: contact.whatsapp.trim(),
      href: whatsappHref(contact.whatsapp),
      external: true,
      Icon: WhatsAppIcon,
    });
  }

  if (contact.email?.trim()) {
    links.push({
      key: "email",
      name: "Email",
      label: contact.email.trim(),
      href: `mailto:${contact.email.trim()}`,
      Icon: MailIcon,
    });
  }

  if (contact.address?.trim()) {
    links.push({
      key: "address",
      name: "Address",
      label: contact.address.trim(),
      href: null,
      Icon: MapPinIcon,
    });
  }

  return links;
}
