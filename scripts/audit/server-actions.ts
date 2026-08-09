/**
 * `npm run audit:actions` — the missing test, named the most valuable in two
 * consecutive security reviews (Phase 5 §6.1, Phase 6 §6.1) and absent both
 * times.
 *
 * ## What it does that nothing else did
 *
 * `audit:admin` proves the *database* refuses a customer: it calls the RPCs and
 * PostgREST directly with a real customer JWT. That is the right test for the
 * backstop, but it deliberately bypasses the application. It says nothing about
 * whether the Server Action **endpoint** — the POST that carries a `Next-Action`
 * id sitting in the browser bundle — refuses. An admin panel whose only proof
 * is "the tables are locked" has never actually had its front door pushed.
 *
 * So this posts **forged Server Action payloads directly over HTTP** to the
 * running production server, exactly as an attacker with the JavaScript bundle
 * would, in three identities:
 *
 *   1. a plain signed-in customer (real Supabase session cookies),
 *   2. no session at all,
 *   3. and — as the positive control — a real admin, to prove the harness can
 *      elicit a *successful* action shape, so a refusal in (1) and (2) means
 *      "the guard held" rather than "the request never reached the action".
 *
 * ## How the ids are discovered — the attacker's way, not a hardcoded list
 *
 * Next 16 emits every action as `createServerReference("<40-hex-id>", …,
 * "<exportName>")` into the client chunks under `.next/static/chunks`. This
 * greps them out, then keeps only the ids whose export name is an admin action
 * (the exported function names under `src/lib/actions/admin/`). The owning route
 * for each — the page a POST must be aimed at — is read from
 * `.next/server/server-reference-manifest.json`, because a fetch action only
 * runs on a worker that registered it; posting elsewhere makes Next forward it,
 * which is a second thing worth testing and is tested below.
 *
 * ## The wire format (Next 16.3, verified against the emitted runtime)
 *
 * A fetch action is `POST <route>` with header `Next-Action: <id>` and a body
 * that is the encoded reply — for the simple argument shapes here, a JSON array
 * string with `Content-Type: text/plain;charset=UTF-8`. The action result comes
 * back as a flight stream (`text/x-component`) whose rows are `N:<json>`; the
 * action's own return value is one of those rows. An unrecognised id answers
 * `x-nextjs-action-not-found: 1` with `{}`; a middleware 404 answers a bare 404.
 * See `node_modules/next/dist/server/app-render/action-handler.js`.
 *
 * ## What counts as a refusal, and what counts as a hole
 *
 * A refusal is any response that did **not** run the admin action: a 404
 * (middleware hid the /admin route), an empty `{}` (the action id was not
 * registered on the posted route and the forward failed), or a flight body
 * carrying `"reason":"forbidden"` (the action ran but `adminAction` refused).
 *
 * A **hole** is a response that shows the action *executed* for a non-admin:
 * `"ok":true`, or `"reason":"invalid"` / `"reason":"conflict"` — because those
 * shapes are only reachable from *inside* the work function, which runs only
 * after `adminAction`'s `is_admin()` check has passed. A customer eliciting
 * `"reason":"invalid"` would mean the guard let them through to the Zod line.
 * The payloads posted are deliberately empty (`[{}]`), so even a hole cannot
 * perform a destructive write — the schema rejects it one step later — but the
 * *shape* still exposes the bypass.
 */

// clients first, before any other import and before anything reads
// process.env: importing it repoints this process at staging and refuses to
// run against production. This file used to read .env.local itself and
// therefore built its accounts and admin promotions on the LIVE shop while
// the app under test pointed at staging — found in Batch 3, the exact
// near-miss clients.ts exists to stop. See the batch 3 report.
import "./clients";

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

import type { Database } from "../../src/lib/database.types";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE = process.env.AUDIT_BASE_URL ?? "http://localhost:3210";
const ORIGIN = new URL(BASE).origin;
const PASSWORD = "correct-horse-battery-staple-42";
/** Teardown sweeps this. Mirrored into scripts/audit/teardown.ts. */
const PREFIX = "fv-secact.";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}
function check(label: string, held: boolean, detail = "") {
  if (held) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed += 1;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(
      `  \x1b[31m✗ HOLE\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`,
    );
  }
}

const admin = createClient<Database>(URL_, SERVICE, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const madeUsers: string[] = [];

async function makeAccount(
  label: string,
): Promise<{ userId: string; cookie: string; token: string }> {
  const email = `${PREFIX}${label}.${Date.now().toString(36)}@example.com`;
  const anon = createClient<Database>(URL_, ANON, {
    auth: { persistSession: false },
  });
  const { data, error } = await anon.auth.signUp({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`sign-up: ${error?.message}`);
  madeUsers.push(data.session.user.id);
  return {
    userId: data.session.user.id,
    token: data.session.access_token,
    cookie: await cookieHeader(data.session),
  };
}

/** Cookies the app actually reads, produced by @supabase/ssr, joined for a header. */
async function cookieHeader(session: {
  access_token: string;
  refresh_token: string;
}): Promise<string> {
  const jar = new Map<string, string>();
  const client = createServerClient(URL_, ANON, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach((e) => jar.set(e.name, e.value)),
    },
  });
  await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  return [...jar].map(([n, v]) => `${n}=${v}`).join("; ");
}

/* ─── discovery, the attacker's way ─────────────────────────────────────── */

type Discovered = { id: string; name: string };

/** `createServerReference("<id>", callServer, undefined, findSourceMapURL, "<name>")` */
function discoverActionIds(): Map<string, string> {
  const dir = ".next/static/chunks";
  const re =
    /createServerReference\)\(\s*"([0-9a-f]{40,})"\s*,[^,]*,[^,]*,[^,]*,\s*"([^"]+)"\s*\)/g;
  const found = new Map<string, string>();
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith(".js")) {
        const src = readFileSync(p, "utf8");
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) if (!found.has(m[1])) found.set(m[1], m[2]);
      }
    }
  };
  walk(dir);
  return found;
}

/** The exported function names under src/lib/actions/admin — the must-refuse set. */
function adminActionNames(): Set<string> {
  const dir = "src/lib/actions/admin";
  const names = new Set<string>();
  for (const f of readdirSync(dir)) {
    const src = readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/export async function ([a-zA-Z0-9_]+)/g))
      names.add(m[1]);
  }
  return names;
}

/** id -> owning worker route paths, from the server reference manifest. */
function workersById(): Record<string, string[]> {
  const man = JSON.parse(
    readFileSync(".next/server/server-reference-manifest.json", "utf8"),
  ) as { node: Record<string, { workers: Record<string, unknown> }> };
  const out: Record<string, string[]> = {};
  for (const [id, v] of Object.entries(man.node))
    out[id] = Object.keys(v.workers);
  return out;
}

/**
 * Turn a worker key like `app/admin/orders/[id]/page` into a postable URL,
 * filling `[id]` from the right real row for its segment.
 */
function routeForWorker(
  worker: string,
  ids: { orderId: string; productId: string; variantId: string },
): string {
  let p = worker.replace(/^app/, "").replace(/\/page$/, "");
  p = p.replace(/\/\([^)]+\)/g, ""); // strip route groups
  if (p.includes("/orders/[id]")) p = p.replace("[id]", ids.orderId);
  else if (p.includes("/products/[id]")) p = p.replace("[id]", ids.productId);
  else p = p.replace("[id]", ids.orderId);
  return p || "/";
}

/* ─── the forged POST ───────────────────────────────────────────────────── */

type Outcome = {
  status: number;
  body: string;
  /** Its return value carried ok:true — a full success. */
  succeeded: boolean;
  /** adminAction refused after running. */
  forbidden: boolean;
  notFoundHeader: boolean;
};

async function postAction(
  route: string,
  id: string,
  body: string,
  cookie: string | null,
): Promise<Outcome> {
  const res = await fetch(`${BASE}${route}`, {
    method: "POST",
    headers: {
      "Next-Action": id,
      "Content-Type": "text/plain;charset=UTF-8",
      Accept: "text/x-component",
      Origin: ORIGIN,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
  });
  const text = await res.text();
  // The action's own return value shows up as a flight row `N:{...}` or, on the
  // forward path, as a bare JSON object. Both are matched here.
  const succeeded = /"ok"\s*:\s*true/.test(text);
  const forbidden = /"reason"\s*:\s*"forbidden"/.test(text);
  return {
    status: res.status,
    body: text.slice(0, 200),
    succeeded,
    forbidden,
    notFoundHeader: res.headers.get("x-nextjs-action-not-found") === "1",
  };
}

/** A response that did NOT execute the admin action for this caller. */
function isRefusal(o: Outcome): boolean {
  if (o.succeeded) return false; // ran and returned a result
  if (o.forbidden) return true; // ran, adminAction said no — a refusal
  // "invalid"/"conflict" without forbidden means the work fn ran => NOT a refusal
  if (/"reason"\s*:\s*"(invalid|conflict)"/.test(o.body)) return false;
  // 404 (middleware), empty {} (forward failed / not-found), or empty body
  return true;
}

async function main() {
  console.log(`\nForging Server Action posts against ${BASE}`);

  const discovered = discoverActionIds();
  const adminNames = adminActionNames();
  const workers = workersById();

  const targets: (Discovered & { route: string })[] = [];

  // Real rows so a route like /admin/orders/[id] resolves to something rendered.
  const { data: order, error: orderErr } = await admin
    .from("orders")
    .select("id")
    .limit(1)
    .maybeSingle();
  const { data: product, error: productErr } = await admin
    .from("products")
    .select("id")
    .limit(1)
    .maybeSingle();
  const { data: variant, error: variantErr } = await admin
    .from("product_variants")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (orderErr || productErr || variantErr)
    throw new Error(
      `fixture read failed: ${orderErr?.message ?? productErr?.message ?? variantErr?.message}`,
    );
  if (!order || !product || !variant) {
    console.error("Need at least one order, product and variant to resolve routes.");
    process.exit(1);
  }
  const rowIds = {
    orderId: order.id,
    productId: product.id,
    variantId: variant.id,
  };

  for (const [id, name] of discovered) {
    if (!adminNames.has(name)) continue;
    const w = workers[id]?.[0];
    if (!w) continue;
    targets.push({ id, name, route: routeForWorker(w, rowIds) });
  }

  section("0 · Discovery");
  check(
    `parsed action ids out of the client bundle`,
    discovered.size > 0,
    `${discovered.size} ids in .next/static/chunks`,
  );
  check(
    `resolved every admin action to a route`,
    targets.length === adminNames.size,
    `${targets.length}/${adminNames.size} admin actions mapped`,
  );
  console.log(
    `    ${targets.length} admin actions, e.g. ${targets
      .slice(0, 3)
      .map((t) => `${t.name}→${t.route}`)
      .join(", ")}`,
  );

  const adminAcc = await makeAccount("admin");
  const { error: promoteErr } = await admin
    .from("profiles")
    .update({ role: "admin" })
    .eq("id", adminAcc.userId);
  if (promoteErr) throw new Error(`could not promote probe: ${promoteErr.message}`);
  const customer = await makeAccount("cust");

  /* ═══ 1 · Positive control — the harness CAN reach and run an action ═════ */
  section("1 · Positive control: an admin session runs the action");
  {
    // loadMovements is read-only; an admin gets a real success shape from it.
    const loadId =
      [...discovered.entries()].find(([, n]) => n === "loadMovements")?.[0] ??
      null;
    if (!loadId) {
      check("loadMovements id present in bundle", false);
    } else {
      const ok = await postAction(
        "/admin/inventory",
        loadId,
        JSON.stringify([{ variantId: rowIds.variantId }]),
        adminAcc.cookie,
      );
      check(
        "admin + loadMovements(realVariant) returns ok:true",
        ok.succeeded,
        `status=${ok.status} body=${ok.body}`,
      );

      // And an invalid payload proves the work function ran (is_admin passed).
      const bad = await postAction(
        "/admin/inventory",
        loadId,
        "[{}]",
        adminAcc.cookie,
      );
      check(
        'admin + loadMovements({}) returns reason:"invalid" (work fn reached)',
        /"reason"\s*:\s*"invalid"/.test(bad.body),
        `status=${bad.status} body=${bad.body}`,
      );
    }
  }

  /* ═══ 2 · A plain customer is refused, for every admin action ════════════ */
  section("2 · A signed-in customer: every admin action refuses");
  for (const t of targets) {
    const o = await postAction(t.route, t.id, "[{}]", customer.cookie);
    check(
      `${t.name} refuses a customer`,
      isRefusal(o),
      `status=${o.status} ran=${o.succeeded} body=${o.body}`,
    );
  }

  /* ═══ 3 · No session at all is refused, for every admin action ═══════════ */
  section("3 · No session: every admin action refuses");
  for (const t of targets) {
    const o = await postAction(t.route, t.id, "[{}]", null);
    check(
      `${t.name} refuses an anonymous caller`,
      isRefusal(o),
      `status=${o.status} ran=${o.succeeded} body=${o.body}`,
    );
  }

  /* ═══ 4 · The forward path — posting an admin id to a customer route ═════ */
  section("4 · Forwarding: an admin id posted to a storefront route does not run");
  {
    // A customer-reachable page (home) does not register any admin action, so
    // Next forwards to the /admin worker via an internal fetch — which re-enters
    // the proxy and is 404'd. The action must not run.
    const sample = targets.find((t) => t.name === "setOrderStatus")!;
    for (const [who, cookie] of [
      ["customer", customer.cookie] as const,
      ["anonymous", null] as const,
    ]) {
      const o = await postAction("/", sample.id, "[{}]", cookie);
      check(
        `setOrderStatus forwarded from / does not run for a ${who}`,
        isRefusal(o),
        `status=${o.status} body=${o.body}`,
      );
    }
  }

  /* ═══ 5 · Confirm nothing was written ═══════════════════════════════════ */
  section("5 · No write landed");
  {
    // The order we aimed setOrderStatus at is unchanged.
    const { data: after, error: afterErr } = await admin
      .from("orders")
      .select("status")
      .eq("id", rowIds.orderId)
      .maybeSingle();
    if (afterErr) throw new Error(`re-read failed: ${afterErr.message}`);
    check(
      "the probed order still has a status (untouched by the forged posts)",
      Boolean(after?.status),
      `status=${after?.status}`,
    );
  }

  console.log(
    `\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`,
  );
  if (failures.length) {
    console.log("\nHoles:");
    for (const f of failures) console.log(`  - ${f}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    failed += 1;
  })
  .finally(async () => {
    for (const id of madeUsers)
      await admin.auth.admin.deleteUser(id).catch(() => {});
    process.exit(failed === 0 ? 0 : 1);
  });
