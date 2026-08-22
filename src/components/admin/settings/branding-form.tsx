"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import { SiteImageField } from "@/components/admin/site-images/site-image-field";
import { Button } from "@/components/ui/button";
import { saveBranding } from "@/lib/actions/admin/settings";
import { slotFor, type SiteImageValue } from "@/lib/images/site-image";
import { toast } from "@/lib/toast";

/**
 * The shop's own artwork: the mark in the header, the icon on the tab, and the
 * picture that shows when somebody pastes a link into WhatsApp.
 *
 * ## All three were code before this
 *
 * The logo was a **compiled import** — `import lockup from
 * "../../../public/brand/logo.png"` — so changing it was a git commit, a build
 * and a deploy. The favicon was `src/app/icon.png`, a file route, same story.
 * The share card came from a generated `opengraph-image` and could not be
 * overridden at all. Three pieces of a shop's identity that only a developer
 * could touch, in a shop whose owner has just stopped having one.
 *
 * ## Empty is a real answer, and it is the default
 *
 * Leaving any of these unset keeps exactly what the site serves today: the
 * committed lockup, `src/app/icon.png`, and the generated card. That is why
 * Remove is safe here — it does not leave a hole, it returns the shop to the
 * artwork in the repository. The hint under each field says so, because
 * "Remove" next to a logo otherwise reads as "have no logo".
 *
 * ## Why the name is not on this form
 *
 * It is two panels up, in Shop details, where it has been since Phase 7 —
 * `store_name` and `store_tagline`. Repeating it here would create a second
 * place to change it, and the two would disagree the first time somebody used
 * the other one.
 */

export type BrandingFormValues = {
  description: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  shareImageUrl: string | null;
};

const DESCRIPTION_MAX = 300;

export function BrandingForm({
  initial,
  images,
}: {
  initial: BrandingFormValues;
  /** Stored originals and framing, keyed by slot, so Adjust works on load. */
  images: Record<string, SiteImageValue>;
}) {
  const [v, setV] = React.useState(initial);
  const [saving, setSaving] = React.useState(false);

  const set = <K extends keyof BrandingFormValues>(
    key: K,
    value: BrandingFormValues[K],
  ) => setV((prev) => ({ ...prev, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    const result = await saveBranding(v);
    setSaving(false);
    if (!result.ok) {
      toast.failed(result.message);
      return;
    }
    toast.done(
      "Artwork saved.",
      "The header, the browser tab and shared links use it from now on.",
    );
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <div>
        <label
          htmlFor="branding-description"
          className="mb-1 block text-sm font-medium"
        >
          What the shop is, in one sentence
        </label>
        <textarea
          id="branding-description"
          value={v.description}
          onChange={(event) => set("description", event.target.value)}
          rows={3}
          maxLength={DESCRIPTION_MAX}
          disabled={saving}
          className="border-input placeholder:text-muted-foreground disabled:bg-muted w-full rounded-lg border bg-transparent px-3 py-2 text-base transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        />
        <p className="text-muted-foreground mt-1 text-sm text-pretty">
          Printed under the shop&rsquo;s name in Google results and under shared
          links. Google cuts it at about 160 characters, so the first sentence
          is the one that counts. {v.description.length} of {DESCRIPTION_MAX}{" "}
          used.
        </p>
      </div>

      <SiteImageField
        slot={slotFor.branding("logo")}
        frame="logo"
        initial={images[slotFor.branding("logo")] ?? null}
        disabled={saving}
        hint="Shown in the header, in the menu drawer and in the footer. A PNG with a transparent background works best. Remove it to go back to the logo that came with the shop."
        showAlt={false}
        onChange={(url) => set("logoUrl", url)}
      />

      <SiteImageField
        slot={slotFor.branding("favicon")}
        frame="favicon"
        initial={images[slotFor.branding("favicon")] ?? null}
        disabled={saving}
        hint="The small square on the browser tab. Square artwork with nothing important near the edges — some browsers round the corners. Remove it to go back to the icon that came with the shop."
        showAlt={false}
        onChange={(url) => set("faviconUrl", url)}
      />

      <SiteImageField
        slot={slotFor.branding("share_image")}
        frame="share_image"
        initial={images[slotFor.branding("share_image")] ?? null}
        disabled={saving}
        hint="What shows when a link to the shop is pasted into WhatsApp or Instagram. Leave it empty and the shop draws one for each page automatically, which stays right when products change."
        showAlt={false}
        onChange={(url) => set("shareImageUrl", url)}
      />

      <Button type="submit" disabled={saving} className="min-h-11">
        {saving ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
        Save artwork
      </Button>
    </form>
  );
}
