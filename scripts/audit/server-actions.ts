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
 * ## What this gate does and does not currently prove — read this first
 *
 * It proves the **route-hiding** layer. It does not, as shipped, exercise
 * `adminAction`, and that was discovered the only way such a thing can be:
 * Stage 2 deleted the `is_admin()` check from `adminAction`, rebuilt, and ran
 * this gate, which reported *127 passed, 0 failed*.
 *
 * The cause is that the proxy 404s `/admin/*` for a non-admin, so the worker
 * never loads, so the action id is never registered, so the POST dies at
 * `x-nextjs-action-not-found` without touching application code. No admin
 * action is registered on a route a non-admin can load — 0 of 60, checked
 * against the server reference manifest — so there is no HTTP vector past that
 * proxy. The layer tally printed at the end of every run makes this visible
 * instead of leaving it to a comment.
 *
 * With the proxy's hiding disabled, this gate produced **122 holes** against
 * the removed guard and **0** against the restored one, so it discriminates
 * perfectly once requests can reach the action. The two-layer procedure is in
 * docs/staging.md §4.4 and is the way to re-prove `adminAction` deliberately.
 *
 * ## What counts as a refusal, and what counts as a hole
 *
 * A refusal is any response that did **not** run the admin action: a 404
 * (the proxy hid the /admin route), an empty `{}` (the action id was not
 * registered on the posted route and the forward failed), or a flight body
 * carrying `"reason":"forbidden"` (the action ran but `adminAction` refused).
 * `classify()` keeps those two cases apart rather than merging them.
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

/*
  `./fixtures`, not `./clients`, and that is a fix rather than a tidy-up.

  This file used to import `./clients` for its side effect, with a comment
  saying that doing so "repoints this process at staging and refuses to run
  against production." Half of that was true. `clients.ts` repoints; it does not
  refuse. The refusal lives in `fixtures.ts`, which calls `assertNotProduction`
  at module scope — and this harness did not import it.

  So with `AUDIT_TARGET=env-local`, or on any checkout where `SUPABASE_STAGE_*`
  is unset and resolution falls back to `.env.local`, this file would have
  created accounts and promoted one of them to **admin** on the live shop, with
  nothing raising an objection. It satisfied `audit:fixtures-guard` the whole
  time, because that gate asked whether a harness imports the chokepoint rather
  than whether it is actually guarded.

  Importing `./fixtures` is the instance fix. The class fix is in `clients.ts`,
  where the client factories themselves now refuse, and in `fixtures-guard.ts`,
  which now proves that rather than proving an import exists.
*/
import {
  adminClient,
  anonKey,
  createAccount,
  supabaseUrl,
} from "./fixtures";

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { createServerClient } from "@supabase/ssr";

const BASE = process.env.AUDIT_BASE_URL ?? "http://localhost:3210";
const ORIGIN = new URL(BASE).origin;
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

const admin = adminClient();
const madeUsers: string[] = [];

/**
 * A probe identity with a real session.
 *
 * Delegates to the shared `createAccount`, which mints through the service-role
 * admin API rather than `signUp`. This harness used to roll its own sign-up —
 * one of eight copies of the same twelve lines across `scripts/audit/`, all of
 * which stopped working on the day staging disabled email signups.
 */
async function makeAccount(
  label: string,
): Promise<{ userId: string; cookie: string; token: string }> {
  const account = await createAccount(label, { prefix: PREFIX });
  madeUsers.push(account.userId);
  return {
    userId: account.userId,
    token: account.session.access_token,
    cookie: await cookieHeader(account.session),
  };
}

/** Cookies the app actually reads, produced by @supabase/ssr, joined for a header. */
async function cookieHeader(session: {
  access_token: string;
  refresh_token: string;
}): Promise<string> {
  const jar = new Map<string, string>();
  const client = createServerClient(supabaseUrl(), anonKey(), {
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

/**
 * Which layer stopped this request — not merely whether something did.
 *
 * ## Why this distinction is the whole point, and why it was missing
 *
 * This gate used to answer one question: "did the admin action run?" Anything
 * that was not a success counted as "the guard held". That reading is wrong,
 * and Stage 2 proved it wrong by experiment: `adminAction`'s `is_admin()` check
 * was **deleted**, the tree rebuilt, and this gate still reported *127 passed,
 * 0 failed*. A gate that cannot notice the removal of the thing it is named
 * after is not yet a gate.
 *
 * The reason is that two different layers refuse, and they are not
 * interchangeable:
 *
 *   - **route-hidden** — the proxy (`src/lib/supabase/proxy.ts`) 404s `/admin/*`
 *     for a non-admin, so the route's worker never loads, so the action id is
 *     never registered, so Next answers `x-nextjs-action-not-found`. The
 *     request never reaches application code at all.
 *   - **guard-refused** — the request *did* reach `adminAction`, which returned
 *     `reason:"forbidden"`. This is the layer this file is named for.
 *
 * Under the shipped configuration every customer and anonymous refusal is
 * `route-hidden`, because no admin action is registered on a route a non-admin
 * can load (verified: 0 of 60). That is genuinely good defence — but it means
 * this gate is currently blind to `adminAction`, and saying so on every run is
 * better than a comment claiming coverage it does not have.
 *
 * With the proxy's hiding disabled, the same run produced **122 holes** against
 * the removed guard and **0** against the restored one, so the discrimination is
 * real — it is the proxy in front that keeps it from being exercised. The
 * procedure is in docs/staging.md §4.4.
 */
type RefusalKind = "ran" | "guard-refused" | "route-hidden" | "unattributed";

function classify(o: Outcome): RefusalKind {
  // Ran to completion, or reached the work function past the guard. Both mean
  // the action executed for this caller.
  if (o.succeeded) return "ran";
  if (/"reason"\s*:\s*"(invalid|conflict)"/.test(o.body) && !o.forbidden)
    return "ran";
  if (o.forbidden) return "guard-refused";
  if (o.notFoundHeader || o.status === 404 || o.body.trim() === "{}")
    return "route-hidden";
  return "unattributed";
}

/** A response that did NOT execute the admin action for this caller. */
function isRefusal(o: Outcome): boolean {
  return classify(o) !== "ran";
}

/** Tally of which layer did the refusing, printed at the end of the run. */
const layers: Record<RefusalKind, number> = {
  ran: 0,
  "guard-refused": 0,
  "route-hidden": 0,
  unattributed: 0,
};

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
    layers[classify(o)] += 1;
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
    layers[classify(o)] += 1;
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

  /* ═══ 6 · which layer actually refused ══════════════════════════════════ */
  section("6 · Which layer refused");
  console.log(
    `    route-hidden ${layers["route-hidden"]}   ` +
      `guard-refused ${layers["guard-refused"]}   ` +
      `ran ${layers.ran}   unattributed ${layers.unattributed}`,
  );
  check(
    "every refusal is attributable to a named layer",
    layers.unattributed === 0,
    `${layers.unattributed} responses matched neither the proxy's 404 nor adminAction's forbidden`,
  );
  if (layers["guard-refused"] === 0) {
    console.log(
      "    \x1b[33mnote\x1b[0m adminAction was not exercised by this run — the proxy\n" +
        "         hid every /admin route first, so the POSTs never reached it.\n" +
        "         That is the shipped configuration and it is good defence, but\n" +
        "         it means this run says nothing about the guard. See the\n" +
        "         two-layer procedure in docs/staging.md §4.4.",
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
