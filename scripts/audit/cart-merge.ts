/**
 * Merge on sign-in, end to end.
 *
 * "Guest adds three items, signs in with Google, all three are still there,
 * combined with anything already in their account cart. Quantities sum, capped
 * at available stock." That is the sentence this script checks, line by line.
 *
 *   npx tsx scripts/audit/cart-merge.ts
 *
 * It talks to the real database over PostgREST with the real policies in force.
 * The guest half is a client carrying an `x-guest-token` header and no session —
 * exactly what an anonymous browser is — and the merge runs through a client
 * carrying both that header and a real user JWT, which is what the client in
 * /auth/callback is at the moment it runs.
 *
 * No elevated key anywhere: if RLS were wrong, this would fail rather than
 * paper over it.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { mergeGuestCartIntoAccount } from "../../src/lib/cart/merge";
import type { Database } from "../../src/lib/database.types";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const PASSWORD = "correct-horse-battery-staple-42";

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  if (!passed) failures++;
  console.log(`${passed ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** An anonymous browser: a token in a header, no session. */
function guestClient(token: string): SupabaseClient<Database> {
  return createClient<Database>(URL_, ANON, {
    auth: { persistSession: false },
    global: { headers: { "x-guest-token": token } },
  });
}

/** What /auth/callback holds: the guest header *and* the new session. */
function callbackClient(token: string, accessToken: string): SupabaseClient<Database> {
  return createClient<Database>(URL_, ANON, {
    auth: { persistSession: false },
    global: {
      headers: { "x-guest-token": token, Authorization: `Bearer ${accessToken}` },
    },
  });
}

async function main() {
  console.log("\nCart merge on sign-in\n");

  const anon = createClient<Database>(URL_, ANON, { auth: { persistSession: false } });

  // Three real variants with stock, plus one deliberately scarce.
  const { data: variants, error: variantError } = await anon
    .from("product_variants")
    .select("id, size, stock_quantity, product:products!inner(name, is_active)")
    .eq("is_active", true)
    .gte("stock_quantity", 3)
    .limit(4);
  if (variantError || !variants || variants.length < 4) {
    throw new Error(`need 4 in-stock variants: ${variantError?.message ?? "not enough seed stock"}`);
  }
  const [a, b, c, shared] = variants;

  /* ── guest fills a bag ─────────────────────────────────────────────────── */
  const token = randomUUID();
  const guest = guestClient(token);

  const { data: guestCart, error: guestCartError } = await guest
    .from("carts")
    .insert({ guest_token: token })
    .select("id")
    .single();
  check("a guest can create a cart with only a token", !guestCartError, guestCartError?.message ?? "");
  if (!guestCart) throw new Error("no guest cart");

  const guestLines = [
    { cart_id: guestCart.id, variant_id: a.id, quantity: 1 },
    { cart_id: guestCart.id, variant_id: b.id, quantity: 2 },
    { cart_id: guestCart.id, variant_id: c.id, quantity: 1 },
    // Also in the account bag already — this is the line that must sum.
    { cart_id: guestCart.id, variant_id: shared.id, quantity: 2 },
  ];
  const { error: linesError } = await guest.from("cart_items").insert(guestLines);
  check("the guest can fill it", !linesError, linesError?.message ?? "");

  /* ── a second browser cannot see it ────────────────────────────────────── */
  const stranger = guestClient(randomUUID());
  const { data: peek } = await stranger.from("cart_items").select("id").eq("cart_id", guestCart.id);
  check("another guest token reads zero of those lines", (peek?.length ?? 0) === 0, `${peek?.length ?? 0} rows`);

  /* ── the customer signs in, with an account bag already going ──────────── */
  const email = `fv-merge.${Date.now().toString(36)}@example.com`;
  const { data: signUp, error: signUpError } = await anon.auth.signUp({
    email,
    password: PASSWORD,
    options: { data: { full_name: "Merge Test" } },
  });
  if (signUpError || !signUp.session) throw new Error(`signUp: ${signUpError?.message}`);
  const userId = signUp.user!.id;

  const asUser = createClient<Database>(URL_, ANON, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${signUp.session.access_token}` } },
  });

  const { data: accountCart } = await asUser
    .from("carts")
    .insert({ user_id: userId })
    .select("id")
    .single();
  if (!accountCart) throw new Error("no account cart");

  // Already in the account from another device: 1 of `shared`.
  await asUser.from("cart_items").insert({
    cart_id: accountCart.id,
    variant_id: shared.id,
    quantity: 1,
  });

  /* ── the merge ─────────────────────────────────────────────────────────── */
  const outcome = await mergeGuestCartIntoAccount(
    callbackClient(token, signUp.session.access_token),
    userId,
    token,
  );

  check("every guest line merged", outcome.merged === 4, `merged ${outcome.merged}, dropped ${outcome.dropped}`);
  check("the guest cart was consumed", outcome.guestCartConsumed);

  const { data: after } = await asUser
    .from("cart_items")
    .select("variant_id, quantity")
    .eq("cart_id", accountCart.id);

  const byVariant = new Map((after ?? []).map((l) => [l.variant_id, l.quantity]));

  check("all four lines are in the account bag", (after?.length ?? 0) === 4, `${after?.length ?? 0} lines`);
  check("a guest-only line kept its quantity", byVariant.get(b.id) === 2, `qty ${byVariant.get(b.id)}`);

  const expectedShared = Math.min(1 + 2, shared.stock_quantity, 10);
  check(
    "the line in both bags summed",
    byVariant.get(shared.id) === expectedShared,
    `1 + 2 -> ${byVariant.get(shared.id)} (stock ${shared.stock_quantity}, expected ${expectedShared})`,
  );

  /* ── the guest bag is gone, and unreachable ────────────────────────────── */
  const { data: leftovers } = await guest.from("carts").select("id").eq("id", guestCart.id);
  check("the guest cart no longer exists", (leftovers?.length ?? 0) === 0, `${leftovers?.length ?? 0} rows`);

  /* ── quantities cap at stock ───────────────────────────────────────────── */
  const token2 = randomUUID();
  const guest2 = guestClient(token2);
  const { data: cart2 } = await guest2.from("carts").insert({ guest_token: token2 }).select("id").single();
  if (!cart2) throw new Error("no second guest cart");

  const scarce = variants.reduce((min, v) => (v.stock_quantity < min.stock_quantity ? v : min));
  await guest2.from("cart_items").insert({
    cart_id: cart2.id,
    variant_id: scarce.id,
    quantity: Math.min(scarce.stock_quantity, 10),
  });

  const email2 = `fv-merge2.${Date.now().toString(36)}@example.com`;
  const { data: signUp2 } = await anon.auth.signUp({ email: email2, password: PASSWORD });
  if (!signUp2?.session) throw new Error("second signUp failed");
  const user2 = signUp2.user!.id;

  const asUser2 = createClient<Database>(URL_, ANON, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${signUp2.session.access_token}` } },
  });
  const { data: cartB } = await asUser2.from("carts").insert({ user_id: user2 }).select("id").single();
  await asUser2.from("cart_items").insert({
    cart_id: cartB!.id,
    variant_id: scarce.id,
    quantity: Math.min(scarce.stock_quantity, 10),
  });

  await mergeGuestCartIntoAccount(callbackClient(token2, signUp2.session.access_token), user2, token2);

  const { data: capped } = await asUser2
    .from("cart_items")
    .select("quantity")
    .eq("cart_id", cartB!.id)
    .eq("variant_id", scarce.id)
    .single();

  const ceiling = Math.min(scarce.stock_quantity, 10);
  check(
    "a summed quantity is capped at available stock",
    capped?.quantity === ceiling,
    `${ceiling} + ${ceiling} -> ${capped?.quantity} (stock ${scarce.stock_quantity})`,
  );

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
  console.log(`  (test accounts left behind: ${email}, ${email2})\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nHarness error:", error);
  process.exit(1);
});
