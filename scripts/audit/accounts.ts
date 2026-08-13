/**
 * How every audit harness gets an account with a real session.
 *
 * ## Why this is its own module
 *
 * It was eight copies of the same twelve lines. `fixtures.ts`,
 * `server-actions.ts`, `auth-rls.ts`, `signed-in.ts`, `admin-security.ts`,
 * `cart-merge.ts`, `checkout-orders.ts` and `security-checkout.ts` each called
 * `anon.auth.signUp({ email, password })` and each carried its own comment
 * explaining that email confirmation was off so a session came back directly.
 *
 * Then staging turned email signups off — the correct posture for a deployed
 * project, and the thing `audit:signup-closed` exists to assert — and all eight
 * died at once with "Email signups are disabled". Six of them are live gates in
 * `run-all`. The suite could not create a single account, and the failure
 * reads as infrastructure flakiness rather than as a missing test, which is how
 * it survives a triage.
 *
 * **A gate whose liveness depends on a security control being disabled is not a
 * gate.** It goes dark the next time somebody does the right thing. So the
 * mechanism lives here, once, and it does not touch the public auth surface.
 *
 * ## How it works instead
 *
 *   1. `auth.admin.createUser` with `email_confirm` — service-role, so no
 *      signup toggle is consulted. The `profiles` trigger fires exactly as it
 *      does for a real customer, so `role` defaults to `customer` and the admin
 *      promotions some harnesses do still work.
 *   2. `auth.admin.generateLink` — mints a one-time token and hands it back
 *      instead of sending mail. No inbox, no Resend call, nothing to poll.
 *   3. `verifyOtp` on an anon client — redeems it for a genuine session.
 *
 * The session is real: access and refresh tokens signed by the project,
 * indistinguishable to PostgREST and to the app's cookie reader from one a
 * customer signed in for. That matters, because these accounts are the input to
 * security gates — a hand-signed JWT would prove something about a forgery
 * rather than about a customer.
 *
 * Verified against a project with **both** signup and email login disabled,
 * which is the state staging is actually in.
 *
 * ## No password
 *
 * Nothing can sign in with one on this project, so a password would be a
 * hardcoded credential in the repository buying nothing. The four harnesses
 * that used to keep a `PASSWORD` constant no longer need one.
 *
 * The clients come from `./clients`, whose factories refuse to point at the
 * live shop, so importing this module cannot mint an account in production.
 */
import type { Session } from "@supabase/supabase-js";

import { adminClient, anonClient, QA_EMAIL_PREFIX } from "./clients";

export type Account = { email: string; userId: string; session: Session };

/**
 * Mint an account at an exact address.
 *
 * Harnesses that sweep on their own email prefix (`fv-merge.`, `fv-secact.`,
 * `fv-admin-probe.`) call this and keep their prefix; `createAccount` below is
 * the convenience wrapper for everything using the shared QA prefix.
 */
export async function createAccountWithEmail(
  email: string,
  metadata: Record<string, unknown> = {},
): Promise<Account> {
  const admin = adminClient();

  const { data: created, error: createError } =
    await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: metadata,
    });
  if (createError || !created.user) {
    throw new Error(
      `could not create ${email}: ${createError?.message ?? "no user"}`,
    );
  }

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const tokenHash = link?.properties?.hashed_token;
  if (linkError || !tokenHash) {
    throw new Error(
      `could not mint a login token for ${email}: ${
        linkError?.message ?? "no hashed_token"
      }`,
    );
  }

  const { data: verified, error: verifyError } =
    await anonClient().auth.verifyOtp({
      token_hash: tokenHash,
      type: "magiclink",
    });
  if (verifyError || !verified.session) {
    throw new Error(
      `could not open a session for ${email}: ${
        verifyError?.message ?? "no session"
      }`,
    );
  }

  return { email, userId: created.user.id, session: verified.session };
}

/**
 * A fresh session for an account that already exists.
 *
 * The service-role equivalent of signing in again, for the harnesses that want
 * a *second* session for the same identity — `auth-rls.ts` uses one to prove
 * that a new sign-in sees the same RLS-scoped rows. `signInWithPassword` cannot
 * do this on a project with email logins disabled, which staging has.
 */
export async function openSession(email: string): Promise<Session> {
  const { data: link, error: linkError } = await adminClient()
    .auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link?.properties?.hashed_token;
  if (linkError || !tokenHash) {
    throw new Error(
      `could not mint a login token for ${email}: ${
        linkError?.message ?? "no hashed_token"
      }`,
    );
  }
  const { data: verified, error: verifyError } =
    await anonClient().auth.verifyOtp({
      token_hash: tokenHash,
      type: "magiclink",
    });
  if (verifyError || !verified.session) {
    throw new Error(
      `could not re-open a session for ${email}: ${
        verifyError?.message ?? "no session"
      }`,
    );
  }
  return verified.session;
}

/** A throwaway account under the shared QA prefix, which teardown sweeps. */
export async function createAccount(
  label: string,
  options: { prefix?: string; metadata?: Record<string, unknown> } = {},
): Promise<Account> {
  const prefix = options.prefix ?? QA_EMAIL_PREFIX;
  return createAccountWithEmail(
    `${prefix}${label}.${Date.now().toString(36)}@example.com`,
    options.metadata ?? { full_name: "Quality Runner" },
  );
}
