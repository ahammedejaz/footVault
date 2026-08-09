/**
 * The inbound webhook's signature check, which is its entire authentication.
 *
 * Pure and fast: no browser, no database, no network. The route it guards is
 * public and it forwards mail *from our verified domain* into the owner's
 * inbox, so a signature check that accepts anything is not a bug in a webhook —
 * it is an open relay with our DKIM key on it.
 *
 * Every case below is one an attacker gets for free if the check is wrong, or
 * one a rotation produces on an ordinary Tuesday.
 *
 *   npx tsx scripts/audit/inbound-email.ts
 */
import { createHmac } from "node:crypto";

import {
  extractAddress,
  verifyResendWebhook,
} from "../../src/lib/email/inbound";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  [32m✓[0m ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(
      `  [31m✗[0m ${label}${detail ? ` — ${detail}` : ""}`,
    );
  }
}

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const BODY = JSON.stringify({
  type: "email.received",
  data: { email_id: "56761188-7520-42d8-8898-ff6fc54ce618" },
});

function sign(id: string, timestamp: string, body: string, secret = SECRET) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
}

const now = () => String(Math.floor(Date.now() / 1000));

/* ------------------------------------------------------ 1 · the happy path -- */

console.log("\n[1m1 · a genuine delivery is accepted[0m");

const id = "msg_2a0c9ce0";
const ts = now();
const good = verifyResendWebhook(
  BODY,
  { id, timestamp: ts, signature: `v1,${sign(id, ts, BODY)}` },
  SECRET,
);
check("a correctly signed payload verifies", good.ok);

/*
 * A rotation puts two secrets in flight, and Svix sends a signature for each in
 * one space-separated header. Checking only the first is the bug that makes
 * every inbound email vanish for the duration of a rotation, with a signature
 * error that looks like a misconfiguration.
 */
const OTHER = "whsec_TGhpcyBpcyBhbm90aGVyIHNlY3JldCBrZXkh";
const rotating = verifyResendWebhook(
  BODY,
  {
    id,
    timestamp: ts,
    signature: `v1,${sign(id, ts, BODY, OTHER)} v1,${sign(id, ts, BODY)}`,
  },
  SECRET,
);
check("ours is found among several offered signatures", rotating.ok);

/* -------------------------------------------------------- 2 · forgery -- */

console.log("\n[1m2 · anything not signed by us is refused[0m");

for (const [label, headers] of [
  [
    "a signature from a different secret",
    { id, timestamp: ts, signature: `v1,${sign(id, ts, BODY, OTHER)}` },
  ],
  ["no signature header at all", { id, timestamp: ts, signature: null }],
  ["no svix-id", { id: null, timestamp: ts, signature: `v1,${sign(id, ts, BODY)}` }],
  [
    "an empty signature value",
    { id, timestamp: ts, signature: "v1," },
  ],
  [
    "a version we do not know",
    { id, timestamp: ts, signature: `v2,${sign(id, ts, BODY)}` },
  ],
  [
    "garbage in the signature",
    { id, timestamp: ts, signature: "not-even-close" },
  ],
] as const) {
  const result = verifyResendWebhook(BODY, headers, SECRET);
  check(label + " is refused", !result.ok, result.ok ? "ACCEPTED" : result.reason);
}

/*
 * The body is what is signed. A payload edited in flight — a different
 * email_id, pointing the forward at somebody else's message — has to fail even
 * though every header is genuine.
 */
const tampered = verifyResendWebhook(
  JSON.stringify({ type: "email.received", data: { email_id: "attacker" } }),
  { id, timestamp: ts, signature: `v1,${sign(id, ts, BODY)}` },
  SECRET,
);
check("a body edited after signing is refused", !tampered.ok, tampered.ok ? "ACCEPTED" : tampered.reason);

/* ------------------------------------------------------- 3 · replay -- */

console.log("\n[1m3 · a captured request stops working[0m");

const old = String(Math.floor(Date.now() / 1000) - 3600);
const replayed = verifyResendWebhook(
  BODY,
  { id, timestamp: old, signature: `v1,${sign(id, old, BODY)}` },
  SECRET,
);
check(
  "an hour-old delivery is refused",
  !replayed.ok,
  replayed.ok ? "ACCEPTED" : replayed.reason,
);
check(
  "and is not marked retryable — a redelivery is older still",
  !replayed.ok && !replayed.retryable,
);

const future = String(Math.floor(Date.now() / 1000) + 3600);
const ahead = verifyResendWebhook(
  BODY,
  { id, timestamp: future, signature: `v1,${sign(id, future, BODY)}` },
  SECRET,
);
check("a timestamp an hour in the future is refused", !ahead.ok);

/* ------------------------------------------- 4 · a missing configuration -- */

console.log("\n[1m4 · a broken secret refuses rather than accepts[0m");

const emptySecret = verifyResendWebhook(
  BODY,
  { id, timestamp: ts, signature: `v1,${sign(id, ts, BODY)}` },
  "",
);
check(
  "an empty signing secret refuses everything",
  !emptySecret.ok,
  emptySecret.ok ? "ACCEPTED" : emptySecret.reason,
);

/* --------------------------------------------------- 5 · the reply address -- */

console.log("\n[1m5 · the customer is who a forward replies to[0m");

check(
  'a display-name address is unwrapped',
  extractAddress("Priya Sharma <priya@example.com>") === "priya@example.com",
  extractAddress("Priya Sharma <priya@example.com>"),
);
check(
  "a bare address is left alone",
  extractAddress("priya@example.com") === "priya@example.com",
);

/* ------------------------------------------------------------- summary -- */

console.log(`\n[1m${passed} passed, ${failed} failed[0m\n`);
if (failed > 0) process.exit(1);
