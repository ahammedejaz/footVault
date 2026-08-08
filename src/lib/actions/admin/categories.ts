"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";

import { adminAction, type AdminResult } from "@/lib/admin/guard";
import { MAX_CATEGORY_DEPTH } from "@/lib/queries/admin/categories";
import { CATALOG_CACHE_TAG, CHROME_CACHE_TAG } from "@/lib/queries/cached";
import { createClient } from "@/lib/supabase/server";

/**
 * Editing how the shop is grouped.
 *
 * Three rules run through everything here.
 *
 * **Nothing is orphaned silently.** Both foreign keys that point at a category
 * are `on delete set null` — `categories.parent_id` and `products.category_id`.
 * So a plain `delete` is not "remove this category", it is "quietly promote its
 * sub-categories to the top of the shop and un-file every product in it", and
 * nothing in the panel would say so. Deleting therefore refuses while children
 * exist, and requires somewhere for the products to go.
 *
 * **The tree cannot get deeper than the shop can render.** See
 * `MAX_CATEGORY_DEPTH` in the query module: the storefront header renders
 * exactly two levels, so a third would be invisible to customers while looking
 * present here.
 *
 * **A write busts both caches, not one.** The obvious tag is `catalog` — the
 * category tiles and per-category product rails. But the *navigation* tree and
 * the popular-brands list live under `chrome`, on an hour's revalidate, and
 * that is the one the owner stares at after renaming something. Missing it is
 * exactly the "I changed it and nothing happened" bug, so both go.
 *
 * `updateTag` rather than `revalidateTag`: on Next 16 the single-argument
 * `revalidateTag(tag)` is deprecated and does not typecheck, and the
 * two-argument form marks the entry *stale* — stale-while-revalidate, so the
 * owner's next render still shows the old name. `updateTag` expires it
 * immediately, which is the read-your-own-writes behaviour this needs, and it
 * is legal here because every caller is a Server Action.
 */

const NAME_MAX = 60;
const DESCRIPTION_MAX = 300;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const slugField = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "A category needs a web address.")
  .max(NAME_MAX, `Keep the web address under ${NAME_MAX} characters.`)
  .regex(
    SLUG_PATTERN,
    "Lower-case letters, numbers and hyphens only — this becomes /shop/…",
  );

const nameField = z
  .string()
  .trim()
  .min(1, "Give it a name.")
  .max(NAME_MAX, `Keep the name under ${NAME_MAX} characters.`);

const descriptionField = z
  .string()
  .trim()
  .max(
    DESCRIPTION_MAX,
    `Keep the description under ${DESCRIPTION_MAX} characters.`,
  )
  .nullish()
  .transform((value) => (value ? value : null));

const createSchema = z.object({
  name: nameField,
  slug: slugField,
  parentId: z
    .uuid()
    .nullish()
    .transform((value) => value ?? null),
  description: descriptionField,
  isActive: z.boolean(),
});

const updateSchema = createSchema.extend({
  id: z.uuid("That is not a category."),
});

export async function createCategory(
  input: unknown,
): Promise<AdminResult<{ id: string }>> {
  return adminAction<{ id: string }>(
    "createCategory",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = createSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const shape = await loadShape(supabase);
      const placement = checkPlacement(shape, null, parsed.data.parentId, 0);
      if (placement) return placement;

      const siblings = childrenOf(shape, parsed.data.parentId);
      const { data, error } = await supabase
        .from("categories")
        .insert({
          name: parsed.data.name,
          slug: parsed.data.slug,
          parent_id: parsed.data.parentId,
          description: parsed.data.description,
          is_active: parsed.data.isActive,
          // Straight onto the end rather than into the middle: a new category
          // appearing above ones the owner has already ordered reads as a bug.
          sort_order: siblings.length,
        })
        .select("id")
        .single();

      if (error) return writeFailure(error, parsed.data.slug);
      bust();
      return { ok: true, id: data.id };
    },
  );
}

export async function updateCategory(
  input: unknown,
): Promise<AdminResult<{ id: string }>> {
  return adminAction<{ id: string }>(
    "updateCategory",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = updateSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const shape = await loadShape(supabase);
      const current = shape.find((row) => row.id === parsed.data.id);
      if (!current) {
        return {
          ok: false,
          reason: "invalid",
          message: "That category no longer exists.",
        };
      }

      const moving = current.parent_id !== parsed.data.parentId;
      if (moving) {
        const placement = checkPlacement(
          shape,
          parsed.data.id,
          parsed.data.parentId,
          subtreeHeight(shape, parsed.data.id),
        );
        if (placement) return placement;
      }

      const { error } = await supabase
        .from("categories")
        .update({
          name: parsed.data.name,
          slug: parsed.data.slug,
          parent_id: parsed.data.parentId,
          description: parsed.data.description,
          is_active: parsed.data.isActive,
          ...(moving
            ? { sort_order: childrenOf(shape, parsed.data.parentId).length }
            : {}),
        })
        .eq("id", parsed.data.id);

      if (error) return writeFailure(error, parsed.data.slug);

      if (moving) {
        // The category it came from now has a gap in its numbering. Left alone
        // that is harmless until the owner presses an arrow, at which point the
        // gap decides where the row lands.
        const remaining = childrenOf(shape, current.parent_id)
          .filter((row) => row.id !== parsed.data.id)
          .map((row) => row.id);
        const failure = await renumber(supabase, shape, remaining);
        if (failure) return failure;
      }

      bust();
      return { ok: true, id: parsed.data.id };
    },
  );
}

const activeSchema = z.object({
  id: z.uuid("That is not a category."),
  isActive: z.boolean(),
});

export async function setCategoryActive(
  input: unknown,
): Promise<AdminResult<{ id: string; isActive: boolean }>> {
  return adminAction<{ id: string; isActive: boolean }>(
    "setCategoryActive",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = activeSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const { error } = await supabase
        .from("categories")
        .update({ is_active: parsed.data.isActive })
        .eq("id", parsed.data.id);
      if (error) return writeFailure(error, null);

      bust();
      return { ok: true, id: parsed.data.id, isActive: parsed.data.isActive };
    },
  );
}

const moveSchema = z.object({
  id: z.uuid("That is not a category."),
  direction: z.enum(["up", "down", "in", "out"]),
});

/**
 * Reorder and re-nest, with buttons rather than drag-and-drop.
 *
 * Four explicit controls beat a drag handle here, and not only because they are
 * quicker to build. A drag target is a pointer gesture with a keyboard story
 * that has to be written separately and is usually written badly; four buttons
 * are already reachable by tab, already announce what they do, and already have
 * a 44px target on a tablet. The owner reorders a category list a handful of
 * times a year — the accessible version is also the honest one.
 *
 * Every move renumbers the affected siblings from zero rather than swapping two
 * values. `sort_order` defaults to 0, so a shop that has never reordered
 * anything has every category sitting at 0, and a swap between two rows that
 * both hold 0 does nothing at all while appearing to succeed.
 */
export async function moveCategory(
  input: unknown,
): Promise<AdminResult<{ id: string }>> {
  return adminAction<{ id: string }>(
    "moveCategory",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = moveSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const shape = await loadShape(supabase);
      const node = shape.find((row) => row.id === parsed.data.id);
      if (!node) {
        return {
          ok: false,
          reason: "invalid",
          message: "That category no longer exists.",
        };
      }

      const siblings = childrenOf(shape, node.parent_id);
      const index = siblings.findIndex((row) => row.id === node.id);

      if (parsed.data.direction === "up" || parsed.data.direction === "down") {
        const target = parsed.data.direction === "up" ? index - 1 : index + 1;
        if (target < 0 || target >= siblings.length) {
          return {
            ok: false,
            reason: "invalid",
            message: `${node.name} is already ${parsed.data.direction === "up" ? "first" : "last"} in its group.`,
          };
        }
        const order = siblings.map((row) => row.id);
        const [moved] = order.splice(index, 1);
        order.splice(target, 0, moved!);
        const failure = await renumber(supabase, shape, order);
        if (failure) return failure;
        bust();
        return { ok: true, id: node.id };
      }

      if (parsed.data.direction === "in") {
        const newParent = siblings[index - 1];
        if (!newParent) {
          return {
            ok: false,
            reason: "invalid",
            message: `${node.name} has nothing above it to sit under. Move it down first.`,
          };
        }
        const placement = checkPlacement(
          shape,
          node.id,
          newParent.id,
          subtreeHeight(shape, node.id),
        );
        if (placement) return placement;

        const target = childrenOf(shape, newParent.id);
        const { error } = await supabase
          .from("categories")
          .update({ parent_id: newParent.id, sort_order: target.length })
          .eq("id", node.id);
        if (error) return writeFailure(error, null);

        const failure = await renumber(
          supabase,
          shape,
          siblings.filter((row) => row.id !== node.id).map((row) => row.id),
        );
        if (failure) return failure;
        bust();
        return { ok: true, id: node.id };
      }

      // "out"
      const parent = shape.find((row) => row.id === node.parent_id);
      if (!parent) {
        return {
          ok: false,
          reason: "invalid",
          message: `${node.name} is already at the top level.`,
        };
      }

      const { error } = await supabase
        .from("categories")
        .update({ parent_id: parent.parent_id })
        .eq("id", node.id);
      if (error) return writeFailure(error, null);

      // Lands directly after the category it came out of, which is where the
      // owner's eye already is.
      const uncles = childrenOf(shape, parent.parent_id).map((row) => row.id);
      const at = uncles.indexOf(parent.id);
      uncles.splice(at + 1, 0, node.id);
      const failure = await renumber(supabase, shape, uncles);
      if (failure) return failure;

      const leftBehind = childrenOf(shape, parent.id)
        .filter((row) => row.id !== node.id)
        .map((row) => row.id);
      const second = await renumber(supabase, shape, leftBehind);
      if (second) return second;

      bust();
      return { ok: true, id: node.id };
    },
  );
}

const deleteSchema = z.object({
  id: z.uuid("That is not a category."),
  /** Where its products go. Required when it has any. */
  moveProductsTo: z
    .uuid()
    .nullish()
    .transform((value) => value ?? null),
});

export async function deleteCategory(
  input: unknown,
): Promise<AdminResult<{ id: string; movedProducts: number }>> {
  return adminAction<{ id: string; movedProducts: number }>(
    "deleteCategory",
    "adminBulk",
    async ({ supabase }) => {
      const parsed = deleteSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const shape = await loadShape(supabase);
      const node = shape.find((row) => row.id === parsed.data.id);
      if (!node) {
        // Already gone is the outcome the caller wanted.
        return { ok: true, id: parsed.data.id, movedProducts: 0 };
      }

      const children = childrenOf(shape, node.id);
      if (children.length > 0) {
        return {
          ok: false,
          reason: "conflict",
          message:
            `${node.name} has ${children.length} sub-categor${children.length === 1 ? "y" : "ies"} ` +
            `(${children.map((row) => row.name).join(", ")}). Deleting it would leave ` +
            `${children.length === 1 ? "it" : "them"} loose at the top of the shop — move or delete ` +
            `${children.length === 1 ? "it" : "them"} first.`,
        };
      }

      // Soft-deleted products count. The foreign key would clear their category
      // too, and a hidden product restored later would come back unfiled.
      const filed = await countProducts(supabase, node.id);
      if (filed > 0) {
        const destination = parsed.data.moveProductsTo;
        if (!destination || destination === node.id) {
          return {
            ok: false,
            reason: "conflict",
            message: `${node.name} still has ${filed} product${filed === 1 ? "" : "s"} filed under it. Choose where they should go first.`,
          };
        }
        if (!shape.some((row) => row.id === destination)) {
          return {
            ok: false,
            reason: "invalid",
            message: "That destination category no longer exists.",
          };
        }
        const { error } = await supabase
          .from("products")
          .update({ category_id: destination })
          .eq("category_id", node.id);
        if (error) {
          console.error(
            "[admin] deleteCategory could not move products:",
            error.message,
          );
          return {
            ok: false,
            reason: "error",
            message:
              "The products did not move, so nothing has been deleted. Try again.",
          };
        }
      }

      const { error } = await supabase
        .from("categories")
        .delete()
        .eq("id", node.id);
      if (error) return writeFailure(error, null);

      const failure = await renumber(
        supabase,
        shape,
        childrenOf(shape, node.parent_id)
          .filter((row) => row.id !== node.id)
          .map((row) => row.id),
      );
      if (failure) return failure;

      bust();
      return { ok: true, id: node.id, movedProducts: filed };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* helpers — not exported, so no browser can reach them                       */
/* -------------------------------------------------------------------------- */

type ServerClient = Awaited<ReturnType<typeof createClient>>;
type Shape = {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  sort_order: number;
};

async function loadShape(supabase: ServerClient): Promise<Shape[]> {
  const { data, error } = await supabase
    .from("categories")
    .select("id, name, slug, parent_id, sort_order")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (error) {
    throw new Error(`admin.categories.shape: ${error.message}`);
  }
  return data ?? [];
}

function childrenOf(shape: Shape[], parentId: string | null): Shape[] {
  return shape.filter((row) => row.parent_id === parentId);
}

function depthOf(shape: Shape[], id: string | null): number {
  let depth = -1;
  let cursor = id;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    depth += 1;
    cursor = shape.find((row) => row.id === cursor)?.parent_id ?? null;
  }
  return depth;
}

/** How many levels sit below this node. 0 for a leaf. */
function subtreeHeight(shape: Shape[], id: string): number {
  const children = childrenOf(shape, id);
  if (children.length === 0) return 0;
  return (
    1 + Math.max(...children.map((child) => subtreeHeight(shape, child.id)))
  );
}

function descendantsOf(shape: Shape[], id: string): Set<string> {
  const found = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const current = queue.pop()!;
    for (const child of childrenOf(shape, current)) {
      if (found.has(child.id)) continue;
      found.add(child.id);
      queue.push(child.id);
    }
  }
  return found;
}

/**
 * Whether `id` may live under `parentId`, refusing with the sentence the owner
 * needs rather than a boolean.
 *
 * `id` is null when the category does not exist yet. `height` is how deep the
 * moving subtree is, because moving a parent moves everything under it and the
 * depth ceiling applies to the deepest leaf, not to the node being dragged.
 */
function checkPlacement(
  shape: Shape[],
  id: string | null,
  parentId: string | null,
  height: number,
): AdminResult<never> | null {
  if (parentId === null) return null;

  const parent = shape.find((row) => row.id === parentId);
  if (!parent) {
    return {
      ok: false,
      reason: "invalid",
      message: "That parent category no longer exists.",
    };
  }

  if (id !== null) {
    if (parentId === id) {
      return {
        ok: false,
        reason: "invalid",
        message: "A category cannot sit inside itself.",
      };
    }
    // The database only forbids being one's own parent, so a two-step loop
    // (A under B, B under A) is reachable from here and would hang the tree
    // walk on the storefront rather than error.
    if (descendantsOf(shape, id).has(parentId)) {
      return {
        ok: false,
        reason: "invalid",
        message:
          "That would put a category inside one of its own sub-categories.",
      };
    }
  }

  if (depthOf(shape, parentId) + 1 + height > MAX_CATEGORY_DEPTH) {
    return {
      ok: false,
      reason: "invalid",
      message:
        "The shop's menu shows two levels. Nesting this any deeper would hide it from customers entirely.",
    };
  }
  return null;
}

/** Writes 0…n-1 over a set of siblings in one statement. */
async function renumber(
  supabase: ServerClient,
  shape: Shape[],
  orderedIds: string[],
): Promise<AdminResult<never> | null> {
  const payload = orderedIds.flatMap((id, index) => {
    const row = shape.find((candidate) => candidate.id === id);
    if (!row) return [];
    // `upsert` conflicts on the primary key and so only ever updates here; name
    // and slug are carried because they are NOT NULL on the insert path the
    // type demands, not because they change.
    return [{ id, name: row.name, slug: row.slug, sort_order: index }];
  });
  if (payload.length === 0) return null;

  const { error } = await supabase.from("categories").upsert(payload);
  if (error) {
    console.error("[admin] categories renumber failed:", error.message);
    return {
      ok: false,
      reason: "error",
      message:
        "The order did not save. Reload the page to see where things are.",
    };
  }
  return null;
}

async function countProducts(
  supabase: ServerClient,
  categoryId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("category_id", categoryId);
  if (error) {
    throw new Error(`admin.categories.productCount: ${error.message}`);
  }
  return count ?? 0;
}

function invalid(error: z.ZodError): AdminResult<never> {
  const issue = error.issues[0];
  return {
    ok: false,
    reason: "invalid",
    message: issue?.message ?? "Check that and try again.",
    field: issue?.path[0] === undefined ? undefined : String(issue.path[0]),
  };
}

function writeFailure(
  error: { code?: string; message: string },
  slug: string | null,
): AdminResult<never> {
  if (error.code === "23505") {
    return {
      ok: false,
      reason: "conflict",
      message: slug
        ? `Another category already uses /shop/${slug}. Pick a different web address.`
        : "Another category already uses that web address.",
    };
  }
  if (error.code === "23514") {
    return {
      ok: false,
      reason: "invalid",
      message: "A category cannot sit inside itself.",
    };
  }
  console.error("[admin] category write failed:", error.message, error.code);
  return {
    ok: false,
    reason: "error",
    message: "That did not save. Nothing has been changed — please try again.",
  };
}

/**
 * Both caches, and the panel's own page.
 *
 * See the file header for why `chrome` is in here as well as `catalog`.
 */
function bust() {
  updateTag(CATALOG_CACHE_TAG);
  updateTag(CHROME_CACHE_TAG);
  revalidatePath("/admin/categories");
  revalidatePath("/", "layout");
}
