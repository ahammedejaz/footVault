import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AdminShell } from "@/components/admin/shell";
import { adminActorOrNull } from "@/lib/admin/guard";

export const metadata: Metadata = {
  title: { default: "Admin", template: "%s — Admin" },
  robots: { index: false, follow: false },
};

/**
 * The panel's second lock, and the reason there are two.
 *
 * `src/lib/supabase/proxy.ts` already 404s /admin for a non-admin, and that is
 * the one a browser hits first. This layout checks again, because the middleware
 * check has a failure mode that is invisible: get the matcher wrong, or add a
 * route the matcher does not cover, and the guard silently stops running while
 * every test that visits /admin as an admin keeps passing. A check that lives
 * next to the thing it protects cannot be disconnected by a config change
 * somewhere else.
 *
 * `notFound()` rather than a redirect, for the same reason the proxy rewrites:
 * a redirect to /login confirms that /admin exists and is worth returning to.
 *
 * **Neither of these authorizes a mutation.** They protect rendering. Server
 * Actions are POSTs to a route this layout never runs for, so every admin
 * action re-checks `is_admin()` itself through `adminAction()` — and the
 * `footvault/admin-actions-must-guard` lint rule fails the build if one does
 * not.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const actor = await adminActorOrNull();
  if (!actor) notFound();

  return (
    <AdminShell actorName={actor.name ?? actor.email ?? "the owner"}>
      {children}
    </AdminShell>
  );
}
