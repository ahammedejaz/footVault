"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The one client component on a list page.
 *
 * Sorting and paging are anchors; searching cannot be, because it happens per
 * keystroke. So this is a controlled input that writes the term into the URL
 * after a pause and lets the Server Component re-render against it.
 *
 * **`replace`, not `push`.** Typing "sandal" one letter at a time would
 * otherwise leave six history entries, and the back button would walk the owner
 * backwards through their own typing instead of returning them to where they
 * came from.
 *
 * **`useTransition` rather than a spinner.** The server render is the loading
 * state; marking it pending dims the table instead of replacing it, so the rows
 * do not disappear and reflow under a thumb that is still typing.
 *
 * The form still submits on Enter with JavaScript disabled or not yet loaded,
 * because it is a real `<form method="get">`. That is not a hypothetical on shop
 * wifi.
 */
export function SearchField({
  placeholder,
  label,
  /** Parameters to carry through the form's GET submit when JS has not loaded. */
  hidden,
}: {
  placeholder: string;
  label: string;
  hidden?: Record<string, string | undefined>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = React.useTransition();

  const urlTerm = searchParams.get("q") ?? "";
  const [term, setTerm] = React.useState(urlTerm);

  /**
   * The URL is the source of truth: pressing back, or following a link that
   * clears the search, has to move the box.
   *
   * Adjusted **during render** rather than in an effect. The effect version
   * renders once with the stale term, commits, then sets state and renders
   * again — which is a visible flash of the previous search and, at speed, the
   * cascading-render pattern React's own lint rule flags. Setting state during
   * render of the same component is the documented way to derive state from a
   * changing input: React discards the in-progress render and redoes it before
   * touching the DOM at all.
   *
   * Comparing against the previous *URL* value, not against `term`, is what
   * stops this fighting the person typing.
   */
  const [lastUrlTerm, setLastUrlTerm] = React.useState(urlTerm);
  if (lastUrlTerm !== urlTerm) {
    setLastUrlTerm(urlTerm);
    setTerm(urlTerm);
  }

  const commit = React.useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next) params.set("q", next);
      else params.delete("q");
      // Any change to the term is a new result set, so page four of the old one
      // is meaningless — and an empty page four reads as "no results".
      params.delete("page");
      setLastUrlTerm(next);
      const query = params.toString();
      startTransition(() =>
        router.replace(query ? `${pathname}?${query}` : pathname),
      );
    },
    [pathname, router, searchParams],
  );

  React.useEffect(() => {
    if (term === urlTerm) return;
    const timer = setTimeout(() => commit(term), 300);
    return () => clearTimeout(timer);
  }, [term, urlTerm, commit]);

  return (
    <form
      method="get"
      action={pathname}
      role="search"
      className="relative flex-1 sm:max-w-xs"
      onSubmit={(event) => {
        event.preventDefault();
        commit(term);
      }}
      data-pending={pending ? "" : undefined}
    >
      {Object.entries(hidden ?? {}).map(([key, value]) =>
        value ? (
          <input key={key} type="hidden" name={key} value={value} />
        ) : null,
      )}
      <Search
        className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
        aria-hidden
      />
      <Input
        type="search"
        name="q"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="pr-10 pl-9"
      />
      {term ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Clear search"
          onClick={() => {
            setTerm("");
            commit("");
          }}
          className="absolute top-1/2 right-1 -translate-y-1/2"
        >
          <X className="size-4" />
        </Button>
      ) : null}
    </form>
  );
}
