import type { Metadata, Viewport } from "next";

import { NotConfigured } from "@/components/not-configured";
import { Toaster } from "@/components/ui/sonner";
import { missingSupabaseEnv } from "@/lib/env";
import { fontVariables } from "@/lib/fonts";
import { siteConfig } from "@/lib/site-config";

import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: `${siteConfig.name} — ${siteConfig.tagline}`,
    template: `%s — ${siteConfig.name}`,
  },
  description: siteConfig.description,
  openGraph: {
    type: "website",
    siteName: siteConfig.name,
    title: `${siteConfig.name} — ${siteConfig.tagline}`,
    description: siteConfig.description,
  },
  // The card image itself comes from the `opengraph-image` route segments, so
  // it is generated from `site_settings` and the product rather than uploaded
  // once and left to go stale.
  twitter: { card: "summary_large_image" },
};

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
