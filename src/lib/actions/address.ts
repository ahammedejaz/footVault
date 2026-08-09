"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { maybeRow } from "@/lib/queries/run";
import { createClient } from "@/lib/supabase/server";
import {
  addressBookSchema,
  addressEditSchema,
} from "@/lib/validations/address";
import type { ActionResult } from "@/lib/actions/cart";

/**
 * Writing the address book.
 *
 * The book is a convenience, never the record: what ships is the `jsonb`
 * snapshot written onto the order, so tidying this list cannot rewrite where a
 * shipped parcel went. That is what makes deleting an entry safe enough to
 * offer without a confirmation dialog.
 *
 * Every write goes through `addressBookSchema` — the same schema the form uses
 * — because the form is not the only thing that can POST here. Nothing trusts
 * the `user_id`: it comes from the verified session, and RLS scopes each row to
 * `auth.uid()` besides, so a forged id finds no row rather than someone else's.
 *
 * **One default per customer is a partial unique index, not a trigger.** The
 * database rejects a second default rather than silently demoting the first, so
 * promoting an address is demote-then-promote here, in that order. Getting it
 * the wrong way round is a 23505 the customer would see as "that did not save".
 */

const GENERIC = "That address did not save. Try again.";
const SIGNED_OUT = "Sign in to keep addresses for next time.";

const addressIdSchema = z.uuid();

/* ------------------------------------------------------------------- save -- */

/**
 * Add an address to the book.
 *
 * The first address a customer saves becomes their default whether they asked
 * or not — a book of one with nothing preselected makes checkout ask a question
 * that has only one answer.
 */
export async function saveAddress(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = addressBookSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? GENERIC };
  }

  const user = await getCurrentUser();
  if (!user) return { ok: false, message: SIGNED_OUT };

  try {
    const supabase = await createClient();
    const address = parsed.data;

    const existing = await maybeRow<{ id: string }>(
      "saveAddress.existing",
      supabase
        .from("addresses")
        .select("id")
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle(),
    );
    const isDefault = address.isDefault || !existing;

    if (isDefault) {
      const cleared = await clearDefault(user.id);
      if (!cleared) return { ok: false, message: GENERIC };
    }

    const { data, error } = await supabase
      .from("addresses")
      .insert({
        user_id: user.id,
        label: address.label,
        recipient_name: address.recipientName,
        phone: address.phone,
        line1: address.line1,
        line2: address.line2,
        city: address.city,
        state: address.state,
        postal_code: address.postalCode,
        country: address.country,
        is_default: isDefault,
      })
      .select("id")
      .single();

    if (error || !data) {
      console.error("[address] insert failed:", error?.message, error?.code);
      return { ok: false, message: GENERIC };
    }

    refresh();
    return { ok: true, data: { id: data.id } };
  } catch (error) {
    console.error("[address] saveAddress threw:", error);
    return { ok: false, message: GENERIC };
  }
}

/* ------------------------------------------------------------------- edit -- */

/**
 * Change an entry that already exists.
 *
 * The verb the book was missing. Until now `saveAddress` inserted
 * unconditionally, so "editing" an address meant removing it and typing it
 * again — and the account page told customers they could edit, which was a
 * promise nothing in the code kept.
 *
 * **The PIN code is the interesting field.** It decides the delivery rate and
 * whether Pay on Delivery is offered at all, so an edit that changes it changes
 * money. Nothing here re-prices anything, and that is correct rather than an
 * omission: a shipping quote is keyed `(cart_id, postal_code, payment_method)`
 * in `shipping_quotes`, so a changed PIN cannot match a stored quote and the
 * next read is a miss that fetches a fresh one. The checkout's own quote is
 * keyed `(pin, method)` in the same way and re-runs when the pin it renders
 * changes. `refresh()` below revalidates `/checkout`, which is what makes the
 * page see the new PIN in the first place. Re-quoting here as well would be a
 * second mechanism competing with the one that already works, and the failure
 * mode of two caches disagreeing about a price is worse than the round trip it
 * would save.
 *
 * The default flag is the other half. Unticking it on the entry that *is* the
 * default would otherwise leave the book with none, and checkout would
 * preselect nothing — so an heir is promoted, exactly as `deleteAddress` does.
 * With no heir to promote the flag stays on: a book of one with nothing
 * preselected asks a question that has only one answer.
 */
export async function updateAddress(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = addressEditSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? GENERIC };
  }

  const user = await getCurrentUser();
  if (!user) return { ok: false, message: SIGNED_OUT };

  try {
    const supabase = await createClient();
    const { id, ...address } = parsed.data;

    /*
      Scoped by user_id as well as id. RLS already scopes the row to
      `auth.uid()`, so this is the second of two locks rather than the only
      one — but it is what turns "somebody else's id" into a clean "no longer
      saved" instead of an update that silently matches nothing.
    */
    const target = await maybeRow<{ id: string; is_default: boolean }>(
      "updateAddress.target",
      supabase
        .from("addresses")
        .select("id, is_default")
        .eq("id", id)
        .eq("user_id", user.id)
        .maybeSingle(),
    );
    if (!target)
      return { ok: false, message: "That address is no longer saved." };

    /*
      Promote first, demote after — the opposite order to `saveAddress`, and
      for the same reason it cares about order at all. The partial unique index
      permits one default per customer, so clearing the flag on this row before
      setting it elsewhere is the only sequence that never has two.
    */
    if (address.isDefault && !target.is_default) {
      const cleared = await clearDefault(user.id);
      if (!cleared) return { ok: false, message: GENERIC };
    }

    let keepDefault = address.isDefault;

    if (target.is_default && !address.isDefault) {
      const heir = await maybeRow<{ id: string }>(
        "updateAddress.heir",
        supabase
          .from("addresses")
          .select("id")
          .eq("user_id", user.id)
          .neq("id", target.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      );
      if (heir) {
        // Demote this one first: the index allows only one default at a time.
        const { error: demoteError } = await supabase
          .from("addresses")
          .update({ is_default: false })
          .eq("id", target.id);
        if (demoteError) {
          console.error("[address] demoting failed:", demoteError.message);
          return { ok: false, message: GENERIC };
        }
        const { error: promoteError } = await supabase
          .from("addresses")
          .update({ is_default: true })
          .eq("id", heir.id);
        if (promoteError) {
          console.error("[address] promoting an heir failed:", promoteError.message);
        }
        keepDefault = false;
      } else {
        // Nothing to hand it to. Keeping the flag beats a book with no default.
        keepDefault = true;
      }
    }

    const { error } = await supabase
      .from("addresses")
      .update({
        label: address.label,
        recipient_name: address.recipientName,
        phone: address.phone,
        line1: address.line1,
        line2: address.line2,
        city: address.city,
        state: address.state,
        postal_code: address.postalCode,
        country: address.country,
        is_default: keepDefault,
      })
      .eq("id", target.id);

    if (error) {
      console.error("[address] update failed:", error.message, error.code);
      return { ok: false, message: GENERIC };
    }

    refresh();
    return { ok: true, data: { id: target.id } };
  } catch (error) {
    console.error("[address] updateAddress threw:", error);
    return { ok: false, message: GENERIC };
  }
}

/* ----------------------------------------------------------------- delete -- */

/**
 * Remove an entry.
 *
 * If it was the default, the most recent survivor takes over. Leaving a book
 * with no default would make the next checkout preselect nothing, which reads
 * as the shop having forgotten where the customer lives.
 */
export async function deleteAddress(
  id: string,
): Promise<ActionResult<undefined>> {
  const parsed = addressIdSchema.safeParse(id);
  if (!parsed.success) return { ok: false, message: GENERIC };

  const user = await getCurrentUser();
  if (!user) return { ok: false, message: SIGNED_OUT };

  try {
    const supabase = await createClient();

    const target = await maybeRow<{ id: string; is_default: boolean }>(
      "deleteAddress.target",
      supabase
        .from("addresses")
        .select("id, is_default")
        .eq("id", parsed.data)
        .eq("user_id", user.id)
        .maybeSingle(),
    );
    // Already gone is the state that was asked for, so it is not a failure.
    if (!target) {
      refresh();
      return { ok: true, data: undefined };
    }

    const { error } = await supabase
      .from("addresses")
      .delete()
      .eq("id", target.id);
    if (error) {
      console.error("[address] delete failed:", error.message);
      return {
        ok: false,
        message: "That address could not be removed. Try again.",
      };
    }

    if (target.is_default) {
      const heir = await maybeRow<{ id: string }>(
        "deleteAddress.heir",
        supabase
          .from("addresses")
          .select("id")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      );
      if (heir) {
        const { error: promoteError } = await supabase
          .from("addresses")
          .update({ is_default: true })
          .eq("id", heir.id);
        // The address is gone, which is what was asked for. A book with no
        // default is a smaller problem than telling the customer the removal
        // failed when it did not.
        if (promoteError) {
          console.error(
            "[address] promoting an heir failed:",
            promoteError.message,
          );
        }
      }
    }

    refresh();
    return { ok: true, data: undefined };
  } catch (error) {
    console.error("[address] deleteAddress threw:", error);
    return { ok: false, message: GENERIC };
  }
}

/* ---------------------------------------------------------------- default -- */

/** Make one entry the default. Demote first: the unique index allows only one. */
export async function setDefaultAddress(
  id: string,
): Promise<ActionResult<undefined>> {
  const parsed = addressIdSchema.safeParse(id);
  if (!parsed.success) return { ok: false, message: GENERIC };

  const user = await getCurrentUser();
  if (!user) return { ok: false, message: SIGNED_OUT };

  try {
    const supabase = await createClient();

    const target = await maybeRow<{ id: string; is_default: boolean }>(
      "setDefaultAddress.target",
      supabase
        .from("addresses")
        .select("id, is_default")
        .eq("id", parsed.data)
        .eq("user_id", user.id)
        .maybeSingle(),
    );
    if (!target)
      return { ok: false, message: "That address is no longer saved." };
    if (target.is_default) return { ok: true, data: undefined };

    const cleared = await clearDefault(user.id);
    if (!cleared) return { ok: false, message: GENERIC };

    const { error } = await supabase
      .from("addresses")
      .update({ is_default: true })
      .eq("id", target.id);

    if (error) {
      console.error("[address] setDefault failed:", error.message, error.code);
      return { ok: false, message: GENERIC };
    }

    refresh();
    return { ok: true, data: undefined };
  } catch (error) {
    console.error("[address] setDefaultAddress threw:", error);
    return { ok: false, message: GENERIC };
  }
}

/* ------------------------------------------------------------------ parts -- */

/** Demote whatever is currently default. True when the book is safe to write. */
async function clearDefault(userId: string): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("addresses")
    .update({ is_default: false })
    .eq("user_id", userId)
    .eq("is_default", true);

  if (error) {
    console.error("[address] clearing the default failed:", error.message);
    return false;
  }
  return true;
}

/** Checkout and the account pages both render the book. */
function refresh(): void {
  revalidatePath("/checkout");
  revalidatePath("/account/addresses");
}
