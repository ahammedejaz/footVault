/**
 * Reading a CSP violation report, and deciding whether it is news.
 *
 * Split out from the sink for the same reason `classify.ts` is split out from
 * `report-server-error.ts`: this is where the risk lives, both failure modes
 * are silent, and a pure module is one a gate can hold still.
 *
 *   - Classify a real violation as noise and the Report-Only bake reports
 *     nothing. The policy looks safe to enforce because the alarm is off, and
 *     the first thing anyone learns is that payments stopped.
 *   - Fail to classify noise and the owner's inbox fills with other people's
 *     browser extensions on the first afternoon, and they stop reading it.
 *
 * No imports, on purpose.
 */

/** One violation, whichever wire format it arrived in. */
export type CspViolation = {
  /** The page the violation happened on, query stripped. */
  documentUri: string;
  /** The directive that actually did the blocking, e.g. `script-src-elem`. */
  effectiveDirective: string;
  /** What was blocked. May be a URL, `inline`, `eval`, or an extension scheme. */
  blockedUri: string;
  /** The whole policy, as the browser saw it. Useful when a directive is missing. */
  originalPolicy: string;
  /** Present only when the browser can attribute it to a source line. */
  sourceFile: string | null;
  lineNumber: number | null;
  /** `enforce` or `report`. A bake should only ever see `report`. */
  disposition: string;
};

type LegacyReport = {
  "document-uri"?: unknown;
  "effective-directive"?: unknown;
  "violated-directive"?: unknown;
  "blocked-uri"?: unknown;
  "original-policy"?: unknown;
  "source-file"?: unknown;
  "line-number"?: unknown;
  disposition?: unknown;
};

type ModernBody = {
  documentURL?: unknown;
  effectiveDirective?: unknown;
  blockedURL?: unknown;
  originalPolicy?: unknown;
  sourceFile?: unknown;
  lineNumber?: unknown;
  disposition?: unknown;
};

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Query and fragment stripped: they carry order numbers and search terms. */
function bare(uri: string): string {
  const cut = uri.split(/[?#]/)[0];
  return cut.length > 0 ? cut : uri;
}

/**
 * Both wire formats, normalised.
 *
 * `report-uri` posts `application/csp-report` with a single `{"csp-report":{…}}`
 * object and hyphenated keys. `report-to` posts `application/reports+json` with
 * an **array** of envelopes and camelCase keys. Emitting both directives means
 * receiving both shapes, sometimes for the same violation from the same
 * browser — which is a duplicate, not a second bug, and the fingerprint below
 * collapses them.
 *
 * Returns `[]` rather than throwing on anything unrecognised. This endpoint is
 * a public POST target; a parser that throws on malformed input is a parser
 * that turns a stray crawler into log noise at best.
 */
export function parseCspReport(payload: unknown): CspViolation[] {
  if (payload === null || typeof payload !== "object") return [];

  const fromLegacy = (raw: LegacyReport): CspViolation => ({
    documentUri: bare(str(raw["document-uri"], "unknown")),
    effectiveDirective: str(
      raw["effective-directive"],
      str(raw["violated-directive"], "unknown"),
    ),
    blockedUri: str(raw["blocked-uri"], "unknown"),
    originalPolicy: str(raw["original-policy"]),
    sourceFile: typeof raw["source-file"] === "string" ? raw["source-file"] : null,
    lineNumber: num(raw["line-number"]),
    disposition: str(raw.disposition, "unknown"),
  });

  const fromModern = (body: ModernBody): CspViolation => ({
    documentUri: bare(str(body.documentURL, "unknown")),
    effectiveDirective: str(body.effectiveDirective, "unknown"),
    blockedUri: str(body.blockedURL, "unknown"),
    originalPolicy: str(body.originalPolicy),
    sourceFile: typeof body.sourceFile === "string" ? body.sourceFile : null,
    lineNumber: num(body.lineNumber),
    disposition: str(body.disposition, "unknown"),
  });

  if (Array.isArray(payload)) {
    const out: CspViolation[] = [];
    for (const entry of payload) {
      if (entry === null || typeof entry !== "object") continue;
      const envelope = entry as { type?: unknown; body?: unknown };
      if (envelope.type !== "csp-violation") continue;
      if (envelope.body === null || typeof envelope.body !== "object") continue;
      out.push(fromModern(envelope.body as ModernBody));
    }
    return out;
  }

  const wrapper = payload as { "csp-report"?: unknown };
  if (wrapper["csp-report"] && typeof wrapper["csp-report"] === "object") {
    return [fromLegacy(wrapper["csp-report"] as LegacyReport)];
  }

  return [];
}

/**
 * Schemes that mean "a browser extension did this, not the shop".
 *
 * This is the single largest source of CSP noise on any public site and it is
 * not a defect in anything we ship: a password manager, an ad blocker or a
 * shopping-coupon extension injects a script into the page, the policy blocks
 * it, and the browser dutifully reports it. On a shop the coupon extensions are
 * guaranteed traffic.
 *
 * Filtered rather than merely rate-limited, because rate limits are a shared
 * budget: extension noise that merely gets throttled still spends the ceiling
 * that a real violation needs.
 */
const EXTENSION_SCHEMES = [
  "chrome-extension:",
  "moz-extension:",
  "safari-extension:",
  "safari-web-extension:",
  "webkit-masked-url:",
  "resource:",
  "chrome:",
  "about:",
];

/**
 * True for reports that say nothing about this application.
 *
 * Deliberately narrow. Everything not on this list is treated as real, because
 * the cost of a missed violation during a bake — enforcing a policy that breaks
 * checkout — is far higher than the cost of one extra email.
 */
export function isNoise(violation: CspViolation): boolean {
  const blocked = violation.blockedUri.toLowerCase();
  if (EXTENSION_SCHEMES.some((scheme) => blocked.startsWith(scheme))) return true;

  // Some browsers report the *source* as the extension while the blocked URI is
  // a bare "inline". Without this, every extension that writes an inline script
  // is indistinguishable from a real inline-script violation.
  const source = (violation.sourceFile ?? "").toLowerCase();
  if (EXTENSION_SCHEMES.some((scheme) => source.startsWith(scheme))) return true;

  return false;
}

/**
 * What counts as "the same violation" for throttling.
 *
 * Directive plus the *origin* of what was blocked — deliberately not the
 * document URI, and deliberately not the full blocked URL.
 *
 *   - Keying on the document would mint a fresh bucket for every product page,
 *     so one missing directive would report once per slug in the catalogue and
 *     defeat the limit entirely.
 *   - Keying on the full blocked URL does the same thing one level down: a
 *     blocked CDN that serves per-asset URLs would look like hundreds of
 *     distinct violations.
 *
 * What the owner needs to know is "`script-src` is blocking
 * `https://checkout.razorpay.com`", once. Where and with which filename is in
 * the log line, which is not rate-limited.
 */
export function cspFingerprint(violation: CspViolation): string {
  let target = violation.blockedUri;
  try {
    target = new URL(violation.blockedUri).origin;
  } catch {
    // "inline", "eval", "data", or a malformed URI: use it as given.
    target = violation.blockedUri.slice(0, 60);
  }
  return `${violation.effectiveDirective}:${target}`;
}

/**
 * Whether a violation names an origin the shop cannot lose.
 *
 * A blocked Razorpay or Supabase origin is not one report among many — it is
 * the failure this whole staged rollout exists to catch before it reaches an
 * enforcing policy. It earns a louder log line and its own subject.
 */
export function isCritical(violation: CspViolation): boolean {
  return /razorpay\.com|supabase\.co/.test(violation.blockedUri);
}
