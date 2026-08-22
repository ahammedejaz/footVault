import type { Metadata } from "next";

import { PagesEditor } from "@/components/admin/pages/pages-editor";
import { AdminPage, PageHeader } from "@/components/admin/ui";
import { contentTokens } from "@/lib/content-tokens";
import { listAdminPages } from "@/lib/queries/admin/pages";

export const metadata: Metadata = { title: "Pages" };
export const dynamic = "force-dynamic";

/**
 * The shop's own pages — the last part of the storefront the owner could not
 * change.
 *
 * `pages` has been a table since the first migration and the storefront has
 * rendered from it since Phase 3, but nothing could write to it except SQL.
 * `/admin/settings` carried a paragraph acknowledging exactly that: *"The policy
 * pages are CMS rows and a half-built editor for them would be worse than a
 * link, so this page says where they live and sends the owner there."* That was
 * an honest position while there was a developer to run the SQL. There is not
 * one now.
 *
 * Seven pages, two of which are the terms a customer agrees to at checkout, and
 * one of which — `/page/returns` — went live with a meta description promising
 * a seven-day free return against a body that said replacement only within 24
 * hours. That sentence survived a launch audit because nobody who could see it
 * was able to fix it.
 *
 * The tokens are resolved here, server-side, and handed to the editor so its
 * preview shows the owner the same numbers the customer will see. See
 * `src/lib/tokens.ts` for why the substitution itself can cross to the browser.
 */
export default async function AdminPagesPage() {
  const [pages, tokens] = await Promise.all([listAdminPages(), contentTokens()]);

  return (
    <>
      <PageHeader
        title="Pages"
        description="About, Contact and the policies — everything at /page/… on the shop. The footer's Help column is built from whichever of these are published."
      />

      <AdminPage>
        {/*
          `PagesEditor` is rendered even with nothing to list, rather than
          swapped for an `EmptyState`. The empty state has no Add button, and a
          screen whose empty version cannot reach the one control that fills it
          is a dead end — the editor's own "Add a page" is the way out, so it
          must be on screen in exactly the case where it is needed most.
        */}
        {pages.length === 0 ? (
          <p className="text-muted-foreground mb-4 text-sm text-pretty">
            Nothing here yet. Pages hold the words that are not products: what
            the shop is, how to reach it, and what happens when something
            arrives damaged.
          </p>
        ) : null}
        <PagesEditor pages={pages} tokens={tokens} />
      </AdminPage>
    </>
  );
}
