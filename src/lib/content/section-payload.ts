import { z } from "@/lib/validations/z";

/**
 * One schema per homepage section type, shared by the editor form and the
 * publish action.
 *
 * The form and the action import the *same* object, which is the point of this
 * file existing: two independently-written validations of "what a hero payload
 * is" agree today and drift the first time one of them learns a field. The
 * courier settings took that lesson in Batch B — the Zod schema and the form
 * component each knew the tolerance's bounds, and only the gate's coverage
 * assertion noticed when one moved.
 *
 * ## What these guard, and what they deliberately do not
 *
 * They guard the **write**. A payload that reaches `homepage_sections` through
 * `/admin/appearance` is well-formed, so the renderer's defensive reads are a
 * floor rather than the interface.
 *
 * They do not guard the **render**. `home-sections.tsx` keeps its
 * `payloadString` reads because rows predating these schemas — or edited by
 * hand in SQL — must render or vanish, never 500. Tightening the renderer to
 * trust these schemas would turn every legacy row into a crash.
 *
 * ## Href fields
 *
 * Site-relative paths or https. The same rule `logoField` applies in the brands
 * action, for the same reason: `javascript:` typed into an admin field must die
 * at validation, not become a link the storefront renders. A protocol-relative
 * `//host` URL is rejected by requiring the one leading slash to be alone.
 */

const TEXT_MAX = 200;
const BODY_MAX = 5_000;

const shortText = (label: string) =>
  z
    .string()
    .trim()
    .max(TEXT_MAX, `${label} is over ${TEXT_MAX} characters.`);

/** Empty string from a cleared input becomes an absent field, not "". */
const optionalText = (label: string) =>
  shortText(label)
    .optional()
    .transform((value) => (value ? value : undefined));

const href = (label: string) =>
  shortText(label)
    .refine(
      (value) =>
        value === "" ||
        (value.startsWith("/") && !value.startsWith("//")) ||
        value.startsWith("https://"),
      `${label} must start with / (a page on this site) or https://`,
    )
    .optional()
    .transform((value) => (value ? value : undefined));

const slug = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Not a valid web address segment.");

export const heroPayloadSchema = z.object({
  eyebrow: optionalText("The small line above the headline"),
  cta_label: optionalText("The button label"),
  cta_href: href("The button destination"),
  secondary_cta_label: optionalText("The second button label"),
  secondary_cta_href: href("The second button destination"),
  /**
   * The hero's own imagery, payload-first with the `banners` row as fallback.
   *
   * Before Phase 10 the hero's *copy* came from this payload while its *images*
   * came from a separate `banners` row — editing "the hero" meant two rows in
   * two tables, and the editor could not honestly claim to own the section.
   * These fields make the payload the owner; the banner remains the fallback so
   * every existing homepage keeps rendering untouched.
   */
  desktop_image_url: href("The desktop image"),
  mobile_image_url: href("The mobile image"),
  /**
   * Motion, and the still it plays over.
   *
   * `video_url` is what makes the hero a video hero: absent, nothing below
   * changes and the section renders exactly the still it rendered before, which
   * is what keeps every existing homepage byte-identical through this change.
   *
   * `poster_url` is the frame the customer sees first and, for a customer who
   * has asked their device for less motion, the frame they see instead. It is a
   * separate field rather than reusing the images above because the two answer
   * different questions: the images are the art-directed pair for a still hero,
   * the poster has one job, which is to be indistinguishable from the video's
   * first frame. When it is absent the images stand in — a visible change at
   * the moment playback starts is worse than a blank box, but only just.
   */
  video_url: href("The hero video"),
  poster_url: href("The video's still frame"),
  /**
   * Which of the two the customer actually gets.
   *
   * Absent means `video`, and that is load-bearing rather than tidy: every
   * hero written before this field existed has no `media_mode`, and each one
   * must keep playing its clip exactly as it did. A default of `poster` would
   * silently stop every existing video hero the moment this shipped.
   *
   * `poster` does not hide the video with CSS — `home-sections.tsx` stops
   * passing a `src` at all, so no `<video>` is constructed and no byte of the
   * file is requested. That is the same path a customer gets under
   * `prefers-reduced-motion` or `Save-Data`, which has been proved by
   * `audit:hero-media` since it existed; this puts the switch in the owner's
   * hands rather than the visitor's, and reuses the proof.
   */
  media_mode: z.enum(["video", "poster"]).optional(),
});

/** What an absent `media_mode` means. Named so the renderer and the editor
 *  cannot disagree about it. */
export const DEFAULT_HERO_MEDIA_MODE = "video" as const;

export const categoryGridPayloadSchema = z.object({
  category_slugs: z
    .array(slug)
    .min(1, "Pick at least one category.")
    .max(6, "Six tiles is the most the grid draws."),
});

export const productRailPayloadSchema = z.object({
  collection_slug: slug,
  cta_href: href("The see-all destination"),
});

export const promoStripPayloadSchema = z.object({
  items: z
    .array(
      z.object({
        label: shortText("A promise").min(1, "A promise needs words."),
        detail: optionalText("The line under it"),
      }),
    )
    .min(1, "The strip needs at least one promise.")
    .max(6, "Six promises is the most the strip draws."),
});

export const bannerPayloadSchema = z.object({
  cta_label: optionalText("The button label"),
  cta_href: href("The button destination"),
});

export const richTextPayloadSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "The section needs words, or delete it.")
    .max(BODY_MAX, `Keep it under ${BODY_MAX} characters.`),
});

/**
 * The types the editor offers, with what the owner needs to know about each.
 *
 * `testimonials` is absent on purpose: it has no renderer, so offering it would
 * let the owner build a section that draws nothing. The moment a renderer
 * exists, it joins this list and thereby the editor, the publish validation and
 * the gate — they all iterate this object.
 */
export const EDITABLE_SECTIONS = {
  hero: {
    label: "Hero",
    hint: "The big opening: headline, buttons, imagery.",
    schema: heroPayloadSchema,
  },
  category_grid: {
    label: "Category tiles",
    hint: "Departments, as picture tiles.",
    schema: categoryGridPayloadSchema,
  },
  product_rail: {
    label: "Product rail",
    hint: "A scrolling shelf from one collection.",
    schema: productRailPayloadSchema,
  },
  promo_strip: {
    label: "Promises strip",
    hint: "Short guarantees: delivery, returns, stock.",
    schema: promoStripPayloadSchema,
  },
  banner: {
    label: "Banner",
    hint: "A full-width card with one message and a button.",
    schema: bannerPayloadSchema,
  },
  rich_text: {
    label: "Text block",
    hint: "Owner-written prose. **bold**, - bullets, {{tokens}}.",
    schema: richTextPayloadSchema,
  },
} as const;

export type EditableSectionType = keyof typeof EDITABLE_SECTIONS;

export function isEditableType(value: string): value is EditableSectionType {
  return value in EDITABLE_SECTIONS;
}

/** Validate a payload against its type's schema. */
export function parseSectionPayload(
  type: EditableSectionType,
  payload: unknown,
):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; message: string } {
  const result = EDITABLE_SECTIONS[type].schema.safeParse(payload);
  if (!result.success) {
    const first = result.error.issues[0];
    return {
      ok: false,
      message: first ? first.message : "That section is not valid.",
    };
  }
  return { ok: true, payload: result.data as Record<string, unknown> };
}
