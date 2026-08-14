import { AnnouncementBar } from "@/components/storefront/announcement-bar";
import { FlashToast } from "@/components/storefront/flash-toast";
import { BagDrawer } from "@/components/storefront/bag-drawer";
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
      {/*
        `tabIndex={-1}` is what makes the skip link above actually work.

        Following `href="#main"` moves the *sequential focus navigation starting
        point* to the target in Chrome and Firefox even when the target cannot
        hold focus — `document.activeElement` stays `<body>`, and the next Tab
        lands on the first control inside main anyway. **Safari does neither.**
        For a non-focusable target it moves neither focus nor the starting
        point, so a VoiceOver user who presses "Skip to content" and then Tab
        goes straight back to the top of the header, past every category and
        every brand, one keystroke at a time. This shop's customers are on
        phones and a large share of them are on iOS.

        Making main focusable-but-not-tabbable fixes it everywhere: the link
        moves real focus here, and the next Tab is the first control on the
        page. Measured on /search — Tab, Enter, Tab reaches the search box,
        against roughly 127 stops of header if the skip link is not used.

        The focus ring it draws around the content area is deliberately **not**
        suppressed. It is one frame of "you are here" at exactly the moment
        somebody has jumped, and this repository's own rule is that switching an
        outline off needs a reason — "it looked odd" is not one.
      */}
      <main id="main" tabIndex={-1} className="flex-1">
        {children}
      </main>
      <SiteFooter />
      {/* Mounted once, at the shell, because three different places open it and
          none of them is an ancestor of the others. It fetches on open, so
          being here costs nothing until somebody uses it. */}
      <BagDrawer />
      {/* Confirms anything that happened during a redirect — sign-out, today. */}
      <FlashToast />
    </>
  );
}
