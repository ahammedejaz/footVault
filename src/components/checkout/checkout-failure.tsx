"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { abandonUnpaidOrder } from "@/lib/actions/checkout";
import { formatPaise } from "@/lib/format";
import type { PlacedOrder, PlaceOrderResult } from "@/lib/orders/types";

/**
 * What went wrong, in words, with the one fact that matters said first.
 *
 * Every branch below answers "was I charged?" before it answers anything else.
 * A customer who has typed an address and pressed a button is owed that, and
 * "something went wrong" is how a bag gets abandoned and a support email gets
 * written. There is no generic branch here on purpose: `PlaceOrderResult` is a
 * closed union, so adding a reason to it makes this file stop compiling until
 * somebody writes the sentence for it.
 *
 * The three browser-side cases are the ones the server never sees — the modal
 * that would not load, the modal the customer closed, the payment the bank
 * turned down. In all three the order row already exists and its stock is
 * already claimed, which is why they offer **Resume payment** rather than
 * "try again": pressing the main button again would place a second order.
 */

export type ServerFailure = Extract<PlaceOrderResult, { ok: false }>;

export type CheckoutProblem =
  | { source: "server"; result: ServerFailure }
  | {
      source: "browser";
      kind: "modal_unavailable" | "modal_dismissed" | "payment_failed";
      order: PlacedOrder;
      /** Razorpay's own customer-facing description, when it gave one. */
      detail?: string;
    };

export function CheckoutFailure({
  problem,
  onResume,
  resuming,
  signedIn,
  panelRef,
}: {
  problem: CheckoutProblem;
  onResume: () => void;
  resuming: boolean;
  signedIn: boolean;
  panelRef: React.Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      /* Focused by the submit handler rather than announced by a live region:
         doing both makes a screen reader read the whole panel twice. */
      className="border-destructive/40 bg-destructive/5 rounded-lg border p-4 outline-none"
    >
      <div className="flex gap-3">
        <AlertTriangle
          className="text-destructive mt-0.5 size-4 shrink-0"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          {problem.source === "server" ? (
            <ServerCopy failure={problem.result} signedIn={signedIn} />
          ) : (
            <BrowserCopy
              problem={problem}
              onResume={onResume}
              resuming={resuming}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- the parts -- */

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold text-pretty">{children}</h3>;
}

function Body({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-sm text-pretty">{children}</p>;
}

/** The sentence that answers the only question that matters. */
function NotCharged({ children }: { children?: React.ReactNode }) {
  return (
    <p className="mt-2 text-sm font-medium text-pretty">
      Nothing has been charged.{children ? <> {children}</> : null}
    </p>
  );
}

/* ------------------------------------------------------------ server cases -- */

function ServerCopy({
  failure,
  signedIn,
}: {
  failure: ServerFailure;
  signedIn: boolean;
}) {
  switch (failure.reason) {
    case "empty_cart":
      return (
        <>
          <Heading>There is nothing in your bag</Heading>
          <Body>{failure.message}</Body>
          <div className="mt-3">
            <Button variant="outline" size="sm" asChild>
              <Link href="/shop">Shop all footwear</Link>
            </Button>
          </div>
        </>
      );

    case "out_of_stock":
      return (
        <>
          <Heading>Someone reached the last pair first</Heading>
          <Body>{failure.message}</Body>
          <ul className="mt-3 space-y-1.5">
            {failure.items.map((item) => (
              <li
                key={`${item.productName}-${item.size}`}
                className="font-mono text-xs tracking-[0.06em]"
              >
                {item.productName} — UK {item.size}:{" "}
                {item.available === 0
                  ? "sold out"
                  : `${item.available} left, you asked for ${item.requested}`}
              </li>
            ))}
          </ul>
          <NotCharged>Your bag is exactly as you left it.</NotCharged>
          <div className="mt-3">
            <Button variant="outline" size="sm" asChild>
              <Link href="/cart">Edit your bag</Link>
            </Button>
          </div>
        </>
      );

    case "invalid_input":
      return (
        <>
          <Heading>Check that once more</Heading>
          <Body>{failure.message}</Body>
          <NotCharged />
        </>
      );

    case "payment_unavailable":
      return (
        <>
          <Heading>That way of paying is not available right now</Heading>
          <Body>{failure.message}</Body>
          <NotCharged>
            Choose another way to pay and press place order again.
          </NotCharged>
        </>
      );

    case "undeliverable":
      return (
        <>
          <Heading>We cannot deliver to that pin code</Heading>
          <Body>{failure.message}</Body>
          {/* Not "nothing has been charged" as a reassurance about a payment
              that nearly happened — this is refused before an order row is
              written, so the honest thing is to say what to do next. */}
          <p className="mt-2 text-sm text-pretty">
            Nothing has been placed. Your bag is exactly as you left it.
          </p>
          <div className="mt-3">
            <Button variant="outline" size="sm" asChild>
              <Link href="/cart">Back to your bag</Link>
            </Button>
          </div>
        </>
      );

    case "throttled":
      return (
        <>
          <Heading>Give it a moment</Heading>
          <Body>{failure.message}</Body>
          {/* Safe to say plainly: the limiter runs before the first database
              read, so no order row was ever written on this path. */}
          <NotCharged>
            {failure.retryAfterSeconds > 0
              ? `Try again in about ${failure.retryAfterSeconds} second${
                  failure.retryAfterSeconds === 1 ? "" : "s"
                }.`
              : "Try again in a moment."}
          </NotCharged>
        </>
      );

    case "coupon_rejected":
      return (
        <>
          <Heading>That coupon no longer works</Heading>
          <Body>{failure.message}</Body>
          <NotCharged>
            Nothing has been placed and nothing has been charged.{" "}
            <Link href="/cart" className="text-orange-ink underline">
              Open your bag
            </Link>{" "}
            to remove or change the code, then try again.
          </NotCharged>
        </>
      );

    case "coins_rejected":
      return (
        <>
          <Heading>Your coins could not be applied</Heading>
          <Body>{failure.message}</Body>
          <NotCharged>
            Nothing has been placed, nothing has been charged, and your coins
            were not spent. Untick the coins to place the order without them,
            or refresh to see your current balance.
          </NotCharged>
        </>
      );

    case "payment_init_failed":
      return (
        <>
          {/* The one case where the reassurance is the headline. The order row
              was written and rolled back, so a customer who saw a spinner and
              then this needs telling, in the largest words on screen, that no
              money moved. */}
          <Heading>You have not been charged</Heading>
          <Body>{failure.message}</Body>
          <p className="mt-2 text-sm text-pretty">
            We could not reach the payment provider, so nothing was taken and
            your pairs are back on the shelf. Try again in a moment, or choose
            Cash on Delivery.
          </p>
        </>
      );

    case "error":
      return (
        <>
          <Heading>That did not go through</Heading>
          <Body>{failure.message}</Body>
          {/* Deliberately not "nothing has been charged": this branch is the
              one where we genuinely do not know, and guessing on the customer's
              behalf is how someone pays twice. It says how to find out. */}
          <p className="mt-2 text-sm text-pretty">
            Before you try again, check whether the order went through —{" "}
            {signedIn ? (
              <Link
                href="/account/orders"
                className="text-orange-ink underline"
              >
                your orders
              </Link>
            ) : (
              "your email will have a confirmation if it did"
            )}
            . Pressing place order twice makes two orders.
          </p>
        </>
      );

    default:
      /**
       * Not defensive decoration — a compile-time gate.
       *
       * `ServerFailure` is derived from `PlaceOrderResult`, so adding a failure
       * reason silently widens it. Without this line the switch simply falls
       * through, the function returns `undefined`, and React renders an empty
       * panel: a customer whose order failed is shown nothing at all. That is
       * exactly what happened when `throttled` was added, and it type-checked.
       * Now it will not.
       */
      return unhandled(failure);
  }
}

function unhandled(failure: never): never {
  throw new Error(
    `checkout-failure has no copy for ${JSON.stringify(failure)}. ` +
      "Add a case to ServerCopy when adding a PlaceOrderResult reason.",
  );
}

/* ----------------------------------------------------------- browser cases -- */

function BrowserCopy({
  problem,
  onResume,
  resuming,
}: {
  problem: Extract<CheckoutProblem, { source: "browser" }>;
  onResume: () => void;
  resuming: boolean;
}) {
  const { order } = problem;

  /**
   * Cancelling is a two-step confirm rather than a dialog.
   *
   * The customer is already reading an error panel; putting a modal on top of
   * it is one interruption too many, and the panel is small enough that the
   * confirmation fits inside it. `confirming` is local because there is nothing
   * to persist — navigating away is a valid way to change your mind.
   */
  const [confirming, setConfirming] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const [cancelled, setCancelled] = React.useState<string | null>(null);
  const [cancelError, setCancelError] = React.useState<string | null>(null);

  async function cancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      const result = await abandonUnpaidOrder({
        orderNumber: order.orderNumber,
      });
      if (result.ok) setCancelled(result.message);
      else setCancelError(result.message);
    } catch {
      setCancelError(
        "We could not cancel that order just now. Please try again.",
      );
    } finally {
      setCancelling(false);
      setConfirming(false);
    }
  }

  if (cancelled) {
    return (
      <>
        <Heading>That order is cancelled</Heading>
        <Body>{cancelled}</Body>
        <p className="text-muted-foreground mt-2 text-sm text-pretty">
          Your bag has everything back in it, exactly as it was.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" asChild>
            <Link href="/cart">Back to your bag</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/shop">Keep shopping</Link>
          </Button>
        </div>
      </>
    );
  }

  const heading =
    problem.kind === "modal_unavailable"
      ? "The payment window did not open"
      : problem.kind === "modal_dismissed"
        ? "You closed the payment window"
        : "Your payment did not go through";

  const body =
    problem.kind === "modal_unavailable"
      ? "Razorpay's checkout script never loaded. That is usually a blocked script or a connection that dropped, not a problem with your card."
      : problem.kind === "modal_dismissed"
        ? "The window closed before the payment finished."
        : (problem.detail ??
          "Your bank turned the payment down without saying why.");

  return (
    <>
      <Heading>{heading}</Heading>
      <Body>{body}</Body>

      <p className="mt-2 text-sm font-medium text-pretty">
        Nothing has been charged.
        {problem.kind === "payment_failed"
          ? " If your bank has told you about a hold, it releases on its own."
          : null}
      </p>

      <p className="text-muted-foreground mt-2 text-sm text-pretty">
        Order{" "}
        <span className="text-foreground font-mono tracking-[0.06em]">
          {order.orderNumber}
        </span>{" "}
        is saved and unpaid, for {formatPaise(order.grandTotal)}. Use the button
        below to open the payment window again — it pays for this order rather
        than making a second one.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={onResume} disabled={resuming || cancelling}>
          {resuming ? "Opening…" : "Pay for this order"}
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link href={`/order/${order.orderNumber}`}>See the order</Link>
        </Button>
      </div>

      {/* The way out.

          Without this the only ways an unpaid order stops holding its stock are
          the thirty-minute sweep and an admin. A customer who has decided not to
          buy should not have to wait for a cron job, and telling them the stock
          is theirs until they say otherwise is what makes "your bag is exactly
          as you left it" true rather than merely reassuring. */}
      <div className="border-destructive/25 mt-3 border-t pt-3">
        {confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="w-full text-sm font-medium text-pretty">
              Cancel {order.orderNumber}? Your bag comes back and nothing is
              charged.
            </p>
            <Button
              variant="destructive"
              size="sm"
              onClick={cancel}
              disabled={cancelling}
            >
              {cancelling ? "Cancelling…" : "Yes, cancel it"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirming(false)}
              disabled={cancelling}
            >
              Keep it
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive -ml-2"
            onClick={() => setConfirming(true)}
            disabled={resuming}
          >
            Cancel this order instead
          </Button>
        )}
        {cancelError ? (
          <p className="text-destructive mt-2 text-sm text-pretty" role="alert">
            {cancelError}
          </p>
        ) : null}
      </div>
    </>
  );
}
