"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { MessageCircle, Phone } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * The replacement window, as a deadline rather than as legal text.
 *
 * The store's policy is narrow and the clock is short: damage in transit only,
 * reported within 24 hours of delivery, by contacting the shop. A customer
 * should never have to work out when that expires — "within 24 hours of
 * delivery" requires them to know when the courier marked it delivered, which
 * is not information they have. So this states the actual time, and the actual
 * time is what the shop will be held to.
 *
 * It ticks because it has to be right across a page left open. A customer who
 * loaded this at 4:29 PM and reads it at 4:31 must not still be told they have
 * time; the state flips itself and shows how to reach the shop instead.
 *
 * **Nothing here decides anything.** It renders a deadline computed from
 * `orders.delivered_at`, which comes from the courier's own tracking. The
 * decision to grant a replacement is the shop's, taken by a human, and there is
 * deliberately no self-service path to request one.
 */
export function ReplacementWindow({
  deliveredAt,
  windowHours = 24,
  phone,
  whatsapp,
}: {
  /** ISO timestamp from the courier. Null until the parcel is delivered. */
  deliveredAt: string | null;
  windowHours?: number;
  phone: string | null;
  whatsapp: string | null;
}) {
  const deadline = deliveredAt
    ? new Date(
        new Date(deliveredAt).getTime() + windowHours * 60 * 60 * 1000,
      )
    : null;

  /**
   * The clock, as an external store rather than as state in an effect.
   *
   * A `setState` in an effect body is a cascading render, and React's own lint
   * rule says so. Time is genuinely an external system, which is exactly what
   * `useSyncExternalStore` is for — and it gives the server snapshot for free:
   * `null` on the server and on the first client render, so the two agree and a
   * component whose whole job is to disagree with the past does not produce a
   * hydration mismatch doing it.
   */
  const now = useSyncExternalStore(subscribeToClock, readClock, () => null);

  if (!deadline) return null;

  const open = now === null || now < deadline.getTime();

  return (
    <div className="border-border rounded-lg border p-4">
      {open ? (
        <p className="text-sm text-pretty">
          <span className="font-medium">Damaged item?</span> Contact us before{" "}
          <span className="font-medium">{formatDeadline(deadline)}</span> and we
          will replace it.
        </p>
      ) : (
        <p className="text-sm text-pretty">
          <span className="font-medium">
            The 24-hour window for reporting shipment damage has passed.
          </span>{" "}
          If something is wrong with your order, contact us anyway — we would
          rather hear about it.
        </p>
      )}

      <p className="text-muted-foreground mt-1 text-xs text-pretty">
        Replacements are for damage during shipment only. We do not offer
        refunds or returns.{" "}
        <Link href="/page/returns" className="underline underline-offset-2">
          Read the policy
        </Link>
      </p>

      {/*
        One tap, and both routes. If contacting the shop is the *only* way to
        claim a replacement, that contact cannot be a footer link — it has to be
        here, at the moment the customer has decided something is wrong.
      */}
      {phone || whatsapp ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {phone ? (
            <Button asChild size="sm" variant="outline">
              <a href={`tel:${phone.replace(/[^\d+]/g, "")}`}>
                <Phone aria-hidden className="size-4" />
                Call the shop
              </a>
            </Button>
          ) : null}
          {whatsapp ? (
            <Button asChild size="sm" variant="outline">
              <a
                href={`https://wa.me/${whatsapp.replace(/\D/g, "")}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <MessageCircle aria-hidden className="size-4" />
                WhatsApp
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The clock, bucketed to the minute.
 *
 * `getSnapshot` must return a stable value between renders or React re-renders
 * for ever, so the raw millisecond count cannot be handed back directly. The
 * deadline is stated to the minute anyway, so a minute is also the only
 * resolution that can change what is on screen.
 */
let clockBucket = -1;
let clockValue = 0;

function readClock(): number {
  const bucket = Math.floor(Date.now() / 60_000);
  if (bucket !== clockBucket) {
    clockBucket = bucket;
    clockValue = Date.now();
  }
  return clockValue;
}

function subscribeToClock(onChange: () => void): () => void {
  // Twice a minute, so a bucket boundary is never missed by a full tick.
  const timer = setInterval(onChange, 30_000);
  return () => clearInterval(timer);
}

/**
 * "4:30 PM tomorrow", or a date when it is further out.
 *
 * Deliberately not a duration. "22 hours left" makes a customer do arithmetic
 * against a clock they cannot see; a wall-clock time is something they can act
 * on. Uses the reader's own locale and timezone, which for this shop is the
 * same as the shop's, and is correct for a customer who has travelled.
 */
function formatDeadline(deadline: Date): string {
  const time = deadline.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  const today = new Date();
  const sameDay = deadline.toDateString() === today.toDateString();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const isTomorrow = deadline.toDateString() === tomorrow.toDateString();

  if (sameDay) return `${time} today`;
  if (isTomorrow) return `${time} tomorrow`;
  return `${time} on ${deadline.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
  })}`;
}
