import type { Metadata } from "next";
import Link from "next/link";

import {
  ShippingSettingsForm,
  StoreSettingsForm,
} from "@/components/admin/settings/settings-forms";
import { AdminPage, PageHeader, Panel } from "@/components/admin/ui";
import {
  getAdminSettings,
  paiseToRupees,
  settingObject,
  settingString,
} from "@/lib/queries/admin/settings";

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
  const settings = await getAdminSettings();

  const shipping = settingObject(settings, "shipping");
  const contact = settingObject(settings, "contact");
  const social = settingObject(settings, "social");
  const fallback = (shipping.fallback_fee_paise ?? {}) as Record<
    string,
    unknown
  >;

  const mode = shipping.cod_advance_mode;

  return (
    <AdminPage>
      <PageHeader
        title="Settings"
        description="What the shop decides. Delivery rates are not among them — those come from the courier."
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel
          title="Delivery and Pay on Delivery"
          description="Thresholds, not rates."
        >
          <ShippingSettingsForm
            initial={{
              freeAboveRupees: paiseToRupees(shipping.free_above_paise, 2499),
              codEnabled: shipping.cod_enabled !== false,
              codAdvanceMode:
                mode === "fixed" || mode === "shipping_fee"
                  ? mode
                  : "greater_of",
              codAdvanceMinimumRupees: paiseToRupees(
                shipping.cod_advance_minimum_paise,
                99,
              ),
              codAdvanceFixedRupees: paiseToRupees(
                shipping.cod_advance_fixed_paise,
                99,
              ),
              fallbackPrepaidRupees: paiseToRupees(fallback.razorpay, 199),
              fallbackCodRupees: paiseToRupees(fallback.cod, 349),
            }}
          />
        </Panel>

        <div className="space-y-6">
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
