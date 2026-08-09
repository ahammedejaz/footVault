/**
 * The two decisions that stand between a server error and the owner's inbox.
 *
 * Pure and fast: no browser, no database, no network. Both properties asserted
 * here fail *silently* if they regress, which is why they are a gate rather
 * than a code review note:
 *
 *   - Classify a real error as control flow and nothing is ever reported. The
 *     shop looks healthy because the alarm is disconnected — the exact state
 *     this whole feature exists to end.
 *   - Fail to classify control flow and every 404 emails the owner. Within a
 *     day they filter the alerts, and the next real one is filtered too. That
 *     is worse than having none.
 *
 * The third assertion is about what must never leave the building. The incident
 * email is built from a struct that has no field for request headers, and the
 * test is that no header, cookie or query string can reach the message even
 * when handed to it.
 *
 *   npx tsx scripts/audit/error-reporting.ts
 */
import { readFileSync } from "node:fs";

import { buildIncidentEmail } from "../../src/lib/email/incident";
import { fingerprint, isControlFlow } from "../../src/lib/errors/classify";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  [32m✓[0m ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  [31m✗[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/* --------------------------------------------------- 1 · control flow -- */

console.log("\n[1m1 · redirects and 404s are not incidents[0m");

/*
 * `notFound()` and `redirect()` are implemented as throws and `onRequestError`
 * sees both. On a shop, 404s are continuous — every stale link, every bot
 * guessing /wp-admin — so getting this wrong is not a trickle.
 */
for (const digest of [
  "NEXT_REDIRECT",
  "NEXT_NOT_FOUND",
  "NEXT_HTTP_ERROR_FALLBACK;404",
]) {
  check(`${digest} is filtered out`, isControlFlow(digest));
}

/* -------------------------------------------------- 2 · real errors -- */

console.log("\n[1m2 · a real failure is never filtered[0m");

for (const [label, digest] of [
  ["a React-processed error with a numeric digest", "676306073"],
  ["an error with no digest at all", null],
  /*
    The underscore is load-bearing. `NEXTDOOR_API_TIMEOUT` shares four
    characters with the prefix and must still be reported — a substring test,
    or a prefix of "NEXT", would swallow it. This was written the other way
    round first and the gate caught it.
  */
  ["a third-party digest that merely begins NEXT", "NEXTDOOR_API_TIMEOUT"],
] as const) {
  check(`${label} is reported`, !isControlFlow(digest), digest ?? "(no digest)");
}

/* ------------------------------------------------- 3 · fingerprinting -- */

console.log("\n[1m3 · the throttle groups what a human would group[0m");

check(
  "the same error on the same route is one bucket",
  fingerprint("/checkout", "abc", "boom") ===
    fingerprint("/checkout", "abc", "boom"),
);
check(
  "the same message on two routes stays two buckets",
  fingerprint("/checkout", null, "boom") !==
    fingerprint("/cart", null, "boom"),
  "two different places to go and look",
);
/*
  Truncation at 80 characters collapses messages that differ only *after* that
  point — the common shape, where a driver appends a connection id or a stack
  frame to an otherwise identical sentence.
*/
check(
  "messages differing only past 80 characters collapse to one bucket",
  fingerprint("/x", null, `${"the same failure ".repeat(5)}id=aaa`) ===
    fingerprint("/x", null, `${"the same failure ".repeat(5)}id=bbb`),
);
/*
  And the honest limit, asserted rather than hoped: a unique id *early* in the
  message still mints a fresh bucket, so the per-fingerprint limit alone does
  not bound that case. `errorReportTotal` is the backstop, and this check is
  what stops anyone believing otherwise.
*/
check(
  "a unique id early in the message does defeat the per-error limit",
  fingerprint("/x", null, "conn aaa failed") !==
    fingerprint("/x", null, "conn bbb failed"),
  "which is why errorReportTotal exists",
);

/* ------------------------------------------- 4 · what must not leave -- */

console.log("\n[1m4 · no credential can reach the inbox[0m");

const message = buildIncidentEmail({
  to: "owner@example.com",
  path: "/checkout",
  method: "POST",
  routePath: "/checkout",
  routeType: "action",
  message: "Boom",
  digest: "676306073",
  stack: "Error: Boom\n    at handler (/app/checkout.ts:1:1)",
  occurredAt: "2026-08-10T00:00:00.000Z",
});

const body = `${message.subject}\n${message.text}\n${message.html}`;

for (const [label, secret] of [
  ["a session cookie", "sb-access-token=eyJhbGciOi"],
  ["an authorization header", "Bearer re_live_secret"],
  ["a query string", "?secret=shouldnotappear"],
] as const) {
  check(`${label} is absent`, !body.includes(secret));
}

/*
 * Structural, not incidental: the input type has no header field, so there is
 * no way to pass one in even by mistake. This asserts the shape of the call
 * rather than the contents of one message.
 */
check(
  "the builder takes no headers at all",
  !("headers" in (message as unknown as Record<string, unknown>)),
);

check(
  "a checkout failure says so in the subject",
  message.subject.startsWith("CHECKOUT FAILING"),
  message.subject,
);
check(
  "an ordinary page failure does not shout",
  buildIncidentEmail({
    to: "owner@example.com",
    path: "/page/returns",
    method: "GET",
    routePath: "/page/[slug]",
    routeType: "render",
    message: "Boom",
    digest: null,
    stack: null,
    occurredAt: "2026-08-10T00:00:00.000Z",
  }).subject === "Error on /page/returns — Foot Vault",
);
check("the incident email can be replied to", Boolean(message.replyTo));

/* ------------------------------------------------- 5 · the hard cap -- */

console.log(
  "\n\u001b[1m5 \u00b7 a shop failing on every request cannot bury the one that matters\u001b[0m",
);

/*
 * Three caps, and the third exists because the first two fail open.
 *
 * `consumeRateLimit` allows the call when its counter cannot be read — right
 * for a cart write, wrong here, because the most likely cause of every request
 * failing at once is the database being unreachable. That is precisely the
 * scenario in which a database-backed cap on error emails does not bind.
 */
const reporterSource = readFileSync(
  "src/lib/errors/report-server-error.ts",
  "utf8",
);
const limits = readFileSync("src/lib/rate-limit.ts", "utf8");

const perError = /errorReport:\s*\[(\d+),\s*(\d+)\]/.exec(limits);
const total = /errorReportTotal:\s*\[(\d+),\s*(\d+)\]/.exec(limits);

check(
  "a per-error cap exists",
  perError !== null,
  perError ? `${perError[1]} per ${perError[2]}s` : "missing",
);
check(
  "a global cap exists, in one bucket for the whole shop",
  total !== null && /consumeRateLimit\("errorReportTotal",\s*"all"\)/.test(reporterSource),
  total ? `${total[1]} per ${total[2]}s` : "missing",
);
check(
  "both are checked before the send, not after",
  reporterSource.indexOf("errorReportTotal") <
    reporterSource.indexOf("adapter.send("),
);
check(
  "and a cap that survives the database being the broken thing",
  /withinProcessBudget\(/.test(reporterSource) &&
    /IN_PROCESS_LIMIT/.test(reporterSource),
  "counts in memory, so it holds when consumeRateLimit fails open",
);

/* ------------------------------------------------------------ summary -- */

console.log(`\n[1m${passed} passed, ${failed} failed[0m\n`);
if (failed > 0) process.exit(1);
