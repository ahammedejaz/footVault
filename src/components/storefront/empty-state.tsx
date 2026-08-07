import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * The one empty state.
 *
 * Every empty screen on the storefront says what is not there and offers the
 * next thing to do — "Nothing in your bag yet, start with the new arrivals"
 * rather than "No items". The tread rule keeps it from reading as an error.
 */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className="mx-auto max-w-md px-4 py-20 text-center sm:px-6">
      <div className="tread-rule mx-auto w-24" aria-hidden="true" />
      <h2 className="font-display mt-8 text-2xl font-bold tracking-[-0.02em] uppercase">
        {title}
      </h2>
      <p className="text-muted-foreground mt-3 text-base text-pretty">{body}</p>
      {action ? (
        <Button size="lg" asChild className="mt-7">
          <Link href={action.href}>{action.label}</Link>
        </Button>
      ) : null}
    </div>
  );
}
