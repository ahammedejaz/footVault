import "server-only";

import { cookies } from "next/headers";
import { z } from "zod";

/**
 * The thing the customer was trying to do when we asked them to sign in.
 *
 * Tapping a heart while signed out has to end with the shoe saved, not with
 * the customer back on the product page wondering whether it worked. The
 * problem is that the round trip leaves our origin entirely — Google's consent
 * screen, then back — so the intent has to survive a redirect chain we do not
 * control.
 *
 * A cookie carries it. Not the `next` URL: a URL that performs a mutation on
 * arrival is a URL that performs it again on refresh, on a back button, and on
 * anything that prefetches it. A cookie is read once and deleted, which is the
 * shape a one-off action wants.
 *
 * Short-lived on purpose. This is a breadcrumb for the next few seconds of one
 * sign-in, not a queue; ten minutes is generous for a consent screen and short
 * enough that an abandoned attempt does not act on somebody a week later.
 */

export const PENDING_INTENT_COOKIE = "fv_intent";

const TEN_MINUTES = 60 * 10;

/**
 * Deliberately a closed set. The callback executes whatever this decodes to, so
 * it must not be able to decode to anything that was not designed here.
 */
export const pendingIntentSchema = z.object({
  kind: z.literal("save"),
  productId: z.uuid(),
});

export type PendingIntent = z.infer<typeof pendingIntentSchema>;

export async function writePendingIntent(intent: PendingIntent): Promise<void> {
  const store = await cookies();
  store.set(PENDING_INTENT_COOKIE, JSON.stringify(intent), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: TEN_MINUTES,
  });
}

/**
 * Read it, and forget it in the same breath.
 *
 * Clearing on read rather than after acting is deliberate: if the action fails,
 * the right outcome is a customer who is signed in and can press the heart
 * again, not a cookie that retries a failing write on every subsequent
 * sign-in.
 */
export async function takePendingIntent(): Promise<PendingIntent | null> {
  const store = await cookies();
  const raw = store.get(PENDING_INTENT_COOKIE)?.value;
  if (!raw) return null;

  store.delete(PENDING_INTENT_COOKIE);

  try {
    const parsed = pendingIntentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    // A cookie we did not write, or one that was tampered with. Nothing to do
    // and nothing worth reporting.
    return null;
  }
}
