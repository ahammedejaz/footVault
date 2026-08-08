import "server-only";

import { getCurrentUser } from "@/lib/auth";
import { rows } from "@/lib/queries/run";
import { createClient } from "@/lib/supabase/server";
import type { SavedAddress } from "@/lib/address-types";

/**
 * The address book.
 *
 * Signed-in only, and not because a guest's address is less worth keeping — it
 * is because there is nowhere to keep it. `addresses.user_id` is `not null` and
 * RLS scopes every row to `auth.uid()`, so a guest has no book by construction
 * rather than by a check in this file. A guest types their address at checkout
 * and it is snapshotted onto the order, which is the copy that matters anyway.
 *
 * Nothing here is authorisation. The RLS policy decides which rows exist for
 * this caller; the `user_id` filter below is belt and braces, and would keep
 * this query honest if a policy were ever loosened.
 */

type Row = {
  id: string;
  label: string | null;
  is_default: boolean;
  recipient_name: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
};

/**
 * Default first, then most recently added.
 *
 * The order is the whole point of the list: the address at the top is the one
 * checkout preselects, and a customer who has just added an address expects to
 * find it near the top rather than at the bottom of nine.
 */
export async function listAddresses(): Promise<SavedAddress[]> {
  const user = await getCurrentUser();
  if (!user) return [];

  const supabase = await createClient();
  const saved = await rows<Row>(
    "listAddresses",
    supabase
      .from("addresses")
      .select("id, label, is_default, recipient_name, phone, line1, line2, city, state, postal_code")
      .eq("user_id", user.id)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false }),
  );

  return saved.map(toSavedAddress);
}

function toSavedAddress(row: Row): SavedAddress {
  return {
    id: row.id,
    label: row.label,
    isDefault: row.is_default,
    recipientName: row.recipient_name,
    phone: row.phone,
    line1: row.line1,
    line2: row.line2,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    // The column is a free-text `country` defaulting to 'IN' and the shipping
    // settings list IN and nothing else, so widening this is a shipping-regions
    // decision rather than a mapping one. Asserted here, not read, so the day
    // regions open up this line is the compile error that finds every caller.
    country: "IN",
  };
}
