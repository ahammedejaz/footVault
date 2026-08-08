import type { Metadata } from "next";
import Link from "next/link";
import { Heart, MapPin, Package } from "lucide-react";

import { GoogleSignInForm } from "@/components/storefront/sign-in";
import { getCurrentUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Your account",
  robots: { index: false, follow: false },
};

/**
 * The account index.
 *
 * It exists because `/account/orders` and `/account/addresses` do. A section
 * whose parent path is a 404 is a section somebody lands on by deleting a path
 * segment, which is exactly what people do when they are looking for the thing
 * one level up.
 *
 * Three destinations and nothing else. There is no profile to edit — the name
 * and the avatar come from Google, and a form that let a customer change them
 * here would only ever disagree with the next sign-in.
 */
const SECTIONS = [
  {
    href: "/account/orders",
    icon: Package,
    title: "Orders",
    body: "What you bought, where it is going, and where it has got to.",
  },
  {
    href: "/account/addresses",
    icon: MapPin,
    title: "Addresses",
    body: "The list checkout picks from. The default is preselected.",
  },
  {
    href: "/wishlist",
    icon: Heart,
    title: "Saved items",
    body: "Pairs you are still thinking about, on every device you use.",
  },
] as const;

export default async function AccountPage() {
  const user = await getCurrentUser();

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <h1 className="font-display text-4xl font-extrabold tracking-[-0.03em] uppercase">
        Your account
      </h1>

      {!user ? (
        <div className="border-border mt-8 rounded-lg border p-6 text-center">
          <p className="text-base text-pretty">
            An account keeps your orders, your addresses and your saved pairs
            together on every device. Buying never needs one.
          </p>
          <div className="mx-auto mt-5 max-w-xs">
            <GoogleSignInForm next="/account" />
          </div>
        </div>
      ) : (
        <>
          <p className="text-muted-foreground mt-3 text-base text-pretty">
            Signed in as {user.name ?? user.email ?? "you"}.
          </p>

          <ul className="mt-8 space-y-3">
            {SECTIONS.map((section) => (
              <li key={section.href} className="relative">
                <Link
                  href={section.href}
                  className="border-border hover:bg-fog flex min-h-11 items-start gap-4 rounded-lg border p-4 transition-colors"
                >
                  <section.icon
                    className="text-muted-foreground mt-0.5 size-5 shrink-0"
                    aria-hidden
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {section.title}
                    </span>
                    <span className="text-muted-foreground mt-1 block text-sm text-pretty">
                      {section.body}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
