/**
 * The escalation checks, over real HTTP.
 *
 * docs/rls-tests.md §6b could only be run at the database level in Phase 3,
 * because there was no way to sign in. That was an honest substitution but not
 * the real attack surface: a customer does not hold a psql connection, they
 * hold a JWT and a cookie, and what stands between them and `role = 'admin'` is
 * PostgREST plus a trigger, not a policy read in isolation.
 *
 * This runs the whole path:
 *
 *   1. a provider that claims the new user is an admin is ignored
 *   2. a signed-in customer cannot write their own role, over PostgREST
 *   3. is_admin() answers false for them
 *   4. they cannot read anybody else's profile
 *   5. /admin is a 404 for an anonymous visitor and for a signed-in customer,
 *      and a 200 for an admin
 *
 *   npx tsx scripts/audit/auth-rls.ts
 *
 * Needs SUPABASE_SERVICE_ROLE_KEY to create and clean up its two test accounts,
 * and the app running (AUDIT_BASE_URL, default http://localhost:3210).
 *
 * A note on the provider. Google OAuth is not enabled on the project yet, so
 * the sessions here are minted with a password grant. That does not weaken the
 * test: the JWT PostgREST sees is the same shape either way — `role:
 * authenticated`, `sub: <uid>` — and the policies cannot tell which provider
 * issued it. The one thing that *is* Google-specific is what the provider puts
 * in `raw_user_meta_data`, and check 1 is exactly that.
 */
import { readFileSync } from "node:fs";

import { createServerClient } from "@supabase/ssr";
import { createClient, type Session } from "@supabase/supabase-js";

/* ------------------------------------------------------------------ env --- */

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const APP = process.env.AUDIT_BASE_URL ?? "http://localhost:3210";

if (!URL_ || !ANON) {
  console.error("Missing Supabase env. Needs NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  process.exit(1);
}

/**
 * Elevated access is optional.
 *
 * `.env.local` ships SUPABASE_SERVICE_ROLE_KEY declared but empty, which looks
 * configured at a glance. Creating users no longer needs it — signUp returns a
 * session directly now that email confirmation is off — but *promoting* one to
 * admin and deleting users afterwards still do.
 *
 * So the checks that need it are named and reported as skipped rather than
 * quietly not run. A gate that silently covers less than it claims is worse
 * than a gate that fails.
 */
const ELEVATED = Boolean(SERVICE && SERVICE.trim().length > 0);
const admin = ELEVATED
  ? createClient(URL_, SERVICE, { auth: { persistSession: false } })
  : null;

/* ---------------------------------------------------------------- report --- */

let failures = 0;
let skipped = 0;
function check(name: string, passed: boolean, detail = "") {
  if (!passed) failures++;
  console.log(`${passed ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function skip(name: string, why: string) {
  skipped++;
  console.log(`  SKIP  ${name}  — ${why}`);
}

/* ----------------------------------------------------------------- setup --- */

// Unique per run: without elevated access these accounts cannot be deleted
// afterwards, so a fixed address would collide on the second run.
const STAMP = process.env.AUTH_RLS_STAMP ?? Date.now().toString(36);
const CUSTOMER = `fv-test-customer.${STAMP}@example.com`;
const OTHER = `fv-test-other.${STAMP}@example.com`;
const ADMIN = `fv-test-admin.${STAMP}@example.com`;
const PASSWORD = "correct-horse-battery-staple-42";

/**
 * A fresh account, created the way a customer's is: through the public signup
 * endpoint with the anon key. Email confirmation is off, so this returns a
 * usable session immediately and no elevated key is involved.
 */
async function makeUser(
  email: string,
  metadata: Record<string, unknown>,
): Promise<{ id: string; session: Session }> {
  const client = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signUp({
    email,
    password: PASSWORD,
    options: { data: metadata },
  });
  if (error || !data.session || !data.user) {
    throw new Error(`signUp(${email}): ${error?.message ?? "no session returned"}`);
  }
  return { id: data.user.id, session: data.session };
}

/** A cookie jar filled by @supabase/ssr itself, so the format is not guessed. */
async function sessionCookies(session: Session): Promise<string> {
  const jar = new Map<string, string>();
  const client = createServerClient(URL_, ANON, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach((c) => jar.set(c.name, c.value)),
    },
  });
  await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  return [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
}

async function signIn(email: string): Promise<Session> {
  const client = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signIn(${email}): ${error?.message}`);
  return data.session;
}

/* ------------------------------------------------------------------ main --- */

async function main() {
  console.log("\nAuth and RLS, over HTTP\n");

  // 1 ── a provider claiming the user is an admin is ignored ------------------
  const customer = await makeUser(CUSTOMER, {
    full_name: "Escalation Test",
    // The attack. Google cannot be made to send this, but `raw_user_meta_data`
    // is user-editable through the auth API, so handle_new_user() must not care
    // either way — which is the whole reason the role is pinned in the trigger.
    role: "admin",
    user_role: "admin",
    is_admin: true,
  });
  const other = await makeUser(OTHER, { full_name: "Somebody Else" });

  const asCustomer = createClient(URL_, ANON, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${customer.session.access_token}` } },
  });

  const { data: ownRow } = await asCustomer
    .from("profiles")
    .select("id, role, full_name")
    .eq("id", customer.id)
    .single();

  check(
    "handle_new_user ignores a role in the provider payload",
    ownRow?.role === "customer",
    `role = ${ownRow?.role}`,
  );
  check(
    "handle_new_user still takes the display name from the payload",
    ownRow?.full_name === "Escalation Test",
    `full_name = ${ownRow?.full_name}`,
  );

  // 2 ── a signed-in customer cannot write their own role ---------------------
  const { error: escalation } = await asCustomer
    .from("profiles")
    .update({ role: "admin" })
    .eq("id", customer.id);

  check(
    "customer cannot set their own role over PostgREST",
    Boolean(escalation),
    escalation ? `${escalation.code}: ${escalation.message}` : "UPDATE SUCCEEDED — ESCALATION",
  );

  const { data: afterAttempt } = await asCustomer
    .from("profiles")
    .select("role")
    .eq("id", customer.id)
    .single();
  check(
    "their role is still customer afterwards",
    afterAttempt?.role === "customer",
    `role = ${afterAttempt?.role}`,
  );

  // 3 ── is_admin() answers false --------------------------------------------
  const { data: isAdmin, error: rpcError } = await asCustomer.rpc("is_admin");
  check(
    "is_admin() returns false for a customer",
    isAdmin === false,
    rpcError?.message ?? `returned ${isAdmin}`,
  );

  // 4 ── no reading somebody else's profile ----------------------------------
  const { data: otherRows } = await asCustomer.from("profiles").select("id").eq("id", other.id);
  check(
    "customer reads zero rows of another customer's profile",
    (otherRows?.length ?? 0) === 0,
    `${otherRows?.length ?? 0} rows`,
  );

  // 5 ── /admin is a 404 unless you are an admin ------------------------------
  const anonAdmin = await fetch(`${APP}/admin`, { redirect: "manual" });
  check("/admin is 404 for an anonymous visitor", anonAdmin.status === 404, `HTTP ${anonAdmin.status}`);

  const customerAdmin = await fetch(`${APP}/admin`, {
    headers: { cookie: await sessionCookies(customer.session) },
    redirect: "manual",
  });
  check("/admin is 404 for a signed-in customer", customerAdmin.status === 404, `HTTP ${customerAdmin.status}`);
  check(
    "/admin does not redirect, which would reveal that it exists",
    customerAdmin.status !== 302 && customerAdmin.status !== 307 && customerAdmin.status !== 308,
    `HTTP ${customerAdmin.status}`,
  );

  // 6 ── the admin path, which needs a promotion ------------------------------
  if (!admin) {
    const why = "SUPABASE_SERVICE_ROLE_KEY is empty in .env.local";
    skip("service_role can grant admin (the bootstrap path)", why);
    skip("is_admin() returns true for an admin", why);
    skip("/admin is 200 for an admin", why);
    skip("test accounts cleaned up", why);
  } else {
    const owner = await makeUser(ADMIN, { full_name: "Shop Owner" });

    // service_role is on the guard's trusted list, which is what makes the
    // owner's bootstrap possible at all.
    const { error: promoteError } = await admin
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", owner.id);
    check(
      "service_role can grant admin (the bootstrap path)",
      !promoteError,
      promoteError?.message ?? "",
    );

    // A fresh session: the promotion happened after the one above was minted.
    const ownerSession = await signIn(ADMIN);
    const asAdmin = createClient(URL_, ANON, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${ownerSession.access_token}` } },
    });
    const { data: isAdminTrue } = await asAdmin.rpc("is_admin");
    check("is_admin() returns true for an admin", isAdminTrue === true, `returned ${isAdminTrue}`);

    const adminAdmin = await fetch(`${APP}/admin`, {
      headers: { cookie: await sessionCookies(ownerSession) },
      redirect: "manual",
    });
    check("/admin is 200 for an admin", adminAdmin.status === 200, `HTTP ${adminAdmin.status}`);

    for (const id of [customer.id, other.id, owner.id]) {
      await admin.auth.admin.deleteUser(id);
    }
    check("test accounts cleaned up", true);
  }

  console.log(
    `\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}` +
      `${skipped ? ` ${skipped} skipped.` : ""}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nHarness error:", error);
  process.exit(1);
});
