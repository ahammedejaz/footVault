"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
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
        <AlertTriangle className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          {problem.source === "server" ? (
            <ServerCopy failure={problem.result} signedIn={signedIn} />
          ) : (
            <BrowserCopy problem={problem} onResume={onResume} resuming={resuming} />
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

function ServerCopy({ failure, signedIn }: { failure: ServerFailure; signedIn: boolean }) {
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
          <NotCharged>Choose another way to pay and press place order again.</NotCharged>
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
            We could not reach the payment provider, so nothing was taken and your pairs
            are back on the shelf. Try again in a moment, or choose Cash on Delivery.
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
              <Link href="/account/orders" className="text-orange-ink underline">
                your orders
              </Link>
            ) : (
              "your email will have a confirmation if it did"
            )}
            . Pressing place order twice makes two orders.
          </p>
        </>
      );
  }
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
        : (problem.detail ?? "Your bank turned the payment down without saying why.");

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
        <span className="text-foreground font-mono tracking-[0.06em]">{order.orderNumber}</span>{" "}
        is saved and unpaid, for {formatPaise(order.grandTotal)}. Use the button below to open
        the payment window again — it pays for this order rather than making a second one.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={onResume} disabled={resuming}>
          {resuming ? "Opening…" : "Pay for this order"}
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link href={`/order/${order.orderNumber}`}>See the order</Link>
        </Button>
      </div>
    </>
  );
}
