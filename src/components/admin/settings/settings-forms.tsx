"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  saveParcelDefaults,
  saveShippingSettings,
  saveStoreSettings,
} from "@/lib/actions/admin/settings";
import { toast } from "@/lib/toast";

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
      className="space-y-5"
    >
      <p className="border-border rounded-md border p-3 text-sm text-pretty">
        <strong>Delivery rates are not set here.</strong> What a customer pays to
        receive a parcel comes from Shiprocket, for their pin code, every time.
        These are the shop&rsquo;s own thresholds.
      </p>

      <Money
        id="free-above"
        label="Free delivery at or above"
        hint="Applies to Pay on Delivery as well as paying online. Set it too low and you pay the courier out of your own margin on small orders; set it too high and nobody ever reaches it, so it stops persuading anyone to add one more pair."
        value={v.freeAboveRupees}
        onChange={(n) => set("freeAboveRupees", n)}
      />

      <fieldset className="border-border rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">Delivery charge</legend>
        <p className="text-muted-foreground text-sm text-pretty">
          What the customer pays. The shop&rsquo;s own cost always comes from the
          live quote whichever of these you pick, so the books stay honest.
        </p>

        <Choice
          id="delivery-mode"
          label="How the delivery charge is decided"
          value={v.shippingRateMode}
          onChange={(next) =>
            set("shippingRateMode", next as ShippingFormValues["shippingRateMode"])
          }
          options={[
            {
              value: "live",
              label: "Pass the courier's rate through (recommended)",
            },
            { value: "flat", label: "Charge one flat amount everywhere" },
          ]}
          hint={
            v.shippingRateMode === "live"
              ? "Every customer pays exactly what it costs to reach them, so you never lose money on a far pin code. Some customers see a higher figure than others."
              : "One number for everybody, which is simpler to explain. Shiprocket is not called at all, so the shop keeps selling through a courier outage — but it also cannot tell you whether a pin code is serviceable, and you absorb the difference on remote addresses."
          }
        />

        {v.shippingRateMode === "flat" ? (
          <div className="mt-4 space-y-4">
            <Money
              id="delivery-flat"
              label="Flat delivery charge"
              hint="Set it below what couriers really charge and you pay the difference on every parcel. Zero here would be free delivery on everything."
              value={v.flatShippingFeeRupees}
              onChange={(n) => set("flatShippingFeeRupees", n)}
            />

            {/*
              The deposit is not optional in flat mode and the form says so
              before it refuses to save. With no courier quote there is no round
              trip to charge, so without this a refused parcel costs the shop
              both journeys and nothing was collected against it.
            */}
            <div className="border-border bg-fog/40 rounded-md border p-3">
              <p className="text-sm text-pretty">
                <strong>
                  A flat charge needs a Pay-on-Delivery deposit to go with it.
                </strong>{" "}
                There is no courier quote in this mode, so there is no round-trip
                figure to take upfront. Pick one, or Pay on Delivery cannot be
                offered while the flat charge is on.
              </p>

              <Choice
                id="flat-deposit-mode"
                label="Deposit taken on a Pay-on-Delivery order"
                value={v.flatCodDepositMode}
                onChange={(next) =>
                  set(
                    "flatCodDepositMode",
                    next as ShippingFormValues["flatCodDepositMode"],
                  )
                }
                options={[
                  { value: "unset", label: "Not chosen yet" },
                  {
                    value: "multiplier",
                    label: "A multiple of the flat delivery charge",
                  },
                  { value: "fixed", label: "A fixed amount" },
                ]}
                hint={
                  v.flatCodDepositMode === "multiplier"
                    ? "Two is the sensible starting point: one journey out, one journey back. It moves with the flat charge, so raising one raises the other."
                    : v.flatCodDepositMode === "fixed"
                      ? "One number regardless of the flat charge. Simple, and it needs revisiting whenever courier rates move."
                      : "Nothing is chosen, so Pay on Delivery stays off while the flat charge is on. Saving in this state is refused rather than allowed quietly."
                }
              />

              {v.flatCodDepositMode === "multiplier" ? (
                <div className="mt-4">
                  <label
                    htmlFor="flat-deposit-multiplier"
                    className="block text-xs font-medium"
                  >
                    Times the flat delivery charge
                  </label>
                  <input
                    id="flat-deposit-multiplier"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={0.1}
                    value={v.flatCodDepositMultiplier}
                    onChange={(event) =>
                      set(
                        "flatCodDepositMultiplier",
                        Number(event.target.value),
                      )
                    }
                    className="border-input bg-background mt-1 min-h-11 w-full rounded-md border px-3 text-sm tabular-nums"
                  />
                  <p className="text-muted-foreground mt-1 text-sm text-pretty">
                    The customer pays this upfront and it comes off what the
                    courier collects, so their total is unchanged.
                  </p>
                </div>
              ) : null}

              {v.flatCodDepositMode === "fixed" ? (
                <div className="mt-4">
                  <Money
                    id="flat-deposit-fixed"
                    label="Deposit taken upfront"
                    hint="Set it below what a round trip really costs and a refused parcel leaves you short by the difference."
                    value={v.flatCodDepositRupees}
                    onChange={(n) => set("flatCodDepositRupees", n)}
                  />
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </fieldset>

      <fieldset className="border-border rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">Pay on Delivery</legend>

        <label className="mt-1 flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={v.codEnabled}
            onChange={(event) => set("codEnabled", event.target.checked)}
            className="size-4"
          />
          Offer Pay on Delivery
        </label>
        <p className="text-muted-foreground mt-1 text-sm text-pretty">
          Turning this off hides it at checkout <em>and</em> refuses it if
          anything tries to place a cash order anyway. Even when it is on, it is
          only offered where a courier will actually collect cash.
        </p>

        <label className="mt-4 flex min-h-11 items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={v.waiveCodFeeAboveThreshold}
            onChange={(event) =>
              set("waiveCodFeeAboveThreshold", event.target.checked)
            }
            className="mt-1 size-4"
          />
          <span>
            Waive the cash-handling fee when delivery is free
            <span className="text-muted-foreground block text-sm text-pretty">
              Free delivery applies to Pay on Delivery as well as paying online.
              The courier still charges you for handling the cash, so this stays
              off by default and the fee shows as its own line. Turning it on
              makes a large cash order cost the same as a card one — and removes
              the reason to prepay.
            </span>
          </span>
        </label>

        <p className="border-border bg-fog/40 mt-4 rounded-md border p-3 text-sm text-pretty">
          <strong>How much is taken upfront is no longer a setting.</strong> The
          customer pays the full round trip online — the cost of sending the
          parcel plus the cost of getting it back — and that amount is taken off
          what the courier collects, so they pay the same either way. If the
          parcel is refused you are already covered. The two numbers below put
          bounds on it.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Money
            id="cod-minimum"
            label="Smallest order that may pay on delivery"
            hint="Below this, only paying online is offered. Set it too low and the upfront amount can be most of a cheap order, which reads as a scam and gets abandoned. Set it too high and you turn away cash customers you could have served."
            value={v.codMinimumOrderRupees}
            onChange={(n) => set("codMinimumOrderRupees", n)}
          />
          <Money
            id="cod-cap"
            label="Most that may be taken upfront"
            hint="A ceiling on the deposit, whatever the courier quotes. Set it too low and a heavy parcel to a far pin code is not fully covered if it comes back — you carry the difference. Zero means no cap."
            value={v.codAdvanceMaximumRupees}
            onChange={(n) => set("codAdvanceMaximumRupees", n)}
          />
        </div>

        <label className="mt-4 flex min-h-11 items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={v.includeGstInAdvance}
            onChange={(event) =>
              set("includeGstInAdvance", event.target.checked)
            }
            className="mt-1 size-4"
          />
          <span>
            Recover the 18% GST on delivery in the upfront amount
            <span className="text-muted-foreground block text-sm text-pretty">
              Shiprocket bills you freight plus 18%. On, the customer covers it
              and the upfront figure is about a fifth higher. Off, you absorb it
              — which costs less than it looks if you reclaim input GST.
            </span>
          </span>
        </label>
      </fieldset>

      <fieldset className="border-border rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">
          Discount for paying online
        </legend>
        <p className="text-muted-foreground text-sm text-pretty">
          Orders paid online are refused far less often than cash ones, and that
          is worth money to you — so some of it can go back. It appears as its
          own line beside the payment choice, where a customer can see it and act
          on it. Set it too high and you give away more than the refusals cost
          you; leave it at zero and nothing is shown.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Choice
            id="prepaid-discount-mode"
            label="Kind of discount"
            value={v.prepaidDiscountMode}
            onChange={(next) =>
              set(
                "prepaidDiscountMode",
                next as ShippingFormValues["prepaidDiscountMode"],
              )
            }
            options={[
              { value: "flat", label: "A fixed amount off" },
              { value: "percent", label: "A percentage off" },
            ]}
          />
          <div>
            <label
              htmlFor="prepaid-discount-value"
              className="block text-xs font-medium"
            >
              {v.prepaidDiscountMode === "percent"
                ? "Percentage off"
                : "Amount off"}
            </label>
            <input
              id="prepaid-discount-value"
              type="number"
              inputMode="decimal"
              min={0}
              step={v.prepaidDiscountMode === "percent" ? 0.5 : 1}
              value={v.prepaidDiscountValue}
              onChange={(event) =>
                set("prepaidDiscountValue", Number(event.target.value))
              }
              className="border-input bg-background mt-1 min-h-11 w-full rounded-md border px-3 text-sm tabular-nums"
            />
            <p className="text-muted-foreground mt-1 text-sm text-pretty">
              Zero switches the discount off entirely.
            </p>
          </div>
        </div>
      </fieldset>

      <fieldset className="border-border rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">
          When a parcel comes back
        </legend>
        <Choice
          id="rto-policy"
          label="What a customer who paid online gets back"
          value={v.rtoDeductionPolicy}
          onChange={(next) =>
            set(
              "rtoDeductionPolicy",
              next as ShippingFormValues["rtoDeductionPolicy"],
            )
          }
          options={[
            {
              value: "actual_freight",
              label: "Everything except what the journey actually cost",
            },
            { value: "flat", label: "Everything except a fixed amount" },
            { value: "none", label: "Everything, with nothing deducted" },
          ]}
          hint={
            v.rtoDeductionPolicy === "actual_freight"
              ? "You are left where you started and the customer pays for the journey they did not accept. Fairest to the shop, and the figure is different on every order."
              : v.rtoDeductionPolicy === "none"
                ? "Generous, and it costs you both journeys every time. Reasonable if refusals are rare; expensive if they are not."
                : "One predictable number, easy to explain. Set it below what a round trip really costs and you carry the difference on every return."
          }
        />
        {v.rtoDeductionPolicy === "flat" ? (
          <div className="mt-4">
            <Money
              id="rto-flat"
              label="Fixed amount kept back"
              value={v.rtoDeductionFlatRupees}
              onChange={(n) => set("rtoDeductionFlatRupees", n)}
            />
          </div>
        ) : null}
        <p className="text-muted-foreground mt-3 text-sm text-pretty">
          None of this applies when the mistake was ours. A wrong shoe, a wrong
          size or damage before dispatch is refunded in full, always, and that is
          a reason you pick on the refund itself.
        </p>
      </fieldset>

      <fieldset className="border-border rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">
          If Shiprocket cannot be reached
        </legend>
        <p className="text-muted-foreground text-sm text-pretty">
          Used only during an outage, so the shop keeps selling rather than
          turning customers away. The customer is told the figure is an estimate
          rather than a quoted rate — set it close to what couriers really
          charge, because every order placed during an outage is priced from it.
        </p>

        <div className="mt-3">
          <Money
            id="prepaid-estimate"
            label="Estimated delivery charge for paying online"
            value={v.prepaidEstimateRupees}
            onChange={(n) => set("prepaidEstimateRupees", n)}
          />
        </div>

        <Choice
          id="fallback-behaviour"
          label="Pay on Delivery during an outage"
          value={v.fallbackBehaviour}
          onChange={(next) =>
            set(
              "fallbackBehaviour",
              next as ShippingFormValues["fallbackBehaviour"],
            )
          }
          options={[
            {
              value: "refuse_cod",
              label: "Do not offer it (recommended)",
            },
            { value: "allow_all", label: "Offer it, secured by the deposit" },
          ]}
          hint={
            v.fallbackBehaviour === "refuse_cod"
              ? "With no quote there is no round-trip figure, so a cash order would go out with nothing collected against a refusal. Paying online is still offered, at the estimate above."
              : "Cash orders keep going out during an outage, secured by the Pay-on-Delivery deposit set with the flat charge. That deposit must be set or this cannot be saved."
          }
        />
      </fieldset>

      <fieldset className="border-border rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">
          Shiprocket wallet warning
        </legend>
        <p className="text-muted-foreground text-sm text-pretty">
          An empty Shiprocket wallet stops every shipment — not just the next
          one. The dashboard warns you below this figure so you find out at the
          desk rather than at the counter with a parcel in your hand.
        </p>
        <div className="mt-3">
          <Money
            id="wallet-low"
            label="Warn when the wallet falls below"
            hint="A sensible floor is a few times what one parcel costs to send and bring back. Zero switches the warning off, and the dashboard says so rather than staying silent."
            value={v.walletLowBalanceRupees}
            onChange={(n) => set("walletLowBalanceRupees", n)}
          />
        </div>
      </fieldset>

      <Button type="submit" disabled={saving} className="min-h-11">
        {saving ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
        Save delivery settings
      </Button>
    </form>
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

      <p className="border-border rounded-md border p-3 text-sm text-pretty">
        One box for the whole catalogue. Individual products can override this
        from their own page if they genuinely do not fit — boots, mostly —
        and everything else, including anything added later, uses these.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Measure
          id="parcel-weight"
          label="Packed weight"
          unit="grams"
          step={10}
          hint="The shoe in its box, as it leaves the shop. Under-state it and the courier reweighs and bills you the difference."
          value={v.weightGrams}
          onChange={(n) => set("weightGrams", n)}
        />
        <Measure
          id="parcel-length"
          label="Box length"
          unit="cm"
          step={0.5}
          value={v.lengthCm}
          onChange={(n) => set("lengthCm", n)}
        />
        <Measure
          id="parcel-breadth"
          label="Box breadth"
          unit="cm"
          step={0.5}
          value={v.breadthCm}
          onChange={(n) => set("breadthCm", n)}
        />
        <Measure
          id="parcel-height"
          label="Box height"
          unit="cm"
          step={0.5}
          hint="Measured with the lid on. Couriers charge on size as well as weight, so a guess here quietly misprices every parcel."
          value={v.heightCm}
          onChange={(n) => set("heightCm", n)}
        />
      </div>

      <div>
        <label htmlFor="pickup-pin" className="block text-xs font-medium">
          Pickup PIN code
        </label>
        <Input
          id="pickup-pin"
          inputMode="numeric"
          maxLength={6}
          value={v.pickupPostcode}
          onChange={(event) => set("pickupPostcode", event.target.value)}
          className="mt-1 min-h-11 tabular-nums"
        />
        <p className="text-muted-foreground mt-1 text-sm text-pretty">
          Where parcels are collected from. Every delivery estimate is measured
          from here, so a wrong PIN produces believable estimates for the wrong
          city.
        </p>
      </div>

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

/**
 * A measurement, blank when it is unset.
 *
 * Zero is not shown as `0` because a zero in a box reads as a decision somebody
 * made. An empty box reads as a question, which is what it is.
 */
function Measure({
  id,
  label,
  unit,
  step,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  unit: string;
  step: number;
  hint?: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium">
        {label} <span className="text-muted-foreground">({unit})</span>
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        step={step}
        value={value > 0 ? value : ""}
        placeholder="not set"
        onChange={(event) => onChange(Number(event.target.value))}
        className="border-input bg-background mt-1 min-h-11 w-full rounded-md border px-3 text-sm tabular-nums"
      />
      {hint ? (
        <p className="text-muted-foreground mt-1 text-sm text-pretty">{hint}</p>
      ) : null}
    </div>
  );
}

/** A labelled select with a consequence line under it. */
function Choice({
  id,
  label,
  value,
  onChange,
  options,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  hint?: string;
}) {
  return (
    <div className="mt-4">
      <label htmlFor={id} className="block text-xs font-medium">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="border-input bg-background mt-1 min-h-11 w-full rounded-md border px-3 text-sm"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? (
        <p className="text-muted-foreground mt-1 text-sm text-pretty">{hint}</p>
      ) : null}
    </div>
  );
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
      className="space-y-4"
    >
      <Text id="store-name" label="Shop name" value={v.storeName} onChange={(s) => set("storeName", s)} />
      <Text id="store-tagline" label="Tagline" value={v.storeTagline} onChange={(s) => set("storeTagline", s)} />

      <fieldset className="border-border rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">How customers reach you</legend>
        <p className="text-muted-foreground text-sm text-pretty">
          These are not decoration. A replacement can only be claimed by
          contacting the shop, so a wrong number here means a customer with a
          damaged parcel cannot reach anyone.
        </p>
        <div className="mt-3 space-y-4">
          <Text id="contact-phone" label="Phone" value={v.phone} onChange={(s) => set("phone", s)} />
          <Text id="contact-whatsapp" label="WhatsApp" value={v.whatsapp} onChange={(s) => set("whatsapp", s)} />
          <Text id="contact-email" label="Email" value={v.email} onChange={(s) => set("email", s)} />
          <Text id="contact-address" label="Shop address" value={v.address} onChange={(s) => set("address", s)} />
        </div>
      </fieldset>

      <fieldset className="border-border rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">Social</legend>
        <div className="mt-1 space-y-4">
          <Text id="social-instagram" label="Instagram" value={v.instagram} onChange={(s) => set("instagram", s)} />
          <Text id="social-facebook" label="Facebook" value={v.facebook} onChange={(s) => set("facebook", s)} />
        </div>
      </fieldset>

      <Button type="submit" disabled={saving} className="min-h-11">
        {saving ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
        Save shop details
      </Button>
    </form>
  );
}

function Money({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium">
        {label}
      </label>
      <div className="mt-1 flex items-center gap-2">
        <span aria-hidden className="text-muted-foreground font-mono text-sm">
          ₹
        </span>
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={0}
          step={1}
          value={Number.isFinite(value) ? value : 0}
          onChange={(event) => onChange(event.target.valueAsNumber)}
          className="max-w-40"
        />
      </div>
      {hint ? (
        <p className="text-muted-foreground mt-1 text-sm text-pretty">{hint}</p>
      ) : null}
    </div>
  );
}

function Text({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium">
        {label}
      </label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1"
      />
    </div>
  );
}
