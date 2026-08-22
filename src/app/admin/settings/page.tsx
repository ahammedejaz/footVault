import type { Metadata } from "next";
import Link from "next/link";

import {
  AnnouncementForm,
  ParcelDefaultsForm,
  PhotographSettingsForm,
  ShippingSettingsForm,
  StoreSettingsForm,
} from "@/components/admin/settings/settings-forms";
import { BrandingForm } from "@/components/admin/settings/branding-form";
import { AdminPage, PageHeader, Panel } from "@/components/admin/ui";
import {
  getAdminSettings,
  paiseToRupees,
  settingObject,
  settingString,
} from "@/lib/queries/admin/settings";
import { SUGGESTED_TARGET_FILL_PERCENT } from "@/lib/images/target-fill";
import { istWallClock } from "@/lib/announcement";
import { parcelDefaultsStatus } from "@/lib/shipping/quote";
import { slotFor, type SiteImageValue } from "@/lib/images/site-image";
import { getSiteImages } from "@/lib/queries/admin/site-images";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

/**
 * The numbers and words the shop owns.
 *
 * The brief's rule, and the owner's: **rates come from the courier, thresholds
 * come from here.** Nothing on this page sets what a customer is charged to
 * receive a parcel — Shiprocket answers that for their pin code, every time.
 * What the owner decides is when delivery becomes free, how much of a
 * Pay-on-Delivery order is taken upfront, and what to fall back on when the
 * courier's API is unreachable.
 *
 * Policy wording is not editable here. The policy pages are CMS rows and a
 * half-built editor for them would be worse than a link, so this page says
 * where they live and sends the owner there.
 */
export default async function AdminSettingsPage() {
  const [settings, parcel, brandingImages] = await Promise.all([
    getAdminSettings(),
    parcelDefaultsStatus(),
    getSiteImages([
      slotFor.branding("logo"),
      slotFor.branding("favicon"),
      slotFor.branding("share_image"),
    ]),
  ]);

  const shipping = settingObject(settings, "shipping");
  const parcelRow = settingObject(settings, "shipping_defaults");
  const contact = settingObject(settings, "contact");
  const announcement = settingObject(settings, "announcement");
  const social = settingObject(settings, "social");
  const images = settingObject(settings, "images");
  const branding = settingObject(settings, "branding");
  const prepaidDiscount = (shipping.prepaid_discount ?? {}) as {
    mode?: string;
    value?: unknown;
  };

  return (
    <AdminPage>
      <PageHeader
        title="Settings"
        description="What the shop decides: how delivery is charged, the rules for cash on delivery, what a returned parcel costs, and how customers reach you."
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/*
          "Delivery and Pay on Delivery · Thresholds, not rates" — a title that
          told the owner what the panel does *not* contain, above a line that
          told them again. The panel holds both a delivery charge and the
          Pay-on-Delivery switch, so it now says so.
        */}
        <Panel
          title="Delivery and Pay on Delivery"
          description="How delivery is charged, and the rules for cash at the door."
        >
          <ShippingSettingsForm
            initial={{
              /*
                Every fallback here is 0, and none of them used to be: this page
                carried ₹2,499, ₹999 and ₹500 as the values to show when a field
                was missing. ₹2,499 was the free-delivery threshold two phases
                ago and the row had long since moved on, so a row that lost the
                field would have shown the owner a stale number, invited them to
                press Save, and written it back as though they had chosen it.
                Zero renders as an empty box and cannot be mistaken for a
                setting.
              */
              freeAboveRupees: paiseToRupees(shipping.free_above_paise, 0),
              codEnabled: shipping.cod_enabled !== false,
              codMinimumOrderRupees: paiseToRupees(
                shipping.cod_minimum_order_value_paise,
                0,
              ),
              codAdvanceMaximumRupees: paiseToRupees(
                shipping.cod_advance_maximum_paise,
                0,
              ),
              includeGstInAdvance: shipping.include_gst_in_advance === true,
              prepaidDiscountMode:
                prepaidDiscount.mode === "percent" ? "percent" : "flat",
              // A percentage is stored as a percentage and a flat amount as
              // paise, so only one of them is divided by a hundred. Dividing
              // both would render 5% as 0.05%.
              prepaidDiscountValue:
                prepaidDiscount.mode === "percent"
                  ? Number(prepaidDiscount.value ?? 0)
                  : paiseToRupees(prepaidDiscount.value, 0),
              // A percentage as typed, and zero when unset — which the form
              // renders as an empty box, and the save action writes back as
              // null. Nothing here may invent a ceiling.
              courierSelectionMode:
                shipping.courier_selection_mode === "cheapest" ||
                shipping.courier_selection_mode === "best_rated"
                  ? shipping.courier_selection_mode
                  : "shiprocket",
              courierPriceTolerancePercent:
                typeof shipping.courier_price_tolerance_percent === "number"
                  ? shipping.courier_price_tolerance_percent
                  : 0,
              maxTotalDiscountPercent:
                typeof shipping.max_total_discount_percent === "number"
                  ? shipping.max_total_discount_percent
                  : 0,
              shippingRateMode:
                shipping.shipping_rate_mode === "flat" ? "flat" : "live",
              flatShippingFeeRupees: paiseToRupees(
                shipping.flat_shipping_fee_paise,
                0,
              ),
              /*
                `unset` is a real value here, not a missing one. It is what the
                form refuses to save flat mode with, and collapsing it to a
                default would be this page quietly choosing what the shop
                collects against a returned parcel.
              */
              flatCodDepositMode:
                shipping.flat_cod_deposit_mode === "multiplier" ||
                shipping.flat_cod_deposit_mode === "fixed"
                  ? shipping.flat_cod_deposit_mode
                  : "unset",
              // A ratio, not money — it is not divided by a hundred.
              flatCodDepositMultiplier: Number(
                shipping.flat_cod_deposit_multiplier ?? 0,
              ),
              flatCodDepositRupees: paiseToRupees(
                shipping.flat_cod_deposit_paise,
                0,
              ),
              waiveCodFeeAboveThreshold:
                shipping.waive_cod_fee_above_threshold === true,
              fallbackBehaviour:
                shipping.fallback_behaviour === "allow_all"
                  ? "allow_all"
                  : "refuse_cod",
              rtoDeductionPolicy:
                shipping.rto_deduction_policy === "flat" ||
                shipping.rto_deduction_policy === "none"
                  ? shipping.rto_deduction_policy
                  : "actual_freight",
              rtoDeductionFlatRupees: paiseToRupees(
                shipping.rto_deduction_flat_paise,
                0,
              ),
              prepaidEstimateRupees: paiseToRupees(
                shipping.prepaid_estimate_fee_paise,
                0,
              ),
              walletLowBalanceRupees: paiseToRupees(
                shipping.wallet_low_balance_paise,
                0,
              ),
            }}
          />
        </Panel>

        <div className="space-y-6">
          <Panel
            title="The shop's parcel"
            description="One box for the whole catalogue."
          >
            <ParcelDefaultsForm
              missing={parcel.ok ? [] : parcel.missing}
              /*
                Read from the settings row rather than from `parcel.defaults`,
                because an incomplete row has no `defaults` to read — and the
                fields that *are* filled must still show what they hold. Zero
                stands for "not set" and the form renders it as an empty box.
              */
              initial={{
                weightGrams: Number(parcelRow.default_parcel_weight_grams ?? 0),
                lengthCm: Number(parcelRow.default_parcel_length_cm ?? 0),
                breadthCm: Number(parcelRow.default_parcel_breadth_cm ?? 0),
                heightCm: Number(parcelRow.default_parcel_height_cm ?? 0),
                pickupPostcode: String(parcelRow.pickup_postcode ?? ""),
              }}
            />
          </Panel>

          <Panel title="The shop">
            <StoreSettingsForm
              initial={{
                storeName: settingString(settings, "store_name"),
                storeTagline: settingString(settings, "store_tagline"),
                email: String(contact.email ?? ""),
                phone: String(contact.phone ?? ""),
                whatsapp: String(contact.whatsapp ?? ""),
                address: String(contact.address ?? ""),
                instagram: String(social.instagram ?? ""),
                facebook: String(social.facebook ?? ""),
              }}
            />
          </Panel>

          {/*
            Under "The shop" rather than beside it, because the name and the
            logo are the same question asked twice and an owner changing one
            usually wants to look at the other.
          */}
          <Panel
            title="Logo and artwork"
            description="The mark in the header, the icon on the browser tab, and the picture people see when they share a link. Leave any of them empty to keep the artwork the shop came with."
          >
            <BrandingForm
              initial={{
                description: String(branding.description ?? ""),
                logoUrl: stringOrNull(branding.logo_url),
                faviconUrl: stringOrNull(branding.favicon_url),
                shareImageUrl: stringOrNull(branding.share_image_url),
              }}
              images={
                Object.fromEntries(brandingImages.entries()) as Record<
                  string,
                  SiteImageValue
                >
              }
            />
          </Panel>

          <Panel
            title="The announcement bar"
            description="The strip across the top of every page. It can be scheduled; a customer who closes it does not see the same words again."
          >
            <AnnouncementForm
              initial={{
                isActive: announcement.is_active !== false,
                text: String(announcement.text ?? ""),
                href: String(announcement.href ?? ""),
                startsAt: istWallClock(
                  typeof announcement.starts_at === "string"
                    ? announcement.starts_at
                    : null,
                ),
                endsAt: istWallClock(
                  typeof announcement.ends_at === "string"
                    ? announcement.ends_at
                    : null,
                ),
              }}
            />
          </Panel>

          <Panel
            title="Photographs"
            description="What the crop tool aims at when you frame a picture."
          >
            <PhotographSettingsForm
              initial={{
                targetFillPercent:
                  typeof images.target_fill_percent === "number"
                    ? images.target_fill_percent
                    : SUGGESTED_TARGET_FILL_PERCENT,
              }}
            />
          </Panel>

          <Panel
            title="Policies"
            description="Written as pages, not as settings."
          >
            <p className="text-sm text-pretty">
              The returns, shipping, terms and privacy wording lives in the
              site&rsquo;s pages. There is no editor for them yet — ask a
              developer to change the wording, and read the current text here:
            </p>
            <ul className="mt-3 space-y-1 text-sm">
              {[
                ["returns", "Returns and damage"],
                ["shipping", "Shipping"],
                ["terms", "Terms of sale"],
                ["privacy", "Privacy policy"],
              ].map(([slug, label]) => (
                <li key={slug}>
                  <Link
                    href={`/page/${slug}`}
                    className="hit-44 inline-flex underline underline-offset-2"
                    target="_blank"
                  >
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </AdminPage>
  );
}

/** A jsonb field that should be a URL or absent, and may be neither. */
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
