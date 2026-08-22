"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from "lucide-react";

import { HeroVideoUploader } from "@/components/admin/appearance/hero-video-uploader";
import { SiteImageField } from "@/components/admin/site-images/site-image-field";
import { Field, RadioChoice, Text } from "@/components/admin/settings/controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  publishHomepage,
  previewHomepage,
  type PublishedSection,
} from "@/lib/actions/admin/appearance";
import {
  DEFAULT_HERO_MEDIA_MODE,
  EDITABLE_SECTIONS,
  isEditableType,
  parseSectionPayload,
  type EditableSectionType,
} from "@/lib/content/section-payload";
import { slotFor, type SiteImageValue } from "@/lib/images/site-image";
import { IMAGE_FRAMES, type FrameKey } from "@/lib/images/site-frames";
import type {
  AdminSectionRow,
  PickerOption,
} from "@/lib/queries/admin/appearance";
import { toast } from "@/lib/toast";

/**
 * The homepage, as a list the owner rearranges.
 *
 * ## Nothing here writes until Publish
 *
 * Every control edits a working copy in this component's state. Publish sends
 * the whole layout to `publishHomepage` in one submission; Preview sends the
 * same layout to the real renderer and shows what comes back. Closing the tab
 * discards everything, which is what makes Delete safe to be one click: the
 * destructive step is Publish, and Publish says out loud what it will remove.
 *
 * ## Reorder is buttons first, drag second
 *
 * The arrows are the mechanism of record: WCAG 2.2 SC 2.5.7 requires a
 * single-pointer alternative to dragging, this panel runs axe at 2.2 AA on
 * every page, and a keyboard user gets real reordering rather than a
 * simulation. The drag handle is sugar over the same move, native HTML5 so the
 * panel takes no dependency for a list of seven rows.
 */

type EditorSection = {
  /** Stable client identity: the DB id, or `new-N` for rows added here. */
  key: string;
  id: string | null;
  sectionType: string;
  title: string;
  subtitle: string;
  isActive: boolean;
  payload: Record<string, unknown>;
};

function fromRow(row: AdminSectionRow): EditorSection {
  return {
    key: row.id,
    id: row.id,
    sectionType: row.sectionType,
    title: row.title ?? "",
    subtitle: row.subtitle ?? "",
    isActive: row.isActive,
    payload: row.payload,
  };
}

function fromPublished(row: PublishedSection): EditorSection {
  return {
    key: row.id,
    id: row.id,
    sectionType: row.sectionType,
    title: row.title ?? "",
    subtitle: row.subtitle ?? "",
    isActive: row.isActive,
    payload: row.payload,
  };
}

/** What the server actions receive. */
function toInput(sections: EditorSection[]) {
  return sections.map((section) => ({
    id: section.id,
    sectionType: section.sectionType,
    title: section.title.trim() ? section.title.trim() : null,
    subtitle: section.subtitle.trim() ? section.subtitle.trim() : null,
    isActive: section.isActive,
    payload: section.payload,
  }));
}

/** The name a row is announced by. */
function nameOf(section: EditorSection): string {
  if (section.title.trim()) return section.title.trim();
  return isEditableType(section.sectionType)
    ? EDITABLE_SECTIONS[section.sectionType].label
    : section.sectionType;
}

const FRESH_PAYLOAD: Record<EditableSectionType, Record<string, unknown>> = {
  hero: {},
  category_grid: { category_slugs: [] },
  product_rail: { collection_slug: "" },
  promo_strip: { items: [{ label: "" }] },
  banner: {},
  rich_text: { body: "" },
};

export function AppearanceEditor({
  initial,
  categories,
  collections,
  siteImages,
  heroFallback,
}: {
  initial: AdminSectionRow[];
  categories: PickerOption[];
  collections: PickerOption[];
  /**
   * The stored original and framing for every picture in this layout, keyed by
   * slot. Loaded once by the page rather than per field: a lazy fetch inside
   * each field would make Adjust appear a beat after the section opens, which
   * reads as the panel being broken rather than slow.
   */
  siteImages: Record<string, SiteImageValue>;
  /**
   * The hero still that the `banners` row supplies when the payload has none.
   *
   * Shown greyed under the hero's image fields rather than hidden. The hero has
   * rendered a picture from that row since long before this editor existed, and
   * an owner looking at a homepage with art on it, next to an image field that
   * says "nothing here yet", concludes the panel is lying — which it would be.
   */
  heroFallback: { desktop: string | null; mobile: string | null };
}) {
  const router = useRouter();
  const [sections, setSections] = React.useState<EditorSection[]>(() =>
    initial.map(fromRow),
  );
  /** What the table held at last publish, for dirty- and removal-tracking. */
  const [published, setPublished] = React.useState<EditorSection[]>(() =>
    initial.map(fromRow),
  );
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<"publish" | "preview" | null>(
    null,
  );
  const [preview, setPreview] = React.useState<{
    view: React.ReactNode;
    forLayout: string;
  } | null>(null);
  const newCount = React.useRef(0);
  const dragFrom = React.useRef<number | null>(null);

  const layoutFingerprint = JSON.stringify(toInput(sections));
  const dirty = layoutFingerprint !== JSON.stringify(toInput(published));
  const removed = published.filter(
    (was) => !sections.some((section) => section.id === was.id),
  );
  const previewStale = preview !== null && preview.forLayout !== layoutFingerprint;

  function patch(key: string, changes: Partial<EditorSection>) {
    setSections((current) =>
      current.map((section) =>
        section.key === key ? { ...section, ...changes } : section,
      ),
    );
  }

  function patchPayload(key: string, field: string, value: unknown) {
    setSections((current) =>
      current.map((section) =>
        section.key === key
          ? { ...section, payload: { ...section.payload, [field]: value } }
          : section,
      ),
    );
  }

  function move(index: number, to: number) {
    setSections((current) => {
      if (to < 0 || to >= current.length) return current;
      const next = [...current];
      const [row] = next.splice(index, 1);
      next.splice(to, 0, row);
      return next;
    });
  }

  function add(type: EditableSectionType) {
    newCount.current += 1;
    const key = `new-${newCount.current}`;
    setSections((current) => [
      ...current,
      {
        key,
        id: null,
        sectionType: type,
        title: "",
        subtitle: "",
        isActive: true,
        payload: structuredClone(FRESH_PAYLOAD[type]),
      },
    ]);
    setExpanded(key);
  }

  /**
   * The same validation the server runs, run first on the client — not as the
   * guard (the action re-checks everything) but so the failure lands next to
   * the field that caused it, with the section opened, instead of as a distant
   * sentence after a round trip.
   */
  function firstInvalid(): string | null {
    for (const section of sections) {
      if (!isEditableType(section.sectionType)) continue;
      const result = parseSectionPayload(section.sectionType, section.payload);
      if (!result.ok) {
        setExpanded(section.key);
        return `${nameOf(section)}: ${result.message}`;
      }
    }
    return null;
  }

  async function runPublish() {
    if (pending) return;
    const complaint = firstInvalid();
    if (complaint) {
      toast.failed(complaint);
      return;
    }
    setPending("publish");
    try {
      const result = await publishHomepage(toInput(sections));
      if (!result.ok) {
        toast.failed(result.message ?? "The homepage did not publish.");
        return;
      }
      const fresh = result.sections.map(fromPublished);
      setSections(fresh);
      setPublished(fresh);
      setPreview(null);
      toast.done(
        "Homepage published",
        result.removed > 0
          ? `${fresh.length} sections live, ${result.removed} removed.`
          : `${fresh.length} sections live.`,
      );
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  async function runPreview() {
    if (pending) return;
    const complaint = firstInvalid();
    if (complaint) {
      toast.failed(complaint);
      return;
    }
    setPending("preview");
    try {
      const result = await previewHomepage(toInput(sections));
      if (!result.ok) {
        toast.failed(result.message ?? "The preview did not render.");
        return;
      }
      setPreview({ view: result.view, forLayout: layoutFingerprint });
    } catch {
      /*
        A rejection here is the action's *response* failing to serialize —
        adminAction's own catch never sees it, because the body already
        returned ok. Without this, a broken preview is a button that does
        nothing, which is how the client-manifest gap stayed invisible in dev.
      */
      toast.failed(
        "The preview could not render. The layout is untouched — publishing is unaffected.",
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <div>
      <ol className="space-y-3" aria-label="Homepage sections, in order">
        {sections.map((section, index) => (
          <li
            key={section.key}
            className="border-border bg-background rounded-lg border"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (dragFrom.current !== null) move(dragFrom.current, index);
              dragFrom.current = null;
            }}
          >
            <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
              <span
                draggable
                onDragStart={() => {
                  dragFrom.current = index;
                }}
                className="text-muted-foreground cursor-grab touch-none"
                aria-hidden
              >
                <GripVertical className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {nameOf(section)}
                </p>
                <p className="text-muted-foreground font-mono text-xs tracking-[0.06em] uppercase">
                  {isEditableType(section.sectionType)
                    ? EDITABLE_SECTIONS[section.sectionType].label
                    : `${section.sectionType} — no editor for this type`}
                  {section.isActive ? "" : " · hidden"}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${nameOf(section)} up`}
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  <ArrowUp className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${nameOf(section)} down`}
                  disabled={index === sections.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  <ArrowDown className="size-4" />
                </Button>
                {/*
                  Short visible text, full name in the accessible one: two
                  buttons reading "Hide Every size we hold, shown on every
                  shoe" side by side overflowed a 768px tablet — caught by
                  audit:admin-pages. A screen reader still hears which section
                  the button acts on; a sighted owner reads the name an inch
                  to the left.
                */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={
                    section.isActive
                      ? `Hide ${nameOf(section)}`
                      : `Show ${nameOf(section)}`
                  }
                  onClick={() =>
                    patch(section.key, { isActive: !section.isActive })
                  }
                >
                  {section.isActive ? "Hide" : "Show"}
                </Button>
                {isEditableType(section.sectionType) ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-expanded={expanded === section.key}
                    aria-label={
                      expanded === section.key
                        ? `Close ${nameOf(section)}`
                        : `Edit ${nameOf(section)}`
                    }
                    onClick={() =>
                      setExpanded(
                        expanded === section.key ? null : section.key,
                      )
                    }
                  >
                    {expanded === section.key ? "Close" : "Edit"}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${nameOf(section)}`}
                  onClick={() => {
                    setSections((current) =>
                      current.filter((row) => row.key !== section.key),
                    );
                    if (expanded === section.key) setExpanded(null);
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>

            {expanded === section.key && isEditableType(section.sectionType) ? (
              <div className="border-border grid gap-5 border-t px-3 py-4 sm:grid-cols-2">
                <Text
                  id={`sec-${section.key}-title`}
                  label="Title"
                  value={section.title}
                  onChange={(value) => patch(section.key, { title: value })}
                  hint={
                    section.sectionType === "promo_strip"
                      ? "Names the section here; the strip itself draws only the promises below."
                      : undefined
                  }
                />
                <Text
                  id={`sec-${section.key}-subtitle`}
                  label="Subtitle"
                  value={section.subtitle}
                  onChange={(value) => patch(section.key, { subtitle: value })}
                />
                <PayloadFields
                  section={section}
                  categories={categories}
                  collections={collections}
                  siteImages={siteImages}
                  heroFallback={heroFallback}
                  onField={(field, value) =>
                    patchPayload(section.key, field, value)
                  }
                />
              </div>
            ) : null}
          </li>
        ))}
      </ol>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <AddSection onAdd={add} />
      </div>

      <div className="border-border mt-6 border-t pt-4">
        {removed.length > 0 ? (
          <p className="text-destructive mb-3 text-sm">
            Publishing will permanently remove:{" "}
            {removed.map(nameOf).join(", ")}.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            onClick={runPublish}
            disabled={pending !== null}
          >
            {pending === "publish" ? "Publishing…" : "Publish"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={runPreview}
            disabled={pending !== null}
          >
            {pending === "preview" ? "Rendering…" : "Preview"}
          </Button>
          <p className="text-muted-foreground text-sm" aria-live="polite">
            {dirty
              ? "Unpublished changes — the shop still shows the last published layout."
              : "The shop shows this layout."}
          </p>
        </div>
      </div>

      {preview !== null ? (
        <section className="mt-6" aria-label="Preview of the homepage">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-display text-lg font-bold tracking-[-0.02em] uppercase">
              Preview
            </h2>
            <p className="text-muted-foreground text-xs">
              {previewStale
                ? "The layout changed after this was rendered — preview again."
                : "Rendered by the storefront itself. Not yet published."}
            </p>
          </div>
          {/* `inert` for the same reason as the "Live now" render on the
              page: a preview's controls are pictures of controls. */}
          <div inert className="border-border overflow-hidden rounded-lg border">
            {preview.view}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ add menu ---- */

function AddSection({ onAdd }: { onAdd: (type: EditableSectionType) => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <Button
        type="button"
        variant="outline"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Plus className="size-4" aria-hidden /> Add a section
      </Button>
      {open ? (
        <ul className="mt-2 grid gap-2 sm:grid-cols-2" aria-label="Section types">
          {(
            Object.entries(EDITABLE_SECTIONS) as [
              EditableSectionType,
              (typeof EDITABLE_SECTIONS)[EditableSectionType],
            ][]
          ).map(([type, meta]) => (
            <li key={type}>
              <button
                type="button"
                className="border-border hover:border-foreground w-full rounded-lg border px-3 py-2.5 text-left transition-colors"
                onClick={() => {
                  onAdd(type);
                  setOpen(false);
                }}
              >
                <span className="block text-sm font-medium">{meta.label}</span>
                <span className="text-muted-foreground block text-xs">
                  {meta.hint}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------- per-type forms ---- */

/**
 * One picture belonging to one homepage section.
 *
 * ## Why a section that has never been published cannot have a picture yet
 *
 * A picture is filed under a slot named after the row it belongs to, and a
 * section the owner has just added has no row — the editor gives it a client-
 * side key like `new-2`, which becomes a real id only at Publish. Filing the
 * picture under `new-2` would work exactly once: the picture would render
 * (the URL is in the payload and the payload is saved), and Adjust would
 * silently stop finding it the moment the section was published under its real
 * id. A control that works until you save is worse than one that is not there.
 *
 * So the field appears once the section exists, and until then this says so.
 * The same rule, for the same reason, as the category form.
 *
 * ## It spans both columns
 *
 * The surrounding grid is two columns of text inputs. A 16:9 preview with three
 * sliders under it in a half-width column is a hero the owner has to judge at
 * 180 pixels wide, and it drags badly at that size on a phone.
 */
function SectionImage({
  section,
  part,
  frame,
  field,
  siteImages,
  fallbackUrl,
  onField,
}: {
  section: EditorSection;
  part: "desktop" | "mobile" | "poster" | "background";
  frame: FrameKey;
  /** The payload key the rendered URL is written into. */
  field: string;
  siteImages: Record<string, SiteImageValue>;
  fallbackUrl?: string | null;
  onField: (field: string, value: unknown) => void;
}) {
  if (!section.id) {
    return (
      <p className="text-muted-foreground text-sm sm:col-span-2">
        {IMAGE_FRAMES[frame].label}: publish this section first, and its picture
        can be chosen straight after.
      </p>
    );
  }

  const slot = slotFor.section(section.id, part);
  return (
    <div className="sm:col-span-2">
      <SiteImageField
        slot={slot}
        frame={frame}
        initial={siteImages[slot] ?? null}
        fallbackUrl={fallbackUrl}
        fallbackNote="This is the picture the shop is showing now, from the old banner record. Choose one here and it takes over."
        showAlt={false}
        onChange={(url) => onField(field, url ?? "")}
      />
    </div>
  );
}

function stringAt(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  return typeof value === "string" ? value : "";
}

function PayloadFields({
  section,
  categories,
  collections,
  siteImages,
  heroFallback,
  onField,
}: {
  section: EditorSection;
  siteImages: Record<string, SiteImageValue>;
  heroFallback: { desktop: string | null; mobile: string | null };
  categories: PickerOption[];
  collections: PickerOption[];
  onField: (field: string, value: unknown) => void;
}) {
  const key = section.key;
  const p = section.payload;

  switch (section.sectionType as EditableSectionType) {
    case "hero":
      return (
        <>
          <Text
            id={`sec-${key}-eyebrow`}
            label="Small line above the headline"
            value={stringAt(p, "eyebrow")}
            onChange={(value) => onField("eyebrow", value)}
          />
          <Text
            id={`sec-${key}-cta-label`}
            label="Button label"
            value={stringAt(p, "cta_label")}
            onChange={(value) => onField("cta_label", value)}
          />
          <Text
            id={`sec-${key}-cta-href`}
            label="Button destination"
            value={stringAt(p, "cta_href")}
            onChange={(value) => onField("cta_href", value)}
            hint="A page on this site, like /shop — or a full https:// address."
          />
          <Text
            id={`sec-${key}-cta2-label`}
            label="Second button label"
            value={stringAt(p, "secondary_cta_label")}
            onChange={(value) => onField("secondary_cta_label", value)}
          />
          <Text
            id={`sec-${key}-cta2-href`}
            label="Second button destination"
            value={stringAt(p, "secondary_cta_href")}
            onChange={(value) => onField("secondary_cta_href", value)}
          />
          {/*
            Three pictures, and each of them used to be a text box you pasted a
            URL into. That is why the shop shipped with drawn placeholder art in
            the hero: the field worked, and nobody could use it, because using
            it meant knowing what a Supabase public storage URL looks like.

            Two art-directed uploads rather than one and a crop, because the
            phone and the laptop want differently *composed* pictures — the
            middle of a wide photograph is not a portrait of the same scene.
          */}
          <SectionImage
            section={section}
            part="desktop"
            frame="hero_desktop"
            field="desktop_image_url"
            siteImages={siteImages}
            fallbackUrl={heroFallback.desktop}
            onField={onField}
          />
          <SectionImage
            section={section}
            part="mobile"
            frame="hero_mobile"
            field="mobile_image_url"
            siteImages={siteImages}
            fallbackUrl={heroFallback.mobile}
            onField={onField}
          />
          <div className="sm:col-span-2">
            <HeroVideoUploader
              id={`sec-${key}-video-upload`}
              onUploaded={(url) => onField("video_url", url)}
            />
          </div>
          <Text
            id={`sec-${key}-video`}
            label="Video address"
            value={stringAt(p, "video_url")}
            onChange={(value) => onField("video_url", value)}
            hint="Filled in by the upload above. Clear it to go back to a still hero."
          />
          <SectionImage
            section={section}
            part="poster"
            frame="hero_poster"
            field="poster_url"
            siteImages={siteImages}
            onField={onField}
          />
          {/*
            Directly under the two fields it arbitrates between, because the
            question "which of these does a customer get" is meaningless read
            anywhere else on this form.

            `RadioChoice` rather than a switch: a switch has an implied "off"
            and neither of these is off — both ship a hero. Two named states
            with a sentence each is what the owner asked for, and it is the
            same primitive /admin/settings uses for delivery mode, which
            `audit:settings-controls` already drives by its visible label.
          */}
          <div className="sm:col-span-2">
            <RadioChoice
              name={`sec-${key}-media-mode`}
              legend="What plays in the hero"
              value={
                stringAt(p, "media_mode") === "poster"
                  ? "poster"
                  : DEFAULT_HERO_MEDIA_MODE
              }
              onChange={(value) => onField("media_mode", value)}
              options={[
                {
                  value: "video",
                  label: "Video",
                  note: "The clip plays and repeats. The still above is only what loads first — a customer never sees it as a picture in its own right.",
                },
                {
                  value: "poster",
                  label: "Still image only",
                  note: "The still above becomes the hero and stays. No video is loaded at all, so the page is lighter and nothing moves. This is the one to use for a sale image.",
                },
              ]}
              hint="Switching to Still image only does not delete the video — it stops sending it. Switch back whenever you like. With Still image only, the still is the whole hero for everyone, permanently, so give it an image designed to be looked at rather than a frame grabbed from the clip."
            />
          </div>
        </>
      );

    case "category_grid": {
      const chosen = Array.isArray(p.category_slugs)
        ? (p.category_slugs as string[])
        : [];
      return (
        <fieldset className="sm:col-span-2">
          <legend className="block text-sm font-medium">
            Categories shown
          </legend>
          <p className="text-muted-foreground mt-1 text-xs">
            Tiles appear in the order the shop defines, up to six.
          </p>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-3">
            {categories.map((category) => (
              <li key={category.slug}>
                <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={chosen.includes(category.slug)}
                    onChange={(event) =>
                      onField(
                        "category_slugs",
                        event.target.checked
                          ? [...chosen, category.slug]
                          : chosen.filter((slug) => slug !== category.slug),
                      )
                    }
                  />
                  {category.name}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      );
    }

    case "product_rail":
      return (
        <>
          <Field htmlFor={`sec-${key}-collection`} label="Collection">
            <select
              id={`sec-${key}-collection`}
              value={stringAt(p, "collection_slug")}
              onChange={(event) => onField("collection_slug", event.target.value)}
              className="border-input bg-background h-10 w-full rounded-lg border px-3 text-sm"
            >
              <option value="" disabled>
                Choose a collection…
              </option>
              {collections.map((collection) => (
                <option key={collection.slug} value={collection.slug}>
                  {collection.name}
                </option>
              ))}
            </select>
          </Field>
          <Text
            id={`sec-${key}-rail-href`}
            label="See-all destination"
            value={stringAt(p, "cta_href")}
            onChange={(value) => onField("cta_href", value)}
            hint="Empty means the collection's own page."
          />
        </>
      );

    case "promo_strip": {
      const items = Array.isArray(p.items)
        ? (p.items as { label?: string; detail?: string }[])
        : [];
      return (
        <div className="sm:col-span-2">
          <p className="block text-sm font-medium">Promises</p>
          <ul className="mt-2 space-y-3">
            {items.map((item, index) => (
              <li key={index} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
                <Field htmlFor={`sec-${key}-promise-${index}`} label={`Promise ${index + 1}`}>
                  <Input
                    id={`sec-${key}-promise-${index}`}
                    value={item.label ?? ""}
                    onChange={(event) =>
                      onField(
                        "items",
                        items.map((row, i) =>
                          i === index ? { ...row, label: event.target.value } : row,
                        ),
                      )
                    }
                  />
                </Field>
                <Field htmlFor={`sec-${key}-detail-${index}`} label={`Detail ${index + 1}`}>
                  <Input
                    id={`sec-${key}-detail-${index}`}
                    value={item.detail ?? ""}
                    onChange={(event) =>
                      onField(
                        "items",
                        items.map((row, i) =>
                          i === index
                            ? { ...row, detail: event.target.value }
                            : row,
                        ),
                      )
                    }
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="self-end"
                  aria-label={`Remove promise ${index + 1}`}
                  disabled={items.length <= 1}
                  onClick={() =>
                    onField(
                      "items",
                      items.filter((_, i) => i !== index),
                    )
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            disabled={items.length >= 6}
            onClick={() => onField("items", [...items, { label: "" }])}
          >
            Add a promise
          </Button>
        </div>
      );
    }

    case "banner":
      return (
        <>
          <Text
            id={`sec-${key}-banner-cta-label`}
            label="Button label"
            value={stringAt(p, "cta_label")}
            onChange={(value) => onField("cta_label", value)}
          />
          <Text
            id={`sec-${key}-banner-cta-href`}
            label="Button destination"
            value={stringAt(p, "cta_href")}
            onChange={(value) => onField("cta_href", value)}
          />
          <SectionImage
            section={section}
            part="background"
            frame="banner_background"
            field="background_image_url"
            siteImages={siteImages}
            onField={onField}
          />
        </>
      );

    case "rich_text":
      return (
        <Field
          htmlFor={`sec-${key}-body`}
          label="The words"
          className="sm:col-span-2"
          hint={
            <>
              Blank lines make paragraphs. Lines starting with{" "}
              <code>- </code> make a list, <code>**bold**</code> works, and{" "}
              <code>{"{{free_shipping_threshold}}"}</code> always shows the
              current threshold from Settings.
            </>
          }
        >
          <textarea
            id={`sec-${key}-body`}
            value={stringAt(p, "body")}
            onChange={(event) => onField("body", event.target.value)}
            rows={8}
            className="border-input bg-background w-full rounded-lg border px-3 py-2 text-sm"
            aria-describedby={`sec-${key}-body-hint`}
          />
        </Field>
      );
  }
}
