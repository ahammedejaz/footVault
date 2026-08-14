/**
 * The Content-Security-Policy, and the one switch that arms it.
 *
 * Deliberately dependency-free, like `indexing.ts` and for the same reason:
 * this is imported by `next.config.ts`, which the Next build evaluates outside
 * the app's module graph where the `@/` path alias does not resolve.
 *
 * ## Why this ships Report-Only first
 *
 * A wrong CSP breaks payments, and it breaks them in the worst available shape:
 *
 *   1. **Silently.** A blocked `checkout.razorpay.com` means the Pay button
 *      does nothing. No error a customer can report, no server-side signal.
 *   2. **From the wrong place.** The order row already exists as `pending` with
 *      stock reserved, so the first sign is a rising abandoned-order count from
 *      the sweep, hours later — not an alert.
 *   3. **All at once.** A header has no partial rollout. It applies to every
 *      response the instant it deploys.
 *   4. **Untested by browsing.** The Razorpay modal is only constructed at
 *      payment initiation. Clicking around the shop exercises none of the
 *      directives that matter.
 *
 * So `CSP_MODE` below starts at `report-only`. Violations are collected at
 * `CSP_REPORT_PATH` and the shop keeps working regardless. Flipping to
 * `enforce` is a one-word change, and `audit:headers` asserts the header name
 * matches the mode so the two can never disagree.
 *
 * **Do not flip it until a real end-to-end payment has completed under
 * Report-Only with no violation reported against a Razorpay origin.**
 *
 * That condition was met on 2026-08-13. A real UPI payment completed on
 * production under Report-Only: correct receipt, correct order, and **zero**
 * violations against any `razorpay.com` origin. The bake reported exactly one
 * thing, on `/checkout` only, and it was ours rather than theirs — Zod's
 * `allowsEval` probe, a `new Function("")` it runs once to pick a validator.
 * That is now switched off at source with `config({ jitless: true })` in
 * `validations/z.ts`, measured against a production build by toggling only
 * that call: one violation without it, none with it.
 *
 * So this is now `enforce`.
 *
 * ## Where the origins came from
 *
 * Measured, not guessed. A real browser was driven across `/`,
 * `/product/[slug]`, `/shop`, `/cart` and `/checkout` on production, and every
 * request it made was recorded. The storefront touches exactly two origins:
 *
 *   - `www.footvault.in` — document, script, stylesheet, font, image, fetch
 *   - `*.supabase.co` — **media**, and only media: the hero video
 *
 * Razorpay never appears until a payment starts, so its origins were taken from
 * `checkout.razorpay.com/v1/checkout.js` itself rather than from a page load —
 * every `razorpay.com` host the bundle references is listed below.
 *
 * One reassurance from reading that bundle: its single `new Function` is the
 * webpack `globalThis` polyfill, wrapped in `try/catch` with a `window`
 * fallback. **Razorpay does not need `'unsafe-eval'`.** A CSP that blocks it
 * takes the catch and carries on.
 *
 * ## Why `'unsafe-inline'` is still on script-src
 *
 * Because the alternative is worse *right now*, not because it is good.
 *
 * The homepage carries two inline `<script>` tags with no nonce — Next's RSC
 * bootstrap. Removing `'unsafe-inline'` means the nonce flow from
 * `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`:
 * a nonce minted in `proxy.ts`, plus `'strict-dynamic'`.
 *
 * The usual objection to that — nonces force dynamic rendering and kill ISR —
 * **does not apply to this shop.** Every storefront page already serves
 * `cache-control: private, no-cache, no-store` with `x-vercel-cache: MISS`, so
 * there is no static generation left to lose. Measured on production.
 *
 * The real objection is different and sharper: **`'strict-dynamic'` causes
 * browsers to ignore host allowlists entirely.** Every `https://…razorpay.com`
 * below would become a no-op, and the Razorpay tag would load only if trust
 * propagates from Next's nonced runtime through `next/script`. That is a
 * mechanism to verify deliberately, under Report-Only, with a real payment —
 * not one to discover in production because the Pay button went quiet.
 *
 * So the honest statement of what this policy buys today: it stops an injected
 * `<script src="https://evil.example/x.js">`, stops the page being framed,
 * stops a form posting to another origin, and stops exfiltration to an
 * arbitrary host. It does **not** stop an injected inline `<script>`. Given
 * that the Supabase session cookie cannot be `httpOnly` (see
 * `supabase/cookie-options.ts`), closing that last gap is worth a follow-up —
 * it is simply not worth doing blind in the same change as everything else.
 */

/** Where violation reports are posted. Also the route handler's own path. */
export const CSP_REPORT_PATH = "/api/csp-report";

/** The name used by the Reporting API endpoint group. */
export const CSP_REPORT_GROUP = "csp";

/**
 * `report-only` collects violations and blocks nothing. `enforce` blocks.
 *
 * One word, one deploy, and `audit:headers` keeps the header name honest.
 */
export type CspMode = "report-only" | "enforce";

/*
  Asserted rather than annotated. With a plain `const CSP_MODE: CspMode =
  "report-only"`, TypeScript narrows the constant to its initializer and then
  reports every `CSP_MODE === "enforce"` below as an impossible comparison —
  so the code that has to survive the flip would not compile until after
  somebody flipped it, which is backwards. The assertion keeps the declared
  type wide so both branches stay type-checked in both modes.
*/
export const CSP_MODE = "enforce" as CspMode;

/** The header name that matches the mode. Never emit both. */
export const CSP_HEADER_NAME =
  CSP_MODE === "enforce"
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";

/**
 * Razorpay's own hosts, read out of `checkout.razorpay.com/v1/checkout.js`.
 *
 * `api.razorpay.com` is the checkout iframe — that one is `frame-src` and
 * losing it is what makes the modal never appear. The `lumberjack*` hosts are
 * their telemetry; blocking those degrades nothing a customer sees, but they
 * are listed so the Report-Only bake is not drowned in violations that are not
 * bugs.
 */
const RAZORPAY_SCRIPT = [
  "https://checkout.razorpay.com",
  "https://cdn.razorpay.com",
  "https://checkout-static-next.razorpay.com",
];
const RAZORPAY_CONNECT = [
  "https://api.razorpay.com",
  "https://lumberjack.razorpay.com",
  "https://lumberjack-cx.razorpay.com",
  "https://lumberjack-metrics.razorpay.com",
];
const RAZORPAY_FRAME = [
  "https://api.razorpay.com",
  "https://checkout.razorpay.com",
];

/**
 * The Google map embedded on `/page/contact`, so a customer can navigate to the
 * shop.
 *
 * `www.google.com` and nothing else. The embed loads its tiles, fonts and API
 * calls from `maps.gstatic.com` and `maps.googleapis.com`, and none of those
 * belong here: they are fetched *inside* the iframe, which is a separate
 * browsing context governed by Google's own policy, not by ours. `frame-src`
 * governs the one thing this document does, which is ask for the frame.
 *
 * Listing more would be listing origins this page never contacts — a CSP is
 * read later as a statement of where the shop sends people, and
 * `audit:privacy` now reads it exactly that way.
 */
const GOOGLE_MAPS_FRAME = ["https://www.google.com"];

/**
 * `'unsafe-eval'`, in development only, and it is not optional.
 *
 * React uses `eval` in dev to rebuild server-side error stacks in the browser.
 * Next's own CSP guide says so plainly — *"In development, `'unsafe-eval'` is
 * required… `unsafe-eval` is not required for production. Neither React nor
 * Next.js use `eval` in production by default."*
 *
 * This was measured before it was added rather than taken on faith. A browser
 * driven across the storefront against `next dev` produced **1,533** violations
 * and exactly two distinct messages, all of one kind:
 *
 *     Evaluating a string as JavaScript violates the following Content Security
 *     Policy directive because 'unsafe-eval' is not an allowed source of script
 *
 * That is not a finding, and leaving it in place would be actively harmful: the
 * point of a Report-Only bake is to notice the one violation that matters, and
 * a signal that is 1,533 parts noise hides it completely. The failure would be
 * somebody scanning the log, seeing a wall of red, and flipping to enforce
 * anyway.
 *
 * Gated on `NODE_ENV` and therefore **absent from every production build** —
 * `next build` sets it to `production`, so nothing that ships carries this.
 */
const DEV_ONLY_UNSAFE_EVAL =
  process.env.NODE_ENV === "development" ? ["'unsafe-eval'"] : [];

/**
 * The policy, as a directive map so the gate can assert on it structurally
 * rather than by string-matching a header value.
 */
export const CSP_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'self'"],

  /*
    'unsafe-inline' is load-bearing until the nonce work lands — see the module
    header. The Razorpay hosts are here rather than only in connect-src because
    checkout.js pulls further bundles from cdn/checkout-static-next.
  */
  "script-src": [
    "'self'",
    "'unsafe-inline'",
    ...DEV_ONLY_UNSAFE_EVAL,
    ...RAZORPAY_SCRIPT,
  ],

  /*
    'unsafe-inline' here is not a temporary compromise, it is structural. Inline
    `style="…"` attributes are governed by `style-src-attr`, which falls back to
    `style-src` when unset — and the homepage alone carries 33 of them from
    React inline styles and CSS custom properties. A nonce cannot cover an
    attribute. CSS injection is a far smaller problem than script injection, so
    this is the right place to spend the compromise.
  */
  "style-src": [
    "'self'",
    "'unsafe-inline'",
    "https://cdn.razorpay.com",
    "https://checkout-static-next.razorpay.com",
  ],

  /*
    `blob:` is not decoration — the admin crop and re-crop dialogs build their
    previews from blob URLs, and without it the image editor shows nothing.
  */
  "img-src": [
    "'self'",
    "data:",
    "blob:",
    "https://*.supabase.co",
    "https://cdn.razorpay.com",
    "https://checkout-static-next.razorpay.com",
  ],

  /*
    The hero video, and nothing else. This is the only cross-origin thing the
    storefront loads on an ordinary page view; omit it and the homepage hero
    silently falls back to its poster image, which is exactly the kind of
    degradation nobody files a bug about.
  */
  "media-src": ["'self'", "https://*.supabase.co"],

  "font-src": [
    "'self'",
    "data:",
    "https://cdn.razorpay.com",
    "https://checkout-static-next.razorpay.com",
  ],

  /*
    `wss://*.supabase.co` matters and is easy to miss: `supabase/client.ts` is
    used for "auth state and realtime", and realtime is a WebSocket. Dropping it
    breaks admin uploads and auth-state sync rather than the storefront, so it
    would pass a casual click-through and fail in the panel the owner uses.
  */
  "connect-src": [
    "'self'",
    "https://*.supabase.co",
    "wss://*.supabase.co",
    ...RAZORPAY_CONNECT,
  ],

  /*
    The checkout modal — losing the Razorpay half is losing payments — and the
    map on the contact page. The map is the only non-payment frame the shop
    embeds, and adding it here is what makes it render at all: under enforce
    mode an un-allowed frame is not a degraded map, it is an empty box.
  */
  "frame-src": [...RAZORPAY_FRAME, ...GOOGLE_MAPS_FRAME],

  /*
    Razorpay's iframe-mode checkout keeps bank and 3-D Secure redirects inside
    its own frame, so `'self'` would very likely be enough. `api.razorpay.com`
    is listed anyway: the failure mode of guessing wrong here is a customer
    stranded mid-3DS, and one extra origin on a first-party payment processor
    is a cheaper insurance premium than that.
  */
  "form-action": ["'self'", "https://api.razorpay.com"],

  /* Nothing embeds this shop. Supersedes X-Frame-Options where both are read. */
  "frame-ancestors": ["'none'"],

  "base-uri": ["'self'"],
  "object-src": ["'none'"],
};

/**
 * Directives that take no value.
 *
 * `upgrade-insecure-requests` is emitted **only when enforcing**, and the
 * reason is worth the paragraph because the first attempt got it wrong.
 *
 * A browser ignores this directive in a report-only policy and says so, once
 * per document load:
 *
 *     The Content Security Policy directive 'upgrade-insecure-requests' is
 *     ignored when delivered in a report-only policy.
 *
 * It was originally left in unconditionally, reasoning that keeping it here
 * meant the flip to `enforce` would not also need someone to remember to add a
 * directive. That traded a real, active signal for a hypothetical convenience,
 * and the suite said so immediately: **`audit:hydration`, `audit:bag` and
 * `audit:signedin` all assert console cleanliness and all went red**, hydration
 * reporting `hydration warnings: 0, other console errors: 42` — forty-two
 * copies of this one warning across 23 routes and 14 populated states, and
 * nothing else.
 *
 * Three gates whose entire job is "the console is quiet" cannot be asked to
 * carry a permanent exception for a directive that is doing nothing. And the
 * console is not just a gate's instrument here: the Report-Only bake ends with
 * a human completing a real payment with DevTools open, watching for a blocked
 * `razorpay.com` origin. Anything that fills that console competes with the one
 * observation the whole staged rollout is built around.
 *
 * The directive is genuinely inert until `CSP_MODE` is `enforce`, so gating it
 * costs nothing and `audit:headers` asserts the pairing rather than trusting
 * anyone to remember it.
 */
const CSP_FLAGS = CSP_MODE === "enforce" ? ["upgrade-insecure-requests"] : [];

/**
 * The header value.
 *
 * `report-uri` is deprecated in the spec and is still the most widely honoured
 * reporting mechanism in shipping browsers; `report-to` is the replacement and
 * needs the `Reporting-Endpoints` header to mean anything. Both are emitted,
 * because the point of a Report-Only bake is to hear from every browser that
 * has something to say, and dropping the deprecated one would silently exclude
 * whichever share of real customers has not caught up.
 */
export function cspHeaderValue(): string {
  const directives = Object.entries(CSP_DIRECTIVES).map(
    ([name, values]) => `${name} ${values.join(" ")}`,
  );
  return [
    ...directives,
    ...CSP_FLAGS,
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ].join("; ");
}

/** The `Reporting-Endpoints` header that gives `report-to` somewhere to go. */
export function reportingEndpointsHeaderValue(): string {
  return `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`;
}
