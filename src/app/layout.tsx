import type { Metadata, Viewport } from "next";

import { NotConfigured } from "@/components/not-configured";
import { Toaster } from "@/components/ui/sonner";
import { missingSupabaseEnv } from "@/lib/env";
import { fontVariables } from "@/lib/fonts";
import { cachedSiteSettings } from "@/lib/queries/cached";
import { brandingOf } from "@/lib/queries/content";
import { siteConfig } from "@/lib/site-config";

import "./globals.css";

/**
 * The shop's name, in the browser tab and in every search result.
 *
 * ## Why this became a function
 *
 * It was a constant built from `src/lib/site-config.ts`, which meant the one
 * thing an owner is guaranteed to want to change about their shop — what it is
 * called — was a code edit and a deploy. That is exactly the capability that
 * stops existing when development stops.
 *
 * ## It does not make the site dynamic
 *
 * `cachedSiteSettings` is an `unstable_cache` read, not a dynamic API, so
 * routes that were statically rendered before this still are. The one-hour
 * revalidate and the `chrome` tag are the same ones the header and footer have
 * always read these settings through, so a change made in the panel expires
 * this at the same moment it expires those — the tab title and the footer
 * cannot show two different shop names.
 *
 * ## Why it swallows a failure instead of throwing
 *
 * This is the **root** layout: a throw here is not a broken page, it is a
 * broken site, storefront and admin panel alike, including the admin page the
 * owner would use to fix whatever broke. `shippingSettingsOf` throws by design
 * because a wrong delivery promise is worse than an error; a shop name is not
 * in that category. `brandingOf` fills every missing field from `siteConfig`,
 * so the failure mode is the metadata this file emitted before it read a
 * database at all.
 */
export async function generateMetadata(): Promise<Metadata> {
  const branding = await readBranding();

  return {
    metadataBase: new URL(siteConfig.url),
    title: {
      default: `${branding.shopName} — ${branding.tagline}`,
      template: `%s — ${branding.shopName}`,
    },
    description: branding.description,
    openGraph: {
      type: "website",
      siteName: branding.shopName,
      title: `${branding.shopName} — ${branding.tagline}`,
      description: branding.description,
      // Only when the owner has uploaded one. Left absent, the per-route
      // `opengraph-image` segments still generate a card from the product and
      // the settings, which is better than a single picture going stale.
      ...(branding.shareImageUrl ? { images: [branding.shareImageUrl] } : {}),
    },
    // An uploaded favicon replaces `src/app/icon.png`; absent, Next keeps
    // serving that file route exactly as before.
    ...(branding.faviconUrl ? { icons: { icon: branding.faviconUrl } } : {}),
    twitter: { card: "summary_large_image" },
  };
}

async function readBranding() {
  try {
    return brandingOf(await cachedSiteSettings());
  } catch (error) {
    console.warn(
      "[layout] site settings unreadable, using the built-in shop identity:",
      error instanceof Error ? error.message : error,
    );
    return brandingOf({});
  }
}

export const viewport: Viewport = {
  themeColor: "#0a1526",
  width: "device-width",
  initialScale: 1,
};

/**
 * `suppressHydrationWarning` is on the body and nowhere else.
 *
 * Password managers and accessibility extensions write attributes onto `<body>`
 * before React hydrates — `bis_register` and `__processed_<uuid>__` are the two
 * this project has actually seen reported. React compares the server HTML with
 * the live DOM, finds attributes the server never sent, and reports a mismatch
 * that is not ours and cannot be fixed from here.
 *
 * This attribute exists for exactly that, and it suppresses exactly one level:
 * attribute and text differences on `<body>` itself. Every child still reports
 * mismatches normally, so a real hydration bug anywhere in the tree stays loud.
 * `scripts/audit/interactions.ts` drives headless Chromium, which has no
 * extensions, and fails on any console error — so a mismatch that survives
 * there is by construction a real one rather than this noise.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  /**
   * The one check that makes `isSupabaseConfigured()`'s doc comment true.
   *
   * Highest point on the render path, so a clone with no `.env.local` gets a
   * page that names the missing variables instead of an error boundary hiding
   * them behind a digest. Everything below here may assume configuration.
   */
  const missing = missingSupabaseEnv();

  return (
    <html lang="en" className={`${fontVariables} h-full`}>
      <body className="flex min-h-full flex-col" suppressHydrationWarning>
        {missing.length > 0 ? <NotConfigured missing={missing} /> : children}
        <Toaster position="bottom-center" />
      </body>
    </html>
  );
}
