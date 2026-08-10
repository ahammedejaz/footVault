"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";

import { HomeSection } from "@/components/storefront/home-sections";
import { adminAction, type AdminResult } from "@/lib/admin/guard";
import { contentTokens } from "@/lib/content-tokens";
import {
  isEditableType,
  parseSectionPayload,
} from "@/lib/content/section-payload";
import type { Json } from "@/lib/database.types";
import { CATALOG_CACHE_TAG } from "@/lib/queries/cached";
import type { SectionType } from "@/lib/queries/content";

/**
 * The homepage, written by the owner.
 *
 * Two actions. `publishHomepage` takes the editor's whole working layout and
 * makes the table match it — order, visibility, copy, payloads, deletions, all
 * in one submission. `previewHomepage` renders that same layout through the
 * real storefront renderer and returns the elements, so what the owner sees
 * before publishing is produced by the exact code that will produce the
 * homepage after, tokens resolved the same way. A preview that is a separate
 * implementation of the renderer is a preview that lies precisely when it
 * matters — when the two disagree.
 *
 * Nothing is persisted by preview. The publish is the only write.
 */

/** One section as the editor holds it. `id` null means "created here". */
const sectionInput = z.object({
  id: z.string().uuid().nullable(),
  sectionType: z.string(),
  title: z.string().trim().max(120, "Keep the title under 120 characters.").nullable(),
  subtitle: z
    .string()
    .trim()
    .max(300, "Keep the subtitle under 300 characters.")
    .nullable(),
  isActive: z.boolean(),
  payload: z.record(z.string(), z.unknown()),
});

/**
 * Twenty is not a product limit, it is a sanity bound: the seed ships seven and
 * a homepage two dozen sections long has a different problem than validation.
 */
const layoutSchema = z
  .array(sectionInput)
  .max(20, "That is more sections than a homepage can carry.");

type SectionInput = z.infer<typeof sectionInput>;

/**
 * Validate one entry, returning the payload to write.
 *
 * A type without a schema — `testimonials` today — may pass through **only if
 * the row already exists**. The editor cannot create what it cannot edit, but a
 * row somebody made by hand must survive a publish untouched rather than
 * blocking the whole layout or being silently dropped.
 */
function vetSection(
  entry: SectionInput,
  index: number,
):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; message: string } {
  const name = entry.title || entry.sectionType;
  if (!isEditableType(entry.sectionType)) {
    if (entry.id === null) {
      return {
        ok: false,
        message: `Section ${index + 1} (${name}): sections of type "${entry.sectionType}" cannot be created here.`,
      };
    }
    return { ok: true, payload: entry.payload };
  }
  const parsed = parseSectionPayload(entry.sectionType, entry.payload);
  if (!parsed.ok) {
    return { ok: false, message: `Section ${index + 1} (${name}): ${parsed.message}` };
  }
  return parsed;
}

export type PublishedSection = {
  id: string;
  sectionType: string;
  title: string | null;
  subtitle: string | null;
  payload: Record<string, unknown>;
  sortOrder: number;
  isActive: boolean;
};

export async function publishHomepage(
  input: unknown,
): Promise<AdminResult<{ sections: PublishedSection[]; removed: number }>> {
  return adminAction<{ sections: PublishedSection[]; removed: number }>(
    "publishHomepage",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = layoutSchema.safeParse(input);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        return {
          ok: false,
          reason: "invalid",
          message: first ? first.message : "That layout is not valid.",
        };
      }

      const vetted: { entry: SectionInput; payload: Record<string, unknown> }[] = [];
      for (const [index, entry] of parsed.data.entries()) {
        const vet = vetSection(entry, index);
        if (!vet.ok) return { ok: false, reason: "invalid", message: vet.message };
        vetted.push({ entry, payload: vet.payload });
      }

      /*
        What the publish removes is computed against the table, not against what
        the editor believed the table held — two tabs racing each other should
        end with one coherent layout, not a union of leftovers.
      */
      const { data: existing, error: readError } = await supabase
        .from("homepage_sections")
        .select("id");
      if (readError) {
        return { ok: false, reason: "error", message: "Could not read the current homepage." };
      }
      const kept = new Set(
        vetted.map(({ entry }) => entry.id).filter((id): id is string => id !== null),
      );
      const doomed = (existing ?? []).map((r) => r.id).filter((id) => !kept.has(id));

      /*
        Three statements, not one transaction — a mid-way failure leaves a
        partial publish. Accepted with eyes open: the alternative is an RPC,
        which is a production migration this batch deliberately avoids. The
        editor keeps its working state on failure, every statement here is safe
        to repeat, and "press Publish again" fully repairs any partial state.
        Order: updates before inserts before deletes, so a failure late in the
        sequence leaves extra sections rather than a hole where the hero was.
      */
      const updates = vetted.filter(({ entry }) => entry.id !== null);
      for (const [index, { entry, payload }] of vetted.entries()) {
        if (entry.id === null) continue;
        const { error } = await supabase
          .from("homepage_sections")
          .update({
            title: entry.title || null,
            subtitle: entry.subtitle || null,
            payload: payload as Json,
            sort_order: index,
            is_active: entry.isActive,
          })
          .eq("id", entry.id);
        if (error) {
          return { ok: false, reason: "error", message: "The layout did not fully save. Publish again." };
        }
      }

      const inserts = vetted
        .map(({ entry, payload }, index) => ({ entry, payload, index }))
        .filter(({ entry }) => entry.id === null);
      if (inserts.length > 0) {
        const { error } = await supabase.from("homepage_sections").insert(
          inserts.map(({ entry, payload, index }) => ({
            section_type: entry.sectionType as SectionType,
            title: entry.title || null,
            subtitle: entry.subtitle || null,
            payload: payload as Json,
            sort_order: index,
            is_active: entry.isActive,
          })),
        );
        if (error) {
          return { ok: false, reason: "error", message: "The new sections did not save. Publish again." };
        }
      }

      if (doomed.length > 0) {
        const { error } = await supabase
          .from("homepage_sections")
          .delete()
          .in("id", doomed);
        if (error) {
          return { ok: false, reason: "error", message: "The removed sections are still there. Publish again." };
        }
      }

      /*
        `updateTag`, not `revalidateTag`: the owner is about to open the
        homepage to see their change, and the two-argument revalidate serves
        them the stale page once more before refreshing. Same read-your-own-
        writes reasoning as the categories action, which is where the Next 16
        distinction is written up.
      */
      updateTag(CATALOG_CACHE_TAG);
      revalidatePath("/");

      /* Read back so the editor can adopt real ids without a reload. */
      const { data: fresh, error: freshError } = await supabase
        .from("homepage_sections")
        .select("id, section_type, title, subtitle, payload, sort_order, is_active")
        .order("sort_order");
      if (freshError || !fresh) {
        return { ok: false, reason: "error", message: "Published, but could not read the result back. Reload the page." };
      }
      console.log(
        `[admin] publishHomepage: ${updates.length} updated, ${inserts.length} added, ${doomed.length} removed`,
      );
      return {
        ok: true,
        removed: doomed.length,
        sections: fresh.map((row) => ({
          id: row.id,
          sectionType: row.section_type,
          title: row.title,
          subtitle: row.subtitle,
          payload: (row.payload ?? {}) as Record<string, unknown>,
          sortOrder: row.sort_order,
          isActive: row.is_active,
        })),
      };
    },
  );
}

/**
 * The unpublished layout, rendered by the real renderer.
 *
 * Returns React elements across the Server Action boundary — the RSC response
 * format carries rendered UI as well as data, and this is the documented shape
 * of that channel. The elements are produced by the same `HomeSection` the
 * homepage uses, with tokens resolved through the same `contentTokens()`, so
 * the preview cannot drift from the publish: there is no second renderer to
 * disagree with the first.
 *
 * Admin-gated like every mutation, although it writes nothing: it renders
 * arbitrary owner-shaped payloads with live catalogue queries behind them, and
 * that is not a service to offer anonymous callers.
 */
export async function previewHomepage(
  input: unknown,
): Promise<AdminResult<{ view: React.ReactNode }>> {
  return adminAction<{ view: React.ReactNode }>(
    "previewHomepage",
    "adminMutation",
    async () => {
      const parsed = layoutSchema.safeParse(input);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        return {
          ok: false,
          reason: "invalid",
          message: first ? first.message : "That layout is not valid.",
        };
      }
      for (const [index, entry] of parsed.data.entries()) {
        const vet = vetSection(entry, index);
        if (!vet.ok) return { ok: false, reason: "invalid", message: vet.message };
      }

      const tokens = await contentTokens();
      const visible = parsed.data.filter((entry) => entry.isActive);
      return {
        ok: true,
        view: (
          <>
            {visible.map((entry, index) => (
              <HomeSection
                key={entry.id ?? `new-${index}`}
                section={{
                  id: entry.id ?? `preview-${index}`,
                  sectionType: entry.sectionType as SectionType,
                  title: entry.title,
                  subtitle: entry.subtitle,
                  payload: entry.payload,
                }}
                tokens={tokens}
              />
            ))}
          </>
        ),
      };
    },
  );
}
