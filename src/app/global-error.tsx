"use client";

import { fontVariables } from "@/lib/fonts";

import "./globals.css";

/**
 * The boundary that catches a failing **root layout**.
 *
 * `app/error.tsx` cannot. Its own comment claimed otherwise for two phases —
 * "this one only runs when something above that failed — the layout itself" —
 * and it was wrong: in the App Router an error boundary only catches throws
 * from *below* it, and `error.tsx` sits inside the root layout it would have to
 * catch. Production proved it. `NEXT_PUBLIC_SUPABASE_URL` was never set on
 * Vercel, the header threw while reading the category tree, and every visitor
 * for two hours got a bare HTTP 500 with no markup at all — no branding, no
 * reference number, nothing to report. 106 of them.
 *
 * `global-error.tsx` is the only file Next will render in that situation, and
 * because it *replaces* the root layout it has to supply its own `<html>` and
 * `<body>`.
 *
 * **Its imports are deliberately almost nothing.** A last-resort boundary that
 * shares a dependency with the thing that failed fails with it, so there is no
 * `Button` here (cva), no `TreadMark`, and nothing that reads an environment
 * variable — just the stylesheet, the font variables, and hand-rolled markup
 * using the same tokens. Uglier than importing the design system, and it works
 * when the design system does not.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className={`${fontVariables} h-full`}>
      <body className="bg-background text-foreground flex min-h-full flex-col">
        <main className="mx-auto flex max-w-xl flex-col items-center px-4 py-24 text-center sm:px-6">
          <p className="text-muted-foreground font-mono text-xs tracking-[0.06em] uppercase">
            Something failed
          </p>
          <h1 className="font-display mt-3 text-4xl font-extrabold tracking-[-0.03em] uppercase">
            Foot Vault is not loading
          </h1>
          <p className="text-muted-foreground mt-4 text-base">
            This one is ours, not yours. Try again in a moment — and if it keeps
            happening, contact us and quote the reference below.
          </p>
          {error.digest ? (
            <p className="text-muted-foreground mt-3 font-mono text-xs tracking-[0.06em]">
              Reference {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            className="bg-primary text-primary-foreground mt-8 inline-flex h-11 items-center justify-center rounded-lg px-6 text-sm font-medium"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
