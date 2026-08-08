"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
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
  customerDeliveryFeeMode: "live" | "flat";
  customerDeliveryFlatRupees: number;
  rtoDeductionPolicy: "actual_freight" | "flat" | "none";
  rtoDeductionFlatRupees: number;
  fallbackPrepaidRupees: number;
  fallbackCodRupees: number;
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
        hint="Paying online only. Set it too low and you pay the courier out of your own margin on small orders; set it too high and nobody ever reaches it, so it stops persuading anyone to add one more pair."
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
          value={v.customerDeliveryFeeMode}
          onChange={(next) =>
            set(
              "customerDeliveryFeeMode",
              next as ShippingFormValues["customerDeliveryFeeMode"],
            )
          }
          options={[
            {
              value: "live",
              label: "Pass the courier's rate through (recommended)",
            },
            { value: "flat", label: "Charge one flat amount everywhere" },
          ]}
          hint={
            v.customerDeliveryFeeMode === "live"
              ? "Every customer pays exactly what it costs to reach them, so you never lose money on a far pin code. Some customers see a higher figure than others."
              : "One number for everybody, which is simpler to explain. You absorb the difference — which means you make less on remote addresses and more on nearby ones."
          }
        />

        {v.customerDeliveryFeeMode === "flat" ? (
          <div className="mt-4">
            <Money
              id="delivery-flat"
              label="Flat delivery charge"
              hint="Set it below what couriers really charge and you pay the difference on every parcel. Zero here would be free delivery on everything."
              value={v.customerDeliveryFlatRupees}
              onChange={(n) => set("customerDeliveryFlatRupees", n)}
            />
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
          Turning this off hides it everywhere. Even when it is on, it is only
          offered where a courier will actually collect cash.
        </p>

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
          turning customers away. Not a price list — set them close to what the
          courier really charges, because every order placed during an outage is
          priced from these.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Money
            id="fallback-prepaid"
            label="Paying online"
            value={v.fallbackPrepaidRupees}
            onChange={(n) => set("fallbackPrepaidRupees", n)}
          />
          <Money
            id="fallback-cod"
            label="Pay on Delivery"
            value={v.fallbackCodRupees}
            onChange={(n) => set("fallbackCodRupees", n)}
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
