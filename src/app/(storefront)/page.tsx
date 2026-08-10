import Link from "next/link";

import { HomeSection } from "@/components/storefront/home-sections";
import { Button } from "@/components/ui/button";
import { contentTokens } from "@/lib/content-tokens";
import { prerenderOrDefer } from "@/lib/prerender";
import { cachedHomepageSections } from "@/lib/queries/cached";

/**
 * The homepage renders whatever is in `homepage_sections`, in that order.
 *
 * Nothing about the composition lives here: reordering the rows from
 * /admin/appearance in Phase 7 reorders the live page. `revalidate` is the
 * floor — publishing from the admin will call revalidatePath, so a change is
 * live immediately rather than within the hour.
 *
 * Statically rendered. Every query underneath reads through the cookieless anon
 * client, so there is nothing per-visitor on this page and no reason for a
 * customer to wait on a database round trip before the hero image starts.
 */
export const revalidate = 3600;

export default async function HomePage() {
  /**
   * Tokens are read **once** for the page, not once per section.
   *
   * `contentTokens()` reads `site_settings.shipping` and the returns window, so
   * resolving it inside each renderer would be one round trip per section for a
   * value that cannot change mid-render. `HomeSection` takes it as a prop for
   * that reason, and because the admin preview has to resolve it the same way or
   * the preview shows different copy from what publishing produces.
   */
  const [sections, tokens] = await Promise.all([
    prerenderOrDefer("homepage", cachedHomepageSections),
    contentTokens(),
  ]);

  if (sections.length === 0) {
    return (
      <div className="mx-auto max-w-xl px-4 py-24 text-center sm:px-6">
        <div className="tread-rule mx-auto w-24" aria-hidden />
        <h1 className="font-display mt-8 text-2xl font-bold tracking-[-0.02em] uppercase">
          The homepage is empty
        </h1>
        <p className="text-muted-foreground mt-3 text-base text-pretty">
          No sections are published yet. The catalogue is live either way — the
          shop is one tap from here.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Button asChild>
            <Link href="/shop">Shop all footwear</Link>
          </Button>
        </div>
        <p className="text-muted-foreground mt-6 font-mono text-xs tracking-[0.06em]">
          Developers: run <code>npm run seed</code> to load the starting layout.
        </p>
      </div>
    );
  }

  return (
    <>
      {sections.map((section) => (
        <HomeSection key={section.id} section={section} tokens={tokens} />
      ))}
    </>
  );
}
