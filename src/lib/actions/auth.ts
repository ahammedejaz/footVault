"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { SITE_URL } from "@/lib/env";
import { safeNext } from "@/lib/safe-redirect";
import { createClient } from "@/lib/supabase/server";

/**
 * Signing in, and signing out. Google only.
 *
 * There is no email/password form, no registration, no password reset and no
 * forgotten-password flow — not disabled, not hidden, absent. Every one of them
 * is a surface that has to be secured, rate-limited and supported, and a shop
 * this size gets nothing for it that "continue with Google" does not already
 * give: no password to leak, no reset email to deliver, no inbox to be locked
 * out of.
 *
 * Signing in is never a wall in front of buying. A guest can fill a bag and
 * check out; an account is what makes the bag survive a new phone, and what
 * a wishlist and an order history hang off.
 */

/**
 * The origin this request actually arrived on.
 *
 * Vercel gives every preview deployment its own hostname, so a redirect built
 * from a build-time environment variable sends every preview's sign-in back to
 * production. Reading the forwarded host keeps localhost, previews and
 * production all working from one deploy.
 *
 * `x-forwarded-host` is attacker-controlled in principle. It is not a hole
 * here: the value only shapes a redirect URL that Supabase itself refuses
 * unless it is on the project's allow-list, so a forged host fails there rather
 * than sending anyone anywhere.
 */
async function currentOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return SITE_URL;
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * The state a sign-in form carries back when the round trip could not start.
 *
 * On success this action never returns — it redirects to Google — so `error`
 * being null after a submit means the redirect is in flight, not that it
 * succeeded.
 */
export type SignInState = { error: string | null };

export const SIGN_IN_IDLE: SignInState = { error: null };

/**
 * Start the Google round trip.
 *
 * Form-shaped rather than a plain call so the button can be a real `<form>`:
 * it submits without JavaScript, and `useActionState` gives the failure
 * somewhere visible to land instead of a console nobody is reading.
 *
 * `next` is where the customer was standing when they clicked. It is validated
 * here and again on the way back, because in between it travels through two
 * systems that are not ours.
 */
export async function signInWithGoogle(
  _previous: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const next = safeNext(String(formData.get("next") ?? "/"));
  const supabase = await createClient();
  const origin = await currentOrigin();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });

  if (error || !data?.url) {
    // By far the most common cause is the provider not being enabled on the
    // Supabase project, which is a setup problem rather than a customer
    // problem — so the copy points at shopping on, not at trying again.
    console.error("[auth] signInWithOAuth failed:", error?.message ?? "no redirect URL");
    return {
      error: "Google sign-in is unavailable right now. You can keep shopping as a guest.",
    };
  }

  redirect(data.url);
}

/** Sign out, and stay where you are. */
export async function signOut(formData: FormData): Promise<void> {
  const next = safeNext(String(formData.get("next") ?? "/"));
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();
  if (error) console.error("[auth] signOut failed:", error.message);
  redirect(next);
}
