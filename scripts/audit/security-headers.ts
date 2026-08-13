/**
 * `npm run audit:headers` — the security headers survive launch day.
 *
 * ## The bug this exists to prevent
 *
 * `next.config.ts`'s `headers()` used to open with:
 *
 * ```ts
 * if (isIndexable()) return [];
 * ```
 *
 * which was correct while `X-Robots-Tag` was the only header it returned. The
 * moment anything else joined it, that line became a landmine with a date on
 * it: setting `SITE_INDEXABLE=true` — the one env var that turns the shop on,
 * flipped on the single day it is least able to absorb a surprise — would have
 * dropped **every security header** along with the noindex. No diff, no deploy
 * to blame, no error. The shop would simply start serving with clickjacking and
 * MIME-sniffing protection off, and the only signal would be somebody thinking
 * to re-run a header check after launch.
 *
 * This gate is that check, run before launch instead of after. Section 1 calls
 * the real `headers()` under both values of `SITE_INDEXABLE` and requires the
 * security headers in both. Re-introducing an early return fails here.
 *
 * ## The three decisions it pins
 *
 * A gate that only checked "are the headers present" would pass just as
 * happily on a policy that breaks payments. Sections 3 and 4 pin the two
 * judgement calls that a well-meaning sweep would get wrong:
 *
 *   - **`payment=()` must never be a blanket denial.** The browser default for
 *     `payment` is `self`; Razorpay's checkout runs cross-origin on
 *     `api.razorpay.com` and needs the Payment Request API delegated to it.
 *     `payment=()` breaks Google Pay and card autofill inside the modal — a
 *     failure with no server-side signal, on the one path that takes money.
 *   - **HSTS must stay as Vercel serves it.** `preload` and `includeSubDomains`
 *     are one-way doors; the owner declined both on 2026-08-13 rather than
 *     acquire them as a side effect of a header sweep. If a future edit adds
 *     either, that should be a deliberate act that fails a gate first, not a
 *     line that slips through in a batch.
 *
 * ## What it cannot see
 *
 * Section 5 curls a running server, so it proves the headers reach the wire
 * rather than merely existing in a config object. Whatever is on `BASE_URL` is
 * what it measures; against `dev:stage` that is a dev build, which serves
 * `headers()` identically. It says so rather than implying production.
 *
 * Read-only. No client, no account, no write.
 */
import {
  CSP_DIRECTIVES,
  CSP_HEADER_NAME,
  CSP_MODE,
  CSP_REPORT_PATH,
} from "../../src/lib/csp";
import {
  cspFingerprint,
  isCritical,
  isNoise,
  parseCspReport,
} from "../../src/lib/errors/csp-classify";
import { BASE_URL } from "./routes";

const BOLD = "[1m";
const RESET = "[0m";
const GREEN = "[32m";
const RED = "[31m";

let failures = 0;
function report(ok: boolean, label: string, detail = ""): void {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures += 1;
}

type HeaderEntry = { key: string; value: string };

/** Every header `headers()` emits for `/`, lowercased, as a map. */
async function headersFor(indexable: boolean): Promise<Map<string, string>> {
  const previous = process.env.SITE_INDEXABLE;
  if (indexable) process.env.SITE_INDEXABLE = "true";
  else delete process.env.SITE_INDEXABLE;

  try {
    /*
      Imported fresh each time. `isIndexable()` reads process.env at call time
      rather than at module load, so one import would be enough today — but a
      cached module that started reading the variable at load would make this
      gate quietly measure the same state twice and pass on a config that
      cannot pass. Re-importing costs nothing and removes the assumption.
    */
    const mod = await import(`../../next.config.ts?headers-gate=${indexable}`);
    const config = mod.default as {
      headers: () => Promise<{ source: string; headers: HeaderEntry[] }[]>;
    };
    const rules = await config.headers();
    const map = new Map<string, string>();
    for (const rule of rules) {
      for (const entry of rule.headers) {
        map.set(entry.key.toLowerCase(), entry.value);
      }
    }
    return map;
  } finally {
    if (previous === undefined) delete process.env.SITE_INDEXABLE;
    else process.env.SITE_INDEXABLE = previous;
  }
}

/** The headers that must be present whether or not the shop is indexed. */
const REQUIRED = [
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
] as const;

async function main(): Promise<void> {
  console.log("\n" + BOLD + "1 · the headers survive SITE_INDEXABLE=true" + RESET + "\n");

  const closed = await headersFor(false);
  const open = await headersFor(true);

  for (const key of REQUIRED) {
    const inClosed = closed.get(key);
    const inOpen = open.get(key);
    report(
      Boolean(inClosed) && inClosed === inOpen,
      `${key} identical with indexing off and on`,
      inOpen ? `"${inOpen}"` : "ABSENT when indexable — the early return is back",
    );
  }

  console.log("\n" + BOLD + "2 · noindex is the only thing indexing changes" + RESET + "\n");

  report(
    closed.get("x-robots-tag") === "noindex, nofollow, noarchive",
    "X-Robots-Tag present while SITE_INDEXABLE is unset",
    closed.get("x-robots-tag") ?? "absent",
  );
  report(
    !open.has("x-robots-tag"),
    "X-Robots-Tag gone once SITE_INDEXABLE=true",
    open.get("x-robots-tag") ?? "absent, as it should be",
  );
  /*
    The witness for section 1. Without it, "identical in both states" would also
    be satisfied by a config that returned nothing in either state — the exact
    vacuous shape scripts/audit/refusal.ts exists to refuse. This asserts the
    two states genuinely differ, and differ by exactly one header.
  */
  const onlyDifference = [...closed.keys()].filter((k) => !open.has(k));
  report(
    onlyDifference.length === 1 && onlyDifference[0] === "x-robots-tag",
    "the two states differ by exactly one header",
    onlyDifference.length ? onlyDifference.join(", ") : "no difference at all",
  );

  console.log("\n" + BOLD + "3 · Permissions-Policy does not break checkout" + RESET + "\n");

  const permissions = open.get("permissions-policy") ?? "";
  report(
    !/payment=\(\s*\)/.test(permissions),
    "payment is not denied outright",
    /payment=\(\s*\)/.test(permissions)
      ? "payment=() blocks the Payment Request API inside the Razorpay iframe"
      : "delegated, not denied",
  );
  report(
    permissions.includes("api.razorpay.com"),
    "payment is delegated to the Razorpay checkout origin",
    permissions || "no Permissions-Policy at all",
  );
  for (const feature of ["camera", "microphone", "geolocation"]) {
    report(
      new RegExp(`${feature}=\\(\\s*\\)`).test(permissions),
      `${feature} denied`,
      permissions.includes(feature) ? "" : "not mentioned",
    );
  }

  console.log("\n" + BOLD + "4 · no one-way doors were added to HSTS" + RESET + "\n");

  const hsts = open.get("strict-transport-security");
  report(
    hsts === undefined,
    "HSTS is left to Vercel and not restated here",
    hsts ?? "absent",
  );
  report(
    !(hsts ?? "").includes("preload") &&
      !(hsts ?? "").includes("includeSubDomains"),
    "neither preload nor includeSubDomains has crept in",
    hsts ?? "nothing to creep into",
  );

  console.log(
    "\n" + BOLD + `5 · a real response carries them (${BASE_URL})` + RESET + "\n",
  );

  let live: Response | null = null;
  try {
    live = await fetch(`${BASE_URL}/`, { redirect: "manual" });
  } catch {
    live = null;
  }

  if (!live) {
    /*
      Loud, and a failure. A gate that silently skips its only end-to-end
      section is a gate that reports green on a config nobody served — the
      same class of hole as the vacuous assertions this suite spent Stage 2
      removing. Start a server, or know that this did not run.
    */
    report(false, `no server on ${BASE_URL}`, "run npm run dev:stage first");
  } else {
    for (const key of REQUIRED) {
      const served = live.headers.get(key);
      report(Boolean(served), `${key} on the wire`, served ?? "missing");
    }
    report(
      live.headers.get("x-powered-by") === null,
      "x-powered-by is gone",
      live.headers.get("x-powered-by") ?? "absent",
    );
  }

  await cspSections(open, live);

  console.log(
    failures === 0
      ? "\n" + GREEN + "All header assertions hold." + RESET + "\n"
      : "\n" + RED + `${failures} failed.` + RESET + "\n",
  );
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * The origins a real browser was measured loading on production, plus the
 * Razorpay hosts read out of `checkout.razorpay.com/v1/checkout.js`.
 *
 * Written out here rather than imported from `csp.ts` on purpose. A gate that
 * derives its expectations from the thing it is testing asserts only that the
 * code equals itself — the shape `refusal.ts` exists to refuse. These are the
 * *measurements*, restated independently, so deleting a directive from `csp.ts`
 * fails here instead of quietly redefining what "correct" means.
 */
const MUST_ALLOW: { directive: string; origin: string; why: string }[] = [
  {
    directive: "media-src",
    origin: "https://*.supabase.co",
    why: "the hero video — the only cross-origin thing an ordinary page load fetches",
  },
  {
    directive: "connect-src",
    origin: "wss://*.supabase.co",
    why: "supabase realtime; losing it breaks admin uploads, not the storefront",
  },
  {
    directive: "connect-src",
    origin: "https://*.supabase.co",
    why: "the browser client's REST calls",
  },
  {
    directive: "img-src",
    origin: "blob:",
    why: "the admin crop and re-crop previews",
  },
  {
    directive: "script-src",
    origin: "https://checkout.razorpay.com",
    why: "checkout.js itself — losing it is losing payments",
  },
  {
    directive: "frame-src",
    origin: "https://api.razorpay.com",
    why: "the checkout modal's iframe",
  },
  {
    directive: "connect-src",
    origin: "https://api.razorpay.com",
    why: "the modal's own API calls",
  },
];

async function cspSections(
  config: Map<string, string>,
  live: Response | null,
): Promise<void> {
  console.log("\n" + BOLD + "6 · the CSP is the mode it says it is" + RESET + "\n");

  const enforcing = CSP_MODE === "enforce";
  const expectedName = enforcing
    ? "content-security-policy"
    : "content-security-policy-report-only";
  const otherName = enforcing
    ? "content-security-policy-report-only"
    : "content-security-policy";

  report(
    CSP_HEADER_NAME.toLowerCase() === expectedName,
    `CSP_MODE="${CSP_MODE}" and the header name agree`,
    CSP_HEADER_NAME,
  );
  const policy = config.get(expectedName) ?? "";
  report(Boolean(policy), `${expectedName} is emitted`, policy ? "" : "absent");
  /*
    Both at once is not a stricter policy, it is two policies — and the
    enforcing one would silently do the blocking while the Report-Only one
    collects the reports somebody is reading to decide whether that is safe.
  */
  report(
    !config.has(otherName),
    `${otherName} is not emitted alongside it`,
    config.get(otherName) ? "both are present" : "absent, correctly",
  );

  console.log("\n" + BOLD + "7 · every measured origin survives" + RESET + "\n");

  for (const { directive, origin, why } of MUST_ALLOW) {
    const values = CSP_DIRECTIVES[directive] ?? [];
    report(values.includes(origin), `${directive} allows ${origin}`, why);
  }
  report(
    (CSP_DIRECTIVES["frame-ancestors"] ?? []).includes("'none'"),
    "frame-ancestors is 'none'",
    (CSP_DIRECTIVES["frame-ancestors"] ?? []).join(" "),
  );
  report(
    policy.includes(`report-uri ${CSP_REPORT_PATH}`),
    "report-uri names the endpoint",
    CSP_REPORT_PATH,
  );
  report(
    (config.get("reporting-endpoints") ?? "").includes(CSP_REPORT_PATH),
    "Reporting-Endpoints gives report-to somewhere to go",
    config.get("reporting-endpoints") ?? "absent",
  );

  /*
    upgrade-insecure-requests is inert in a report-only policy and browsers say
    so once per document load. Left in unconditionally it put 42 copies of that
    warning across the storefront and took audit:hydration, audit:bag and
    audit:signedin red — three gates whose whole job is "the console is quiet" —
    and it would have competed with the human watching DevTools during the test
    payment. Pinned to the mode so it cannot drift back.
  */
  report(
    enforcing
      ? policy.includes("upgrade-insecure-requests")
      : !policy.includes("upgrade-insecure-requests"),
    enforcing
      ? "upgrade-insecure-requests is present while enforcing"
      : "upgrade-insecure-requests is absent while report-only",
    enforcing ? "active" : "inert here, and noisy — correctly omitted",
  );

  console.log("\n" + BOLD + "8 · the classifier separates news from noise" + RESET + "\n");

  const legacy = parseCspReport({
    "csp-report": {
      "document-uri": "https://www.footvault.in/checkout?order=FV-2026-00488",
      "effective-directive": "script-src-elem",
      "blocked-uri": "https://checkout.razorpay.com/v1/checkout.js",
      "original-policy": "default-src 'self'",
      disposition: "report",
    },
  });
  report(
    legacy.length === 1,
    "the report-uri body shape parses",
    `${legacy.length} violation(s)`,
  );
  report(
    legacy[0]?.documentUri === "https://www.footvault.in/checkout",
    "the query string is stripped off the document URI",
    legacy[0]?.documentUri ?? "—",
  );
  report(
    legacy[0] !== undefined && isCritical(legacy[0]),
    "a blocked Razorpay origin is marked critical",
    legacy[0]?.blockedUri ?? "—",
  );

  const modern = parseCspReport([
    {
      type: "csp-violation",
      body: {
        documentURL: "https://www.footvault.in/",
        effectiveDirective: "media-src",
        blockedURL: "https://ahumjhwqgmskjsitctcj.supabase.co/hero.mp4",
        disposition: "report",
      },
    },
    { type: "deprecation", body: { id: "not-a-csp-report" } },
  ]);
  report(
    modern.length === 1 && modern[0].effectiveDirective === "media-src",
    "the reports+json body shape parses, ignoring other report types",
    `${modern.length} violation(s)`,
  );

  const extension = parseCspReport({
    "csp-report": {
      "document-uri": "https://www.footvault.in/",
      "effective-directive": "script-src-elem",
      "blocked-uri": "chrome-extension://abcdef/inject.js",
      disposition: "report",
    },
  });
  report(
    extension[0] !== undefined && isNoise(extension[0]),
    "a browser extension is classified as noise",
    extension[0]?.blockedUri ?? "—",
  );
  report(
    legacy[0] !== undefined && !isNoise(legacy[0]),
    "a real violation is NOT classified as noise",
    "the witness for the line above",
  );

  /*
    The fingerprint has to collapse across pages, or one missing directive
    reports once per product slug and the limit never binds. Two different
    pages, same directive, same blocked origin, must be one bucket.
  */
  const onProduct = parseCspReport({
    "csp-report": {
      "document-uri": "https://www.footvault.in/product/nike-air-max-90-mens",
      "effective-directive": "script-src-elem",
      "blocked-uri": "https://checkout.razorpay.com/v1/other.js",
      disposition: "report",
    },
  });
  report(
    legacy[0] !== undefined &&
      onProduct[0] !== undefined &&
      cspFingerprint(legacy[0]) === cspFingerprint(onProduct[0]),
    "the same directive and origin on two pages is one bucket",
    legacy[0] ? cspFingerprint(legacy[0]) : "—",
  );
  const different = parseCspReport({
    "csp-report": {
      "document-uri": "https://www.footvault.in/",
      "effective-directive": "media-src",
      "blocked-uri": "https://evil.example/x.mp4",
      disposition: "report",
    },
  });
  report(
    legacy[0] !== undefined &&
      different[0] !== undefined &&
      cspFingerprint(legacy[0]) !== cspFingerprint(different[0]),
    "a different directive and origin is a different bucket",
    different[0] ? cspFingerprint(different[0]) : "—",
  );

  console.log("\n" + BOLD + "9 · the report endpoint takes a real report" + RESET + "\n");

  if (!live) {
    report(false, `no server on ${BASE_URL}`, "run npm run dev:stage first");
    return;
  }

  const post = await fetch(`${BASE_URL}${CSP_REPORT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/csp-report" },
    body: JSON.stringify({
      "csp-report": {
        "document-uri": `${BASE_URL}/audit-headers-probe`,
        "effective-directive": "script-src-elem",
        "blocked-uri": "https://audit.invalid/probe.js",
        "original-policy": "default-src 'self'",
        disposition: "report",
      },
    }),
  }).catch(() => null);
  report(
    post?.status === 204,
    "a legacy report is accepted with 204",
    `${post?.status ?? "no response"}`,
  );

  const garbage = await fetch(`${BASE_URL}${CSP_REPORT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/csp-report" },
    body: "this is not json {{{",
  }).catch(() => null);
  report(
    garbage?.status === 204,
    "a malformed body is answered 204, not 400 or 500",
    `${garbage?.status ?? "no response"}`,
  );

  const oversize = await fetch(`${BASE_URL}${CSP_REPORT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/csp-report" },
    body: "x".repeat(200 * 1024),
  }).catch(() => null);
  report(
    oversize?.status === 204,
    "an oversized body is refused without an error status",
    `${oversize?.status ?? "no response"}`,
  );

  /*
    The endpoint must not sit behind the session proxy. If it does, every report
    a browser fires costs a getClaims() round trip — worst exactly when the
    policy is blocking something on every page.
  */
  const cookies = post?.headers.get("set-cookie");
  report(
    !cookies,
    "the endpoint sets no session cookie (it is outside the proxy matcher)",
    cookies ?? "none",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
