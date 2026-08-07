import { AnnouncementBar } from "@/components/storefront/announcement-bar";
import { SiteFooter } from "@/components/storefront/site-footer";
import { SiteHeader } from "@/components/storefront/site-header";

/**
 * The storefront shell.
 *
 * Extracted so the root `not-found.tsx` can wear it too. A 404 rendered bare —
 * no header, no navigation, no footer — is a dead end at exactly the moment
 * somebody most needs a way out, and it is also a document with no `main`
 * landmark, which is how an automated pass finds it.
 */
export function StorefrontChrome({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a
        href="#main"
        className="bg-orange text-ink sr-only rounded-lg font-medium focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-100 focus:inline-flex focus:min-h-11 focus:items-center focus:px-4"
      >
        Skip to content
      </a>
      <AnnouncementBar />
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
