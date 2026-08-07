import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

/**
 * The admin panel is Phases 6 and 7. This page exists now for one reason: the
 * 404 guard in src/lib/supabase/proxy.ts cannot be proved against a route that
 * does not exist, because a missing route 404s on its own and a working guard
 * and a broken guard look identical.
 *
 * With a real route here, the check in docs/rls-tests.md is meaningful — an
 * anonymous visitor and a signed-in customer both get 404, an admin gets 200 —
 * and Phase 6 has somewhere to start.
 */
export default function AdminPlaceholder() {
  return (
    <main className="mx-auto max-w-xl px-4 py-24 text-center sm:px-6">
      <p className="text-muted-foreground font-mono text-xs tracking-[0.06em] uppercase">
        Foot Vault
      </p>
      <h1 className="font-display mt-3 text-4xl font-extrabold tracking-[-0.03em] uppercase">
        Admin
      </h1>
      <p className="text-muted-foreground mt-4 text-base text-pretty">
        You are signed in as an admin. The panel itself is built in Phases 6 and 7.
      </p>
    </main>
  );
}
