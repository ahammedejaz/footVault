"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  saveAnnouncement,
  saveParcelDefaults,
  saveShippingSettings,
  saveStoreSettings,
} from "@/lib/actions/admin/settings";
import { toast } from "@/lib/toast";
import {
  Amount,
  Field,
  Money,
  RadioChoice,
  Text,
  Toggle,
} from "@/components/admin/settings/controls";
import { Input } from "@/components/ui/input";

/**
 * The two settings forms.
 *
 * Money is entered in **rupees**, always. The database stores paise and the
 * owner should never have to know that; a field that silently wants 9900 when
 * you meant ₹99 is a hundredfold pricing error waiting for a distracted
 * afternoon. The action converts once, at the boundary.
 */

function useSaver() {
  const router = useRouter();
  const [saving, setSaving] = React.useState(false);
  async function save(
    action: () => Promise<{ ok: boolean; message?: string }>,
    success: string,
  ) {
    if (saving) return;
    setSaving(true);
    try {
      const result = await action();
      if (result.ok) {
        toast.done(success);
        router.refresh();
      } else {
        toast.failed(result.message ?? "That did not save.");
      }
    } finally {
      setSaving(false);
    }
  }
  return { saving, save };
}

export type ShippingFormValues = {
  freeAboveRupees: number;
  codEnabled: boolean;
  codMinimumOrderRupees: number;
  codAdvanceMaximumRupees: number;
  includeGstInAdvance: boolean;
  prepaidDiscountMode: "flat" | "percent";
  prepaidDiscountValue: number;
  maxTotalDiscountPercent: number;
  courierSelectionMode: "cheapest" | "shiprocket" | "best_rated";
  courierPriceTolerancePercent: number;
  shippingRateMode: "live" | "flat";
  flatShippingFeeRupees: number;
  flatCodDepositMode: "unset" | "multiplier" | "fixed";
  flatCodDepositMultiplier: number;
  flatCodDepositRupees: number;
  waiveCodFeeAboveThreshold: boolean;
  fallbackBehaviour: "refuse_cod" | "allow_all";
  rtoDeductionPolicy: "actual_freight" | "flat" | "none";
  rtoDeductionFlatRupees: number;
  prepaidEstimateRupees: number;
  walletLowBalanceRupees: number;
};

/**
 * The numbers that decide whether the shop makes money.
 *
 * The owner is not technical, so every control here says what it does **and
 * what happens if it is set too high or too low** — the brief asked for exactly
 * that, and the second half is the half that matters. "Cap on the deposit"
 * tells a shopkeeper nothing; "set it too low and a heavy parcel to a far pin
 * code is not fully covered if it comes back" tells them how to choose.
 */
export function ShippingSettingsForm({
  initial,
}: {
  initial: ShippingFormValues;
}) {
  const { saving, save } = useSaver();
  const [v, setV] = React.useState(initial);

  const set = <K extends keyof ShippingFormValues>(
    key: K,
    value: ShippingFormValues[K],
  ) => setV((prev) => ({ ...prev, [key]: value }));

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save(() => saveShippingSettings(v), "Delivery settings saved.");
      }}
      className="space-y-8"
    >
      {/*
        The panel used to open with this, in bold, as the largest thing on it:

          **Delivery rates are not set here.** What a customer pays to receive a
          parcel comes from Shiprocket, for their pin code, every time.

        It is true in the sense its author meant — per-pin-code rates come from
        the courier — and false in the sense the reader takes it. An owner who
        came here to set a flat delivery charge read the most prominent sentence
        on the page, was told authoritatively that this page does not do that,
        and stopped scanning. The control that does exactly that sat 180 pixels
        below it.

        So it now says what *is* here, and it is a caption rather than a headline.
      */}
      <p className="text-muted-foreground text-sm text-pretty">
        Per-pin-code rates come from Shiprocket. What you set here is how the
        customer is charged, and the thresholds the shop decides for itself.
      </p>

      <Section title="How delivery is charged">
        <RadioChoice
          name="delivery-mode"
          legend="How the delivery charge is decided"
          value={v.shippingRateMode}
          onChange={(next) => set("shippingRateMode", next)}
          options={[
            {
              value: "live",
              label: "Charge the courier's rate",
              note: "Recommended. Every customer pays what it costs to reach them.",
            },
            {
              value: "flat",
              label: "Charge one flat amount",
              note: "One number for everybody, whatever the courier quotes.",
            },
          ]}
          hint={
            v.shippingRateMode === "live"
              ? "You never lose money on a far pin code, and some customers see a higher figure than others."
              : "Simpler to explain, and Shiprocket is not called at all — so the shop keeps selling through a courier outage, cannot tell you whether a pin code is serviceable, and absorbs the difference on remote addresses."
          }
        />

        {/*
          Rendered whatever the mode, disabled when it does not apply.

          It used to be absent from the DOM entirely until flat mode was chosen,
          so an owner scanning for the words "flat amount" found nothing twice
          over: once in the closed dropdown, once here. A feature has to be
          visible before it can be chosen.
        */}
        <Money
          id="delivery-flat"
          label="Flat delivery charge"
          value={v.flatShippingFeeRupees}
          onChange={(n) => set("flatShippingFeeRupees", n)}
          disabled={v.shippingRateMode !== "flat"}
          hint={
            v.shippingRateMode === "flat"
              ? "Set it below what couriers really charge and you pay the difference on every parcel. Zero here would be free delivery on everything, so it is refused."
              : "Applies when \u201cCharge one flat amount\u201d is chosen above."
          }
        />

        <Money
          id="free-above"
          label="Free delivery at or above"
          value={v.freeAboveRupees}
          onChange={(n) => set("freeAboveRupees", n)}
          hint="Applies to Pay on Delivery as well as paying online. Set it too low and you pay the courier out of your own margin on small orders; set it too high and nobody reaches it, so it stops persuading anyone to add one more pair."
        />
      </Section>

      <Section title="Pay on Delivery">
        <Toggle
          id="cod-enabled"
          label="Offer Pay on Delivery"
          checked={v.codEnabled}
          onChange={(next) => set("codEnabled", next)}
          hint="Off hides it at checkout and refuses it if anything tries to place a cash order anyway. Even on, it is only offered where a courier will actually collect cash."
        />

        <Toggle
          id="waive-cod-fee"
          label="Waive the cash-handling fee when delivery is free"
          checked={v.waiveCodFeeAboveThreshold}
          onChange={(next) => set("waiveCodFeeAboveThreshold", next)}
          hint="The courier still charges you for handling cash, so this stays off by default and the fee shows as its own line. On, a large cash order costs the same as a card one — and there is no longer a reason to prepay."
        />

        <Toggle
          id="include-gst"
          label="Recover the 18% GST on delivery in the upfront amount"
          checked={v.includeGstInAdvance}
          onChange={(next) => set("includeGstInAdvance", next)}
          hint="Shiprocket bills you freight plus 18%. On, the customer covers it and the upfront figure is about a fifth higher. Off, you absorb it — which costs less than it looks if you reclaim input GST."
        />

        <div className="grid gap-5 sm:grid-cols-2">
          <Money
            id="cod-minimum"
            label="Smallest order that may pay on delivery"
            value={v.codMinimumOrderRupees}
            onChange={(n) => set("codMinimumOrderRupees", n)}
            hint="Below this, only paying online is offered. Too low and the upfront amount can be most of a cheap order, which reads as a scam; too high and you turn away cash customers you could have served."
          />
          <Money
            id="cod-cap"
            label="Most that may be taken upfront"
            value={v.codAdvanceMaximumRupees}
            onChange={(n) => set("codAdvanceMaximumRupees", n)}
            hint="A ceiling on the deposit, whatever the courier quotes. Too low and a heavy parcel to a far pin code is not fully covered if it comes back. Zero means no cap."
          />
        </div>

        <p className="text-muted-foreground border-border rounded-md border p-3 text-xs text-pretty">
          <strong className="font-medium">
            How much is taken upfront is not a setting.
          </strong>{" "}
          The customer pays the full round trip online — sending the parcel plus
          getting it back — and that comes off what the courier collects, so they
          pay the same either way. If a parcel is refused you are already
          covered. The two figures above put bounds on it.
        </p>

        {/*
          The deposit rule, always on screen and disabled until it applies.

          It is the thing that *blocks* saving a flat charge with Pay on Delivery
          on, so hiding it until flat mode is chosen means the owner meets the
          requirement as a refusal rather than as a field.
        */}
        <RadioChoice
          name="flat-deposit-mode"
          legend="Deposit taken on a Pay-on-Delivery order"
          value={v.flatCodDepositMode}
          onChange={(next) => set("flatCodDepositMode", next)}
          disabled={v.shippingRateMode !== "flat"}
          options={[
            { value: "unset", label: "Not chosen yet", note: "Pay on Delivery stays off." },
            {
              value: "multiplier",
              label: "A multiple of the flat delivery charge",
              note: "Two is the sensible start: one journey out, one back.",
            },
            { value: "fixed", label: "A fixed amount", note: "One number, whatever the charge." },
          ]}
          hint={
            v.shippingRateMode !== "flat"
              ? "Only needed with a flat delivery charge. A live courier quote already carries a round-trip figure to take upfront."
              : v.flatCodDepositMode === "unset"
                ? "Nothing is chosen, so this cannot be saved while Pay on Delivery is on: with no courier quote there is no round trip to charge, and a refused parcel would cost you both journeys."
                : "The customer pays this upfront and it comes off what the courier collects, so their total is unchanged."
          }
        />

        <div className="grid gap-5 sm:grid-cols-2">
          <Amount
            id="flat-deposit-multiplier"
            label="Times the flat delivery charge"
            value={v.flatCodDepositMultiplier}
            onChange={(n) => set("flatCodDepositMultiplier", n)}
            disabled={
              v.shippingRateMode !== "flat" || v.flatCodDepositMode !== "multiplier"
            }
          />
          <Money
            id="flat-deposit-fixed"
            label="Deposit taken upfront"
            value={v.flatCodDepositRupees}
            onChange={(n) => set("flatCodDepositRupees", n)}
            disabled={
              v.shippingRateMode !== "flat" || v.flatCodDepositMode !== "fixed"
            }
          />
        </div>
      </Section>

      <Section title="Discount for paying online">
        <p className="text-muted-foreground text-xs text-pretty">
          Orders paid online are refused far less often than cash ones, so some of
          that is worth passing back. It appears as its own line beside the
          payment choice, where a customer can see it and act on it.
        </p>

        <div className="grid gap-5 sm:grid-cols-2">
          <RadioChoice
            name="prepaid-discount-mode"
            legend="Kind of discount"
            value={v.prepaidDiscountMode}
            onChange={(next) => set("prepaidDiscountMode", next)}
            options={[
              { value: "flat", label: "A fixed amount off" },
              { value: "percent", label: "A percentage off" },
            ]}
          />
          {/*
            "Discount amount", not "Percentage off".

            The radio beside this one says "A percentage off", and with both on
            screen the two labels were a substring of each other — an owner had
            to work out which of two nearly identical phrases was the box to type
            in, and `audit:settings-controls` could not tell them apart either.
            The unit goes in brackets, where it answers "what do I type" rather
            than repeating the choice already made next to it.
          */}
          <Amount
            id="prepaid-discount-value"
            label="Discount amount"
            unit={v.prepaidDiscountMode === "percent" ? "%" : "₹"}
            value={v.prepaidDiscountValue}
            onChange={(n) => set("prepaidDiscountValue", n)}
            hint="Zero switches the discount off entirely. A part-rupee discount is rounded up to the next whole rupee, in the customer's favour."
          />
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          {/*
            The stacking ceiling. A coupon and the online-payment discount now
            combine, and this is the number that stops the pair running away —
            a 20% code on top of a 20% incentive is 40% off unless something
            says otherwise, and only the owner can say what.
          */}
          <Amount
            id="max-total-discount-percent"
            label="Most a coupon and this discount can take off together"
            unit="%"
            value={v.maxTotalDiscountPercent}
            onChange={(n) => set("maxTotalDiscountPercent", n)}
            hint="A coupon and the online-payment discount add up, and together they never exceed this share of the goods total — the coupon keeps its full value and the online-payment part shrinks to fit. Empty means they do not combine at all: a customer gets whichever single discount is larger, until you set a ceiling here."
          />
        </div>
      </Section>

      <Section title="Which courier carries it">
        <RadioChoice
          name="courier-selection-mode"
          legend="How the courier is chosen"
          value={v.courierSelectionMode}
          onChange={(next) =>
            set(
              "courierSelectionMode",
              next as "cheapest" | "shiprocket" | "best_rated",
            )
          }
          options={[
            {
              value: "shiprocket",
              label: "Let Shiprocket decide",
              note: "What the shop did before this setting existed. On both routes we measured, the courier Shiprocket recommended scored worst of the ones available on delivery, returns and tracking.",
            },
            {
              value: "cheapest",
              label: "Always the cheapest",
              note: "Lowest quoted rate, whatever its record.",
            },
            {
              value: "best_rated",
              label: "Best record, within a price limit",
              note: "The courier with the best delivery, returns and tracking scores — as long as it costs no more than the limit below.",
            },
          ]}
        />
        <div className="grid gap-5 sm:grid-cols-2">
          <Amount
            id="courier-price-tolerance"
            label="How much more a better courier may cost"
            unit="%"
            value={v.courierPriceTolerancePercent}
            onChange={(n) => set("courierPriceTolerancePercent", n)}
            hint="Only used by 'Best record, within a price limit'. 10 means the shop will pay up to 10% above the cheapest quote for a courier with a better record. Leave it empty and that option refuses to choose rather than guessing what you would spend — nothing is picked for you."
          />
        </div>
      </Section>

      <Section title="When a parcel comes back">
        <RadioChoice
          name="rto-policy"
          legend="What a customer who paid online gets back"
          value={v.rtoDeductionPolicy}
          onChange={(next) => set("rtoDeductionPolicy", next)}
          options={[
            {
              value: "actual_freight",
              label: "Everything except what the journey cost",
              note: "Fairest to the shop; different on every order.",
            },
            { value: "flat", label: "Everything except a fixed amount", note: "One predictable number." },
            { value: "none", label: "Everything, nothing deducted", note: "Generous, and it costs you both journeys." },
          ]}
          hint="None of this applies when the mistake was ours. A wrong shoe, a wrong size or damage before dispatch is refunded in full, always, and that is a reason you pick on the refund itself."
        />
        <Money
          id="rto-flat"
          label="Fixed amount kept back"
          value={v.rtoDeductionFlatRupees}
          onChange={(n) => set("rtoDeductionFlatRupees", n)}
          disabled={v.rtoDeductionPolicy !== "flat"}
          hint={
            v.rtoDeductionPolicy === "flat"
              ? "Set it below what a round trip really costs and you carry the difference on every return."
              : "Applies when \u201cEverything except a fixed amount\u201d is chosen above."
          }
        />
      </Section>

      <Section title="If Shiprocket cannot be reached">
        <Money
          id="prepaid-estimate"
          label="Estimated delivery charge for paying online"
          value={v.prepaidEstimateRupees}
          onChange={(n) => set("prepaidEstimateRupees", n)}
          hint="Used only during an outage, so the shop keeps selling. The customer is told the figure is an estimate rather than a quoted rate — set it close to what couriers really charge."
        />
        <RadioChoice
          name="fallback-behaviour"
          legend="Pay on Delivery during an outage"
          value={v.fallbackBehaviour}
          onChange={(next) => set("fallbackBehaviour", next)}
          options={[
            { value: "refuse_cod", label: "Do not offer it", note: "Recommended." },
            { value: "allow_all", label: "Offer it, secured by the deposit" },
          ]}
          hint={
            v.fallbackBehaviour === "refuse_cod"
              ? "With no quote there is no round-trip figure, so a cash order would go out with nothing collected against a refusal. Paying online is still offered, at the estimate above."
              : "Cash orders keep going out during an outage, secured by the Pay-on-Delivery deposit above. That deposit must be set or this cannot be saved."
          }
        />
      </Section>

      <Section title="Shiprocket wallet warning">
        <Money
          id="wallet-low"
          label="Warn when the wallet falls below"
          value={v.walletLowBalanceRupees}
          onChange={(n) => set("walletLowBalanceRupees", n)}
          unsetMeans="the dashboard shows no wallet warning"
          hint="An empty wallet stops every shipment, not just the next one. A sensible floor is a few times what one parcel costs to send and bring back."
        />
      </Section>

      <Button type="submit" disabled={saving} className="min-h-11">
        {saving ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
        Save delivery settings
      </Button>
    </form>
  );
}

/**
 * A group of controls under a plain heading.
 *
 * The panel used to be one flat list of eight `<fieldset>`s, each with a legend
 * competing with the controls for weight. A heading and a gap does the same job
 * with less ink, and lets the controls be the darkest thing in their group.
 */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-5">
      <h3 className="font-mono text-xs tracking-[0.08em] uppercase">{title}</h3>
      {children}
    </section>
  );
}

export type ParcelFormValues = {
  weightGrams: number;
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
  pickupPostcode: string;
};

/**
 * The one box every product ships in.
 *
 * **Nothing here has a default and that is the feature.** A 900g weight used to
 * live in the code and be reached silently whenever a field was missing, so a
 * half-filled row quoted parcels nobody had decided on. There is nothing to fall
 * through to now: an empty field stops quoting, withdraws Pay on Delivery, and
 * says which field it was — here, on the storefront's delivery check, in the
 * logs, and in `npm run audit:parcel`.
 *
 * Weight is in **grams** and the sides in **centimetres**, because that is what
 * a courier's website asks for and what a kitchen scale reads.
 */
export function ParcelDefaultsForm({
  initial,
  missing,
}: {
  initial: ParcelFormValues;
  missing: readonly string[];
}) {
  const { saving, save } = useSaver();
  const [v, setV] = React.useState(initial);

  const set = <K extends keyof ParcelFormValues>(
    key: K,
    value: ParcelFormValues[K],
  ) => setV((prev) => ({ ...prev, [key]: value }));

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save(() => saveParcelDefaults(v), "The shop's parcel is set.");
      }}
      className="space-y-5"
    >
      {missing.length > 0 ? (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 rounded-md border p-3 text-sm text-pretty"
        >
          <p>
            <strong>
              Delivery is not being quoted, and Pay on Delivery is switched off
              shop-wide.
            </strong>
          </p>
          <p className="mt-2">
            Shiprocket cannot price a parcel it does not have the measurements
            for, so nothing below is being guessed. Fill in{" "}
            {missing.map(readableField).join(", ")} and both start working again
            on the next quote.
          </p>
          <p className="mt-2">
            Orders paid online still go through in the meantime, at the estimated
            delivery charge, and the customer is told it is an estimate.
          </p>
        </div>
      ) : null}

      {/* Demoted from a bordered box to a caption, and shortened: the panel
          header already says "One box for the whole catalogue", so this said it
          twice — once in a border, once in a heading, above the four fields that
          are the actual point. */}
      <p className="text-muted-foreground text-sm text-pretty">
        Individual products can override this from their own page if they
        genuinely do not fit — boots, mostly. Everything else, including anything
        added later, uses these.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Amount
          id="parcel-weight"
          label="Packed weight"
          unit="grams"
          hint="The shoe in its box, as it leaves the shop. Under-state it and the courier reweighs and bills you the difference."
          value={v.weightGrams}
          onChange={(n) => set("weightGrams", n)}
        />
        <Amount
          id="parcel-length"
          label="Box length"
          unit="cm"
          value={v.lengthCm}
          onChange={(n) => set("lengthCm", n)}
        />
        <Amount
          id="parcel-breadth"
          label="Box breadth"
          unit="cm"
          value={v.breadthCm}
          onChange={(n) => set("breadthCm", n)}
        />
        <Amount
          id="parcel-height"
          label="Box height"
          unit="cm"
          hint="Measured with the lid on. Couriers charge on size as well as weight, so a guess here quietly misprices every parcel."
          value={v.heightCm}
          onChange={(n) => set("heightCm", n)}
        />
      </div>

      <Text
        id="pickup-pin"
        label="Pickup PIN code"
        inputMode="numeric"
        maxLength={6}
        value={v.pickupPostcode}
        onChange={(next) => set("pickupPostcode", next)}
        hint="Where parcels are collected from. Every delivery estimate is measured from here, so a wrong PIN produces believable estimates for the wrong city."
      />

      <Button type="submit" disabled={saving} className="min-h-11">
        {saving ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
        Save the shop&rsquo;s parcel
      </Button>
    </form>
  );
}

/**
 * The settings-row field names, turned into something a shopkeeper can act on.
 *
 * The stored names are what the logs and the audit print, and they are the right
 * thing there. They are the wrong thing in a sentence telling somebody what to
 * type into the box directly above.
 */
function readableField(field: string): string {
  const words: Record<string, string> = {
    default_parcel_weight_grams: "the packed weight",
    default_parcel_length_cm: "the box length",
    default_parcel_breadth_cm: "the box breadth",
    default_parcel_height_cm: "the box height",
    pickup_postcode: "the pickup PIN code",
  };
  return words[field] ?? field;
}



export type StoreFormValues = {
  storeName: string;
  storeTagline: string;
  email: string;
  phone: string;
  whatsapp: string;
  address: string;
  instagram: string;
  facebook: string;
};

export function StoreSettingsForm({ initial }: { initial: StoreFormValues }) {
  const { saving, save } = useSaver();
  const [v, setV] = React.useState(initial);
  const set = (key: keyof StoreFormValues, value: string) =>
    setV((prev) => ({ ...prev, [key]: value }));

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save(() => saveStoreSettings(v), "Shop details saved.");
      }}
      className="space-y-6"
    >
      <Text id="store-name" label="Shop name" value={v.storeName} onChange={(next) => set("storeName", next)} />
      <Text id="store-tagline" label="Tagline" value={v.storeTagline} onChange={(next) => set("storeTagline", next)} />

      <section className="space-y-5">
        <h3 className="font-mono text-xs tracking-[0.08em] uppercase">
          How customers reach you
        </h3>
        <p className="text-muted-foreground text-xs text-pretty">
          Not decoration. A replacement can only be claimed by contacting the
          shop, so a wrong number here means a customer with a damaged parcel
          cannot reach anyone.
        </p>
        <Text id="contact-phone" label="Phone" value={v.phone} onChange={(next) => set("phone", next)} />
        <Text id="contact-whatsapp" label="WhatsApp" value={v.whatsapp} onChange={(next) => set("whatsapp", next)} />
        <Text id="contact-email" label="Email" value={v.email} onChange={(next) => set("email", next)} />
        <Text id="contact-address" label="Shop address" value={v.address} onChange={(next) => set("address", next)} />
      </section>

      <section className="space-y-5">
        <h3 className="font-mono text-xs tracking-[0.08em] uppercase">Social</h3>
        <Text id="social-instagram" label="Instagram" value={v.instagram} onChange={(next) => set("instagram", next)} />
        <Text id="social-facebook" label="Facebook" value={v.facebook} onChange={(next) => set("facebook", next)} />
      </section>

      <Button type="submit" disabled={saving} className="min-h-11">
        {saving ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
        Save shop details
      </Button>
    </form>
  );
}



/* --------------------------------------------------- the announcement ---- */

export type AnnouncementFormValues = {
  isActive: boolean;
  text: string;
  href: string;
  /** Wall-clock IST, the format datetime-local edits. Empty means unset. */
  startsAt: string;
  endsAt: string;
};

export function AnnouncementForm({
  initial,
}: {
  initial: AnnouncementFormValues;
}) {
  const { saving, save } = useSaver();
  const [v, setV] = React.useState(initial);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save(() => saveAnnouncement(v), "Announcement saved.");
      }}
      className="space-y-5"
    >
      <Toggle
        id="announcement-active"
        label="Shown to customers"
        checked={v.isActive}
        onChange={(next) => setV((prev) => ({ ...prev, isActive: next }))}
        hint="The master switch. The dates below only narrow when an active announcement appears."
      />
      <Text
        id="announcement-text"
        label="What it says"
        value={v.text}
        onChange={(next) => setV((prev) => ({ ...prev, text: next }))}
        maxLength={140}
        hint={
          <>
            Never type a price or threshold —{" "}
            <code>{"{{free_shipping_threshold}}"}</code> and{" "}
            <code>{"{{return_window}}"}</code> always show the current values
            from these settings.
          </>
        }
      />
      <Text
        id="announcement-href"
        label="Where it links"
        value={v.href}
        onChange={(next) => setV((prev) => ({ ...prev, href: next }))}
        hint="A page on this site, like /page/returns. Empty means the strip is just words."
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          htmlFor="announcement-starts"
          label="When it starts"
          hint="Indian Standard Time. Empty means immediately."
        >
          <Input
            id="announcement-starts"
            type="datetime-local"
            value={v.startsAt}
            aria-describedby="announcement-starts-hint"
            onChange={(event) =>
              setV((prev) => ({ ...prev, startsAt: event.target.value }))
            }
          />
        </Field>
        <Field
          htmlFor="announcement-ends"
          label="When it ends"
          hint="Indian Standard Time. Empty means until you switch it off."
        >
          <Input
            id="announcement-ends"
            type="datetime-local"
            value={v.endsAt}
            aria-describedby="announcement-ends-hint"
            onChange={(event) =>
              setV((prev) => ({ ...prev, endsAt: event.target.value }))
            }
          />
        </Field>
      </div>
      <Button type="submit" disabled={saving} className="min-h-11">
        {saving ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
        Save the announcement
      </Button>
    </form>
  );
}
