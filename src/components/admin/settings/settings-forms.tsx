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
  codAdvanceMode: "shipping_fee" | "fixed" | "greater_of";
  codAdvanceMinimumRupees: number;
  codAdvanceFixedRupees: number;
  fallbackPrepaidRupees: number;
  fallbackCodRupees: number;
};

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
        hint="Paying online only. Pay-on-Delivery orders always carry a delivery charge, because a refused parcel costs the shop both journeys."
        value={v.freeAboveRupees}
        onChange={(n) => set("freeAboveRupees", n)}
      />

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

        <label
          htmlFor="advance-mode"
          className="mt-4 block text-xs font-medium"
        >
          How much is taken upfront
        </label>
        <select
          id="advance-mode"
          value={v.codAdvanceMode}
          onChange={(event) =>
            set(
              "codAdvanceMode",
              event.target.value as ShippingFormValues["codAdvanceMode"],
            )
          }
          className="border-input bg-background mt-1 min-h-11 w-full rounded-md border px-3 text-sm"
        >
          <option value="greater_of">
            Whichever is larger — the delivery charge or the minimum
          </option>
          <option value="shipping_fee">The delivery charge</option>
          <option value="fixed">A fixed amount</option>
        </select>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Money
            id="advance-min"
            label="Minimum upfront"
            hint="Never less than this, even when delivery is free. Without it, a free-delivery order takes nothing upfront and is unsecured again."
            value={v.codAdvanceMinimumRupees}
            onChange={(n) => set("codAdvanceMinimumRupees", n)}
          />
          <Money
            id="advance-fixed"
            label="Fixed upfront"
            hint={
              v.codAdvanceMode === "fixed"
                ? "In use, because the rule above is set to a fixed amount."
                : "Only used if the rule above is set to a fixed amount."
            }
            value={v.codAdvanceFixedRupees}
            onChange={(n) => set("codAdvanceFixedRupees", n)}
          />
        </div>
      </fieldset>

      <fieldset className="border-border rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">
          If Shiprocket cannot be reached
        </legend>
        <p className="text-muted-foreground text-sm text-pretty">
          Used only during an outage, so the shop keeps selling rather than
          turning customers away. Not a price list — set them close to what the
          courier really charges.
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
