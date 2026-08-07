"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { Loader2, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatPaise } from "@/lib/format";

type Suggestion = {
  slug: string;
  name: string;
  brand: string | null;
  price: number;
  image: string | null;
  inStock: boolean;
};

/**
 * Search, as a full-screen overlay.
 *
 * On a phone a search field crammed into a 64px header bar is a 200px input
 * with the keyboard covering the results; this takes the whole screen, which is
 * what every app a customer already uses does. The same component serves the
 * desktop, where it opens as a panel — one code path, one behaviour to get
 * right.
 *
 * Debounced at 220ms with the previous request aborted, so typing "pegasus"
 * issues one query rather than seven, and a slow response for "peg" can never
 * land after and overwrite the results for "pegasus".
 */
export function SearchPanel({
  open,
  onOpenChange,
  popular,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  popular: Array<{ label: string; href: string }>;
}) {
  const router = useRouter();
  const setOpen = onOpenChange;
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<Suggestion[]>([]);
  const [total, setTotal] = React.useState(0);
  const [pending, setPending] = React.useState(false);

  const trimmed = query.trim();
  const searching = trimmed.length >= 2;

  React.useEffect(() => {
    if (trimmed.length < 2) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setPending(true);
      try {
        const response = await fetch(
          `/api/search/suggest?q=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error(`suggest: ${response.status}`);
        const data = (await response.json()) as { results: Suggestion[]; total: number };
        setResults(data.results);
        setTotal(data.total);
      } catch (error) {
        // An aborted request is the expected outcome of typing another letter.
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("[search] suggestions failed", error);
        setResults([]);
        setTotal(0);
      } finally {
        setPending(false);
      }
    }, 220);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed]);

  // Below two characters nothing has been searched for, so nothing is shown —
  // derived rather than cleared, which keeps the effect free of synchronous
  // state writes and means a fast backspace cannot leave stale rows on screen.
  const visible = searching ? results : [];

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed) return;
    setOpen(false);
    router.push(`/search?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="data-open:animate-in data-open:fade-in-0 fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="bg-background data-open:animate-in data-open:slide-in-from-top-4 fixed inset-0 z-50 flex flex-col sm:inset-x-0 sm:top-0 sm:bottom-auto sm:max-h-[80vh] sm:rounded-b-xl sm:border-b sm:shadow-lg">
          <Dialog.Title className="sr-only">Search the shop</Dialog.Title>
          <Dialog.Description className="sr-only">
            Results appear as you type. Press Enter to see all of them.
          </Dialog.Description>

          <form
            onSubmit={submit}
            role="search"
            className="border-border mx-auto flex w-full max-w-3xl items-center gap-2 border-b px-4 py-3 sm:px-6"
          >
            <Search className="text-muted-foreground size-5 shrink-0" aria-hidden />
            <label htmlFor="fv-search" className="sr-only">
              Search for a brand, a model or a category
            </label>
            <input
              id="fv-search"
              type="search"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Try a brand, a model, or “running”"
              // 16px minimum: anything smaller and iOS Safari zooms the page
              // the moment this is focused.
              className="h-12 min-w-0 flex-1 bg-transparent text-base outline-none"
            />
            {pending ? (
              <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" aria-hidden />
            ) : null}
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close search">
                <X />
              </Button>
            </Dialog.Close>
          </form>

          <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 py-4 sm:px-6">
            <p className="sr-only" aria-live="polite" aria-atomic="true">
              {!searching
                ? ""
                : pending
                  ? "Searching"
                  : `${total} ${total === 1 ? "result" : "results"} for ${trimmed}`}
            </p>

            {!searching ? (
              <nav aria-label="Popular searches">
                <h2 className="text-muted-foreground font-mono text-xs tracking-[0.06em] uppercase">
                  Popular right now
                </h2>
                <ul className="mt-3 flex flex-wrap gap-2">
                  {popular.map((item) => (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => setOpen(false)}
                        className="border-border hover:border-foreground inline-flex min-h-11 items-center rounded-lg border px-3 text-sm transition-colors"
                      >
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            ) : visible.length === 0 && !pending ? (
              <div className="py-8 text-center">
                <p className="text-base">
                  Nothing matches “<span className="font-medium">{trimmed}</span>”.
                </p>
                <p className="text-muted-foreground mt-2 text-sm">
                  Spelling is forgiven — a brand on its own usually finds it.
                </p>
                <ul className="mt-5 flex flex-wrap justify-center gap-2">
                  {popular.map((item) => (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => setOpen(false)}
                        className="border-border hover:border-foreground inline-flex min-h-11 items-center rounded-lg border px-3 text-sm transition-colors"
                      >
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <>
                <ul className="divide-border divide-y">
                  {visible.map((result) => (
                    <li key={result.slug}>
                      <Link
                        href={`/product/${result.slug}`}
                        onClick={() => setOpen(false)}
                        className="hover:bg-muted -mx-2 flex items-center gap-3 rounded-lg px-2 py-2"
                      >
                        <span className="bg-fog relative size-14 shrink-0 overflow-hidden rounded-lg">
                          {result.image ? (
                            <Image
                              src={result.image}
                              alt=""
                              aria-hidden
                              fill
                              sizes="56px"
                              className="object-cover"
                            />
                          ) : null}
                        </span>
                        <span className="min-w-0 flex-1">
                          {result.brand ? (
                            <span className="text-muted-foreground block font-mono text-xs tracking-[0.06em] uppercase">
                              {result.brand}
                            </span>
                          ) : null}
                          <span className="block truncate text-sm font-medium">
                            {result.name}
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block font-mono text-sm tabular-nums">
                            {formatPaise(result.price)}
                          </span>
                          {!result.inStock ? (
                            <span className="text-dim block font-mono text-xs">Sold out</span>
                          ) : null}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                {total > visible.length ? (
                  <Button variant="outline" className="mt-4 w-full" onClick={submit}>
                    See all {total} results
                  </Button>
                ) : null}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
