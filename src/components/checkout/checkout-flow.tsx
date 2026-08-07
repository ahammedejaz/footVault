"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Script from "next/script";

import {
  AddressFields,
  EMPTY_ADDRESS,
  Field,
  fieldId,
  type AddressDraft,
  type FieldErrors,
} from "@/components/checkout/address-fields";
import { AddressCard } from "@/components/checkout/address-card";
import { CheckRow } from "@/components/checkout/check-row";
import { CheckoutFailure, type CheckoutProblem } from "@/components/checkout/checkout-failure";
import { ChoiceCard } from "@/components/checkout/choice-card";
import { RAZORPAY_CHECKOUT_SRC, waitForRazorpay } from "@/components/checkout/razorpay";
import type { RazorpaySuccess } from "@/components/checkout/razorpay";
import { Totals } from "@/components/checkout/totals";
import { EmptyState } from "@/components/storefront/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { placeOrder } from "@/lib/actions/checkout";
import { verifyRazorpayPayment } from "@/lib/actions/payment";
import type { SavedAddress } from "@/lib/address-types";
import type { CartLine } from "@/lib/cart-types";
import { formatPaise } from "@/lib/format";
import type { OrderTotals, PlaceOrderInput, PlacedOrder } from "@/lib/orders/types";
import type { PaymentMethod, PaymentMethodCopy } from "@/lib/payments/types";
import { useBagUi } from "@/lib/stores/bag";
import { toast } from "@/lib/toast";
import {
  checkoutSchema,
  phoneSchema,
  type ShippingAddressInput,
} from "@/lib/validations/checkout";

/**
 * Checkout.
 *
 * Three decisions shape this file.
 *
 * **One page, not a wizard.** A stepped checkout hides the total behind a
 * "next" button and makes going back to fix a typo cost two navigations. Every
 * field is on one screen, in the order a customer answers them — where it goes,
 * how to reach you, how you are paying — with the money always visible.
 *
 * **The same Zod schema as the server.** `checkoutSchema` is imported here and
 * in the server action, so a six-digit PIN rule cannot be stricter in one place
 * than the other. This copy exists to say "that PIN is five digits" before a
 * round trip; it is not a security control, and the server re-parses everything
 * because a POST can be made without ever loading this page.
 *
 * **The order exists before the payment window opens.** So every browser-side
 * failure after that point — script blocked, modal closed, card declined —
 * offers *resume*, never *retry*. Pressing the main button again would place a
 * second order and claim a second unit of stock.
 */

export type CheckoutFlowProps = {
  lines: CartLine[];
  totals: OrderTotals;
  itemCount: number;
  /** From `availablePaymentMethods()`. Never a list written in this file. */
  methods: PaymentMethodCopy[];
  addresses: SavedAddress[];
  signedIn: boolean;
  /** Prefills the recipient. The customer can overwrite it. */
  customerName: string | null;
};

/** The sentinel for "none of the saved ones". Not a uuid, so it cannot collide. */
const NEW_ADDRESS = "new";

/**
 * What the form hands the schema — the schema's own input type, with the two
 * fields a half-filled form is allowed to disagree with it about.
 */
type AddressPayload = Omit<ShippingAddressInput, "state" | "line2"> & {
  state: string;
  line2: string | undefined;
};

export function CheckoutFlow({
  lines,
  totals,
  itemCount,
  methods,
  addresses,
  signedIn,
  customerName,
}: CheckoutFlowProps) {
  const router = useRouter();
  const refreshBag = useBagUi((state) => state.refresh);

  const defaultAddress = addresses.find((address) => address.isDefault) ?? addresses[0] ?? null;

  const [addressChoice, setAddressChoice] = useState<string>(
    defaultAddress ? defaultAddress.id : NEW_ADDRESS,
  );
  const [draft, setDraft] = useState<AddressDraft>({
    ...EMPTY_ADDRESS,
    recipientName: customerName ?? "",
  });
  const [saveToBook, setSaveToBook] = useState(true);
  const [contactEmail, setContactEmail] = useState("");
  const [customerNote, setCustomerNote] = useState("");
  const [method, setMethod] = useState<PaymentMethod | null>(methods[0]?.method ?? null);

  const [errors, setErrors] = useState<FieldErrors>({});
  const [attempted, setAttempted] = useState(false);
  const [problem, setProblem] = useState<CheckoutProblem | null>(null);

  const [placing, startPlacing] = useTransition();
  const [paying, setPaying] = useState(false);
  const [resuming, setResuming] = useState(false);
  /** Kept so a dismissed modal can be reopened against the same order. */
  const [placed, setPlaced] = useState<PlacedOrder | null>(null);

  const panel = useRef<HTMLDivElement>(null);
  /**
   * Razorpay fires `ondismiss` when the modal closes *after* a successful
   * payment as well as when the customer walks away, so the dismiss handler
   * needs to know whether anything already happened. A ref rather than state:
   * the callbacks close over it and must read the current value, not the value
   * at the render that created them.
   */
  const outcome = useRef<"none" | "settled" | "failed">("none");

  const usingNewAddress = addressChoice === NEW_ADDRESS;
  const chosenAddress = addresses.find((address) => address.id === addressChoice) ?? null;
  const offersRazorpay = methods.some((entry) => entry.method === "razorpay");
  const busy = placing || paying || resuming;

  // Focus the failure so a keyboard or screen-reader customer is not left at
  // the bottom of a form wondering what the button did. Focus rather than a
  // live region: doing both reads the whole panel twice.
  useEffect(() => {
    if (problem) panel.current?.focus();
  }, [problem]);

  /* ------------------------------------------------------------ validation -- */

  /**
   * The *input* shape, not `ShippingAddress`.
   *
   * `line2` is the reason the distinction matters. The schema's output type has
   * it as `string | null`, because that is what belongs in the snapshot — but
   * the schema *accepts* `string | undefined` and turns an empty one into null
   * on the way through. Handing it a null instead of an undefined makes
   * `z.string()` reject it, and the form then refuses to submit with an error
   * on a field the customer deliberately left blank. Caught by a browser run
   * that left the landmark line empty; the run that filled it passed.
   *
   * `state` widens back to `string` because a draft is allowed to hold the
   * empty one — "no state chosen yet" is a state of the form, and narrowing it
   * to the enum here would mean the type system refusing to represent the very
   * value the schema exists to reject with "Choose a state."
   */
  function currentAddress(): AddressPayload {
    return {
      recipientName: draft.recipientName,
      phone: draft.phone,
      line1: draft.line1,
      line2: draft.line2.trim() ? draft.line2 : undefined,
      city: draft.city,
      state: draft.state,
      postalCode: draft.postalCode,
      country: "IN",
    };
  }

  function buildInput(): Record<string, unknown> {
    const rawPhone = usingNewAddress ? draft.phone : (chosenAddress?.phone ?? "");
    const phone = phoneSchema.safeParse(rawPhone);

    return {
      paymentMethod: method ?? "",
      addressId: usingNewAddress ? undefined : addressChoice,
      address: usingNewAddress ? currentAddress() : undefined,
      contactEmail: signedIn ? undefined : contactEmail.trim() || undefined,
      // Derived rather than asked for. The delivery number is already on the
      // address, and a second phone field on a phone is a field nobody fills
      // in. Only sent when it parses, so a bad number is reported once — on
      // the address field the customer can actually see.
      contactPhone: phone.success ? phone.data : undefined,
      customerNote: customerNote.trim() || undefined,
      saveAddress: signedIn && usingNewAddress ? saveToBook : undefined,
    };
  }

  /** Where a Zod issue path points on screen, so focus can go there. */
  function elementForPath(path: PropertyKey[]): HTMLElement | null {
    const [head, tail] = path;

    if (head === "address" && typeof tail === "string") {
      return document.getElementById(fieldId(tail));
    }
    if (head === "address") {
      // The superRefine's "add a delivery address" — the form if it is showing,
      // otherwise the first radio in the book.
      return (
        document.getElementById(fieldId("recipientName")) ??
        document.querySelector<HTMLElement>('input[name="addressChoice"]')
      );
    }
    if (head === "paymentMethod") {
      return document.querySelector<HTMLElement>('input[name="paymentMethod"]');
    }
    if (typeof head === "string") return document.getElementById(fieldId(head));
    return null;
  }

  function validateAddressField(name: keyof AddressDraft) {
    // Before the first submit, leaving an empty field alone is not a mistake —
    // it is a field the customer has not reached yet.
    if (!attempted && !draft[name].trim()) return;

    const parsed = checkoutSchema({ requireContactEmail: false }).safeParse({
      paymentMethod: method ?? "cod",
      address: currentAddress(),
    });
    const issue = parsed.success
      ? undefined
      : parsed.error.issues.find((entry) => entry.path[0] === "address" && entry.path[1] === name);

    setErrors((previous) => ({ ...previous, [`address.${name}`]: issue?.message }));
  }

  /* ----------------------------------------------------------------- place -- */

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    setAttempted(true);
    setProblem(null);

    const parsed = checkoutSchema({ requireContactEmail: !signedIn }).safeParse(buildInput());

    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join(".");
        if (!next[key]) next[key] = issue.message;
      }
      setErrors(next);

      for (const issue of parsed.error.issues) {
        const element = elementForPath(issue.path);
        if (element) {
          element.focus();
          element.scrollIntoView({ block: "center", behavior: "smooth" });
          break;
        }
      }
      return;
    }

    setErrors({});

    /**
     * `line2` goes over the wire as `""`, never as `null`, and that is not a
     * style choice.
     *
     * `PlaceOrderInput.address` is typed `ShippingAddress`, whose `line2` is
     * `string | null` — but `shippingAddressSchema`, which the server re-parses
     * with, rejects null outright ("expected string, received null"). So the
     * one value the published type offers for "no landmark" is the one the
     * published schema refuses, and a client that obeyed the type would fail
     * every checkout where the landmark line was left blank. `""` satisfies
     * both: it is a `string`, and the schema turns it into the null the
     * snapshot wants. **Reported to the lead** — the real fix is `.nullish()`
     * on that field in `src/lib/validations/checkout.ts`, which is not mine.
     */
    const address = parsed.data.address
      ? { ...parsed.data.address, line2: parsed.data.address.line2 ?? "" }
      : undefined;

    const input: PlaceOrderInput = {
      paymentMethod: parsed.data.paymentMethod,
      addressId: parsed.data.addressId,
      address,
      contactEmail: parsed.data.contactEmail,
      contactPhone: parsed.data.contactPhone,
      customerNote: parsed.data.customerNote ?? undefined,
      saveAddress: parsed.data.saveAddress,
    };

    startPlacing(async () => {
      const result = await placeOrder(input);

      if (!result.ok) {
        setProblem({ source: "server", result });
        if (result.reason === "invalid_input" && result.field) {
          elementForPath(result.field.split("."))?.focus();
        }
        return;
      }

      setPlaced(result.order);
      // The bag is converted server-side on success; the header badge and the
      // drawer both hold their own copy and would otherwise stay stale until
      // the next full navigation.
      void refreshBag();

      if (result.order.initiation.kind === "none") {
        router.push(`/order/${result.order.orderNumber}?placed=placed`);
        return;
      }

      await openPaymentWindow(result.order);
    });
  }

  /* --------------------------------------------------------------- razorpay -- */

  async function openPaymentWindow(order: PlacedOrder) {
    const initiation = order.initiation;
    if (initiation.kind !== "razorpay") return;

    setPaying(true);
    const Razorpay = await waitForRazorpay();

    if (!Razorpay) {
      setPaying(false);
      setProblem({ source: "browser", kind: "modal_unavailable", order });
      return;
    }

    outcome.current = "none";

    const checkout = new Razorpay({
      key: initiation.keyId,
      amount: initiation.amountPaise,
      currency: initiation.currency,
      order_id: initiation.providerOrderId,
      name: "Foot Vault",
      description: `Order ${order.orderNumber}`,
      prefill: {
        name: initiation.prefill.name,
        email: initiation.prefill.email ?? undefined,
        contact: initiation.prefill.contact ?? undefined,
      },
      notes: { order_number: order.orderNumber },
      theme: { color: "#033894" },
      modal: {
        ondismiss: () => {
          if (outcome.current !== "none") return;
          setPaying(false);
          setProblem({ source: "browser", kind: "modal_dismissed", order });
        },
      },
      handler: (response) => {
        outcome.current = "settled";
        void settle(order, response);
      },
    });

    checkout.on("payment.failed", (response) => {
      outcome.current = "failed";
      setPaying(false);
      // The modal is left open on purpose. Razorpay's own retry lives inside
      // it, and closing it would take away the cheapest fix — another card,
      // without a round trip. This message is what is waiting underneath if
      // the customer gives up and closes it.
      setProblem({
        source: "browser",
        kind: "payment_failed",
        order,
        detail: safeDetail(response.error?.description),
      });
    });

    checkout.open();
  }

  async function settle(order: PlacedOrder, response: RazorpaySuccess) {
    try {
      const verdict = await verifyRazorpayPayment({
        razorpay_order_id: response.razorpay_order_id,
        razorpay_payment_id: response.razorpay_payment_id,
        razorpay_signature: response.razorpay_signature,
      });

      if (!verdict.ok) {
        // Not a failure the customer can act on, and not a reason to strand
        // them on a page whose only button places another order. The
        // confirmation page reads the authoritative payment state, and the
        // webhook is what decides it either way.
        toast.note(
          "We could not confirm that payment from your browser",
          "Your order is placed. The next page shows its live payment status.",
        );
      }
    } catch (error) {
      console.error("[checkout] verifying the callback threw:", error);
      toast.note(
        "We could not confirm that payment from your browser",
        "Your order is placed. The next page shows its live payment status.",
      );
    }

    void refreshBag();
    router.push(`/order/${order.orderNumber}?placed=placed`);
  }

  function resume() {
    if (!placed) return;
    setProblem(null);
    setResuming(true);
    void openPaymentWindow(placed).finally(() => setResuming(false));
  }

  /* ------------------------------------------------------------------- view -- */

  /**
   * Once the order exists, this page stops being a form.
   *
   * Not a nicety — a correctness fix, and one a browser run found. `placeOrder`
   * revalidates, which re-renders this route, and by then the cart is
   * `converted` and empty. When the page owned the empty-bag branch, that
   * re-render swapped `CheckoutFlow` for an empty state **while the Razorpay
   * modal was still open**, destroying the state that held the order number and
   * the only affordance that could reopen the modal. A customer with an unpaid
   * order was left looking at "there is nothing to check out".
   *
   * So the empty-bag branch lives here rather than in the page — the component
   * stays mounted through the revalidation — and once `placed` is set it shows
   * the order instead of the form. Which is also the honest thing: the address
   * and the payment method are settled the moment the row is written, and
   * leaving them editable behind an open modal invites edits that do nothing.
   */
  if (placed) {
    return (
      <div className="mt-8 max-w-xl">
        <h2 className="text-lg font-semibold">Your order is saved</h2>
        <p className="mt-3 font-mono text-2xl font-medium">
          <span className="sr-only">Order number </span>
          {placed.orderNumber}
        </p>
        <p className="text-muted-foreground mt-2 text-sm">
          {formatPaise(placed.grandTotal)} · waiting for payment
        </p>

        {problem ? (
          <div className="mt-5">
            <CheckoutFailure
              problem={problem}
              onResume={resume}
              resuming={resuming}
              signedIn={signedIn}
              panelRef={panel}
            />
          </div>
        ) : (
          <>
            <p className="mt-5 text-base text-pretty">
              The payment window is open. Finish there — nothing has been charged yet,
              and your pairs are held for this order either way.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button onClick={resume} disabled={resuming || paying}>
                {resuming || paying ? "Opening…" : "Reopen the payment window"}
              </Button>
              <Button variant="outline" asChild>
                <Link href={`/order/${placed.orderNumber}`}>See the order</Link>
              </Button>
            </div>
          </>
        )}
      </div>
    );
  }

  if (lines.length === 0) {
    return (
      <EmptyState
        title="There is nothing to check out"
        body="Your bag is empty. Anything you add will still be here when you come back to this page."
        action={{ href: "/shop", label: "Shop all footwear" }}
      />
    );
  }

  const payLabel =
    method === "razorpay"
      ? `Pay ${formatPaise(totals.grandTotal)}`
      : "Place order";

  return (
    <form onSubmit={submit} noValidate>
      {/* Only on the one route that needs it, and only when the method is
          actually on offer. `lazyOnload` keeps it off the critical path; the
          click path polls for it rather than assuming it has landed. */}
      {offersRazorpay ? <Script src={RAZORPAY_CHECKOUT_SRC} strategy="lazyOnload" /> : null}

      {/* The same two-column proportions as /cart, deliberately: a customer
          crossing from the bag to checkout should not feel the page change
          shape underneath them. */}
      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_23rem] lg:gap-10">
        <div className="min-w-0 space-y-10">
          {/* ------------------------------------------------------ address -- */}
          <section aria-labelledby="checkout-address-heading">
            <h2 id="checkout-address-heading" className="text-lg font-semibold">
              Where should it go?
            </h2>

            {addresses.length > 0 ? (
              <fieldset className="mt-4">
                <legend className="sr-only">Choose a delivery address</legend>
                <div className="space-y-3">
                  {addresses.map((address) => (
                    <ChoiceCard
                      key={address.id}
                      name="addressChoice"
                      value={address.id}
                      checked={addressChoice === address.id}
                      onSelect={setAddressChoice}
                      title={
                        <>
                          {address.label ?? address.recipientName}
                          {address.isDefault ? (
                            <span className="text-muted-foreground ml-2 font-mono text-xs tracking-[0.06em] uppercase">
                              Default
                            </span>
                          ) : null}
                        </>
                      }
                    >
                      <AddressCard address={address} />
                    </ChoiceCard>
                  ))}

                  <ChoiceCard
                    name="addressChoice"
                    value={NEW_ADDRESS}
                    checked={usingNewAddress}
                    onSelect={setAddressChoice}
                    title="Send it somewhere else"
                    description="Type a new address for this order."
                  />
                </div>
              </fieldset>
            ) : null}

            {usingNewAddress ? (
              <>
                <AddressFields
                  className="mt-6"
                  draft={draft}
                  errors={errors}
                  onChange={(name, value) =>
                    setDraft((previous) => ({ ...previous, [name]: value }))
                  }
                  onBlurField={validateAddressField}
                />

                {signedIn ? (
                  <div className="mt-4">
                    <CheckRow
                      name="saveAddress"
                      checked={saveToBook}
                      onChange={setSaveToBook}
                      label="Save this address for next time"
                      hint="It goes in your address book. What ships is a copy, so editing it later never changes an order already placed."
                    />
                  </div>
                ) : null}
              </>
            ) : null}
          </section>

          {/* ------------------------------------------------------ contact -- */}
          {signedIn ? null : (
            <section aria-labelledby="checkout-contact-heading">
              <h2 id="checkout-contact-heading" className="text-lg font-semibold">
                Where should we send the receipt?
              </h2>
              <p className="text-muted-foreground mt-2 text-sm text-pretty">
                You do not need an account to buy. We use this for the order confirmation
                and nothing else.
              </p>

              <Field
                name="contactEmail"
                label="Email"
                className="mt-4 max-w-md"
                error={errors["contactEmail"]}
              >
                {(props) => (
                  <Input
                    {...props}
                    name="contactEmail"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    value={contactEmail}
                    onChange={(event) => setContactEmail(event.target.value)}
                  />
                )}
              </Field>
            </section>
          )}

          {/* --------------------------------------------------------- note -- */}
          <section aria-labelledby="checkout-note-heading">
            <h2 id="checkout-note-heading" className="text-lg font-semibold">
              Anything the delivery agent should know?
            </h2>

            <Field
              name="customerNote"
              label="Delivery note"
              optional
              className="mt-4"
              error={errors["customerNote"]}
              hint="A landmark, a gate number, a time that works. 500 characters."
            >
              {(props) => (
                /* A plain textarea rather than a new ui/ primitive: one usage
                   does not earn a shared component, and the three classes that
                   matter — the 16px floor that stops iOS zooming, the token
                   border, the token radius — are copied from Input on purpose
                   so the two fields cannot look like different form systems.
                   Input's `outline-none` is deliberately *not* copied: it
                   outranks the global :focus-visible rule and deletes the
                   orange half of the focus ring. See ui/select.tsx. */
                <textarea
                  {...props}
                  name="customerNote"
                  rows={3}
                  maxLength={500}
                  value={customerNote}
                  onChange={(event) => setCustomerNote(event.target.value)}
                  className="border-input aria-invalid:border-destructive min-h-24 w-full rounded-lg border bg-transparent px-3 py-2 text-base transition-colors"
                />
              )}
            </Field>
          </section>

          {/* ------------------------------------------------------ payment -- */}
          <section aria-labelledby="checkout-payment-heading">
            <h2 id="checkout-payment-heading" className="text-lg font-semibold">
              How would you like to pay?
            </h2>

            {methods.length === 0 ? (
              <p className="border-destructive/40 bg-destructive/5 mt-4 rounded-lg border p-4 text-sm text-pretty">
                No payment method is available right now, so this order cannot be placed.
                Nothing in your bag has been lost — try again shortly, or call us and we
                will take the order by phone.
              </p>
            ) : (
              <fieldset className="mt-4">
                <legend className="sr-only">Choose how to pay</legend>
                <div className="space-y-3">
                  {methods.map((entry) => (
                    <ChoiceCard
                      key={entry.method}
                      name="paymentMethod"
                      value={entry.method}
                      checked={method === entry.method}
                      onSelect={(value) => setMethod(value as PaymentMethod)}
                      title={entry.label}
                      description={entry.description}
                      note={entry.note}
                    />
                  ))}
                </div>
              </fieldset>
            )}

            {errors["paymentMethod"] ? (
              <p className="text-destructive mt-2 text-xs text-pretty">
                {errors["paymentMethod"]}
              </p>
            ) : null}
          </section>
        </div>

        {/* -------------------------------------------------------- summary -- */}
        <aside aria-labelledby="checkout-summary-heading" className="lg:sticky lg:top-24 lg:self-start">
          <div className="bg-fog border-border rounded-lg border p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h2
                id="checkout-summary-heading"
                className="font-mono text-xs tracking-[0.06em] uppercase"
              >
                Order summary
              </h2>
              {/* 45×16 as a bare link. `hit-44` rather than a padded box: this
                  sits on the summary's title row, and a 44px-tall control there
                  would push the whole card open by half a line. */}
              <Link href="/cart" className="hit-44 text-orange-ink text-xs underline">
                Edit bag
              </Link>
            </div>

            <ul className="divide-border mt-4 divide-y">
              {lines.map((line) => (
                <li key={line.id} className="flex items-start gap-3 py-3 first:pt-0">
                  <div className="bg-paper relative aspect-4/5 w-12 shrink-0 overflow-hidden rounded-md">
                    {line.imageUrl ? (
                      <Image
                        src={line.imageUrl}
                        alt=""
                        fill
                        loading="lazy"
                        sizes="48px"
                        className="object-cover"
                      />
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-pretty">{line.productName}</p>
                    <p className="text-muted-foreground mt-0.5 font-mono text-xs tracking-[0.06em]">
                      UK {line.size} · {line.quantity} ×{" "}
                      {formatPaise(line.unitPrice)}
                    </p>
                  </div>
                  <p className="shrink-0 font-mono text-sm">{formatPaise(line.lineTotal)}</p>
                </li>
              ))}
            </ul>

            <div className="border-border mt-4 border-t pt-4">
              <Totals totals={totals} itemCount={itemCount} />
            </div>

            <Button
              type="submit"
              size="lg"
              className="mt-5 w-full"
              disabled={busy || methods.length === 0}
            >
              {placing ? "Placing your order…" : paying ? "Waiting for payment…" : payLabel}
            </Button>

            {/* The totals above are a preview. The server recomputes every
                rupee from the catalog when the order is written, so this says
                so rather than letting a stale price look like a promise. */}
            <p className="text-muted-foreground mt-3 text-center text-xs text-pretty">
              Prices are confirmed against the catalogue when the order is placed.
            </p>
          </div>

          {problem ? (
            <div className="mt-4">
              <CheckoutFailure
                problem={problem}
                onResume={resume}
                resuming={resuming}
                signedIn={signedIn}
                panelRef={panel}
              />
            </div>
          ) : null}
        </aside>
      </div>
    </form>
  );
}

/**
 * Razorpay's `error.description` is written for a customer, but it arrives from
 * a system that is not ours and it lands in our page. Bounded and typed before
 * it is rendered — a provider error dump is not something to show anybody.
 */
function safeDetail(description: string | undefined): string | undefined {
  if (typeof description !== "string") return undefined;
  const trimmed = description.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}
