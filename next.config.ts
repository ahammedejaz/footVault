import type { NextConfig } from "next";

import {
  CSP_HEADER_NAME,
  cspHeaderValue,
  reportingEndpointsHeaderValue,
} from "./src/lib/csp";
import { NOINDEX_HEADER, isIndexable } from "./src/lib/indexing";

/**
 * The headers that must be on every response whether the shop is indexed or
 * not.
 *
 * Named rather than inlined so the branch below reads as "one array, plus
 * noindex when the shop is hidden" at a glance — which is the property that
 * matters and the one an early return used to destroy. `audit:headers` does not
 * import this; it calls the real `headers()` under both values of
 * `SITE_INDEXABLE`, which is strictly stronger because it exercises the branch
 * rather than the ingredient.
 *
 * None of these can break a payment, which is why they ship ahead of the CSP.
 * The one that *could* have is commented at length below.
 */
const SECURITY_HEADERS: { key: string; value: string }[] = [
  /**
   * No MIME sniffing. An uploaded file whose bytes look like HTML is served as
   * whatever `Content-Type` says it is, not as whatever the browser guesses —
   * which matters here because the storage buckets accept customer-adjacent
   * uploads and `site-assets` still accepts SVG on purpose.
   */
  { key: "X-Content-Type-Options", value: "nosniff" },

  /**
   * No framing, by anyone. Nothing embeds this shop: Razorpay puts *its*
   * checkout in an iframe inside *our* page, never the other way round, so
   * there is no legitimate framer to allow.
   *
   * Superseded by CSP `frame-ancestors 'none'` in browsers that read both, and
   * kept anyway — it costs one line and it is the only clickjacking control
   * until the CSP ships, which is precisely the window this is for. A framed
   * checkout page is the classic version of this attack and this shop has one.
   *
   * If BotID lands (Group 3), its challenge path needs `SAMEORIGIN` on its own
   * route in vercel.json. That is a different source and does not conflict.
   */
  { key: "X-Frame-Options", value: "DENY" },

  /**
   * Origin only when leaving the site, nothing at all when downgrading.
   *
   * This is already the default in current Chrome and Firefox; stating it
   * pins the behaviour for older and embedded browsers rather than inheriting
   * whatever they happen to do. It keeps order numbers and slugs out of the
   * `Referer` sent to Razorpay and Shiprocket.
   */
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },

  /**
   * ## Read this before editing the payment entry
   *
   * The obvious sweep is `payment=()` alongside the rest, and it is a trap
   * that breaks checkout in a way nobody notices until a customer complains.
   *
   * The browser default for `payment` is `self`, and Razorpay's checkout runs
   * cross-origin in an iframe on `api.razorpay.com`, where it uses the Payment
   * Request API for Google Pay and card autofill. A child frame can only be
   * delegated a feature the parent's policy already permits for that origin —
   * so `payment=()` denies it outright, and even omitting `payment` leaves the
   * default `self`, which does not include Razorpay either.
   *
   * `payment=(self "https://api.razorpay.com")` is therefore **more**
   * permissive than what this shop serves today, not less. It cannot break a
   * payment; it can only fix one that the default would have broken.
   *
   * The other three are pure denials of things nothing here uses — no
   * `getUserMedia`, no `navigator.geolocation`, no `mediaDevices` anywhere in
   * `src/` (checked). Delivery is decided by a typed PIN code, not by asking
   * the browser where the customer is.
   *
   * `interest-cohort` is deliberately absent: FLoC was removed from Chrome, and
   * a directive no engine reads is noise that makes the next reader wonder what
   * else here is stale.
   */
  {
    key: "Permissions-Policy",
    value:
      'camera=(), microphone=(), geolocation=(), payment=(self "https://api.razorpay.com")',
  },

  /**
   * The Content-Security-Policy — **Report-Only until a real payment has gone
   * through under it.**
   *
   * The header *name* comes from `CSP_MODE` in `src/lib/csp.ts` rather than
   * being written out here, so the mode and the header can never disagree: one
   * word changes both, and `audit:headers` asserts they match. The policy
   * itself, and the measurements every origin in it came from, are documented
   * in that module.
   */
  { key: CSP_HEADER_NAME, value: cspHeaderValue() },

  /**
   * Gives the policy's `report-to` directive somewhere to deliver.
   *
   * Both reporting mechanisms are emitted — the deprecated `report-uri` and the
   * modern `report-to` — because the point of a bake is to hear from every
   * browser a customer might be using, and the deprecated one is still the more
   * widely honoured of the two. Duplicate reports for one violation are
   * collapsed by the fingerprint in `csp-classify.ts`.
   */
  { key: "Reporting-Endpoints", value: reportingEndpointsHeaderValue() },
];

const nextConfig: NextConfig = {
  /**
   * Framework disclosure, off. `x-powered-by: Next.js` told every caller which
   * framework and therefore which CVE feed to read, and bought nothing back.
   */
  poweredByHeader: false,

  /**
   * Every header the deployment serves, in one array.
   *
   * Emitted here rather than from `src/proxy.ts` because "site-wide" has to
   * mean site-wide: the proxy's matcher deliberately skips static assets and
   * image files, and the OG image routes under `/opengraph-image` are exactly
   * the kind of thing that gets indexed on its own. A header set in the config
   * covers every response the deployment serves.
   *
   * ## The shape, and why it is not an early return
   *
   * This function used to open with `if (isIndexable()) return []` and then
   * return the noindex header. That was correct while noindex was the only
   * header here, and it was a landmine the moment anything joined it: the day
   * the owner sets `SITE_INDEXABLE=true` — launch day, the single day the shop
   * is least able to absorb a surprise — that early return would have deleted
   * **every security header below** along with the noindex, silently, with no
   * diff and no deploy to blame.
   *
   * So there is no early return. One array is built, and indexing decides
   * whether one entry is appended to it. `audit:headers` asserts the security
   * headers survive with `SITE_INDEXABLE=true`, so re-introducing the old shape
   * fails a gate rather than a launch.
   *
   * Read at build time, so lifting the noindex is one env var plus a redeploy.
   * See `src/lib/indexing.ts`.
   *
   * ## What is deliberately *not* here
   *
   *   - **`Strict-Transport-Security`.** Vercel already serves
   *     `max-age=63072000` on the custom domain. `includeSubDomains` and
   *     `preload` are both one-way doors — preload takes months to reverse and
   *     `includeSubDomains` binds every future subdomain of `footvault.in` to
   *     HTTPS — and the owner declined both on 2026-08-13 rather than take
   *     them as a side effect of a header sweep. Restating the Vercel default
   *     here would buy nothing and invite exactly that drive-by edit.
   *   - **`Content-Security-Policy`.** Shipping separately, Report-Only first,
   *     because a wrong one breaks payments silently. See the CSP section of
   *     the security brief.
   */
  async headers() {
    const headers = [...SECURITY_HEADERS];
    if (!isIndexable()) {
      headers.push({ key: "X-Robots-Tag", value: NOINDEX_HEADER });
    }
    return [{ source: "/:path*", headers }];
  },
  images: {
    /**
     * next/image only serves the qualities named here — Next 16 defaults the
     * allowlist to [75] and answers 400 for anything else. The hero asks for 82
     * (see home-sections.tsx), which meant the optimiser quietly clamped the
     * emitted srcset back to 75 while the code claimed otherwise, and a direct
     * request for q=82 returned 400. Naming it makes the number in the code the
     * number that ships.
     */
    qualities: [75, 82],
    /**
     * The seed catalog ships drawn SVG product assets (see
     * scripts/generate-seed-images.ts), and next/image refuses to serve SVG
     * without this flag because an SVG can carry script.
     *
     * ## The trust boundary, stated properly
     *
     * This comment used to rest on two reasons and said "both have to stay
     * true". **The first one is not true**, and has not been since the
     * `site-assets` bucket existed:
     *
     *   1. ~~Every SVG the optimiser sees is first-party~~ — migration 0011
     *      took `image/svg+xml` off `product-images` and `category-images`, but
     *      deliberately **left it on `site-assets`**, where a vector logo is
     *      the whole point. `remotePatterns` below admits
     *      `*.supabase.co/storage/v1/object/public/**`, which is that bucket.
     *      So the optimiser can and does serve an *uploaded* SVG.
     *   2. The CSP below is applied to optimised images, so even a hostile SVG
     *      is sandboxed with scripting off. **This one is load-bearing**, and
     *      it is now the only thing on this line that is.
     *
     * What actually bounds the risk, in the order it bites:
     *
     *   - **Who can put an SVG there.** `storage.objects` carries
     *     `admins upload storefront assets`, an INSERT policy gated on
     *     `is_admin()` (…_storage.sql). The bucket is public to *read* and
     *     admin-only to *write*, so a hostile SVG in `site-assets` presupposes
     *     an admin account, which already has strictly worse powers than
     *     serving a script. This is a trust boundary around the owner, not
     *     around a customer.
     *   - **Through the optimiser** (`/_next/image`): `contentSecurityPolicy`
     *     below sets `script-src 'none'; sandbox`, and
     *     `contentDispositionType: "attachment"` means a direct hit downloads
     *     rather than renders. Script does not run.
     *   - **Around the optimiser**, by pasting the Supabase public URL: that
     *     renders on `*.supabase.co`, a different origin from the shop. Script
     *     in it cannot read this site's cookies or localStorage, because the
     *     same-origin policy is doing the containing rather than us.
     *   - **In an `<img src>`**, which is how every storefront surface renders
     *     these: browsers do not execute script in an image-context SVG at all.
     *
     * The residual is an admin uploading a hostile SVG *and* linking somebody
     * to its raw Supabase URL, which lands script on Supabase's origin and not
     * on this shop's. Accepted, deliberately, and written down here so the next
     * person to read this line is not told something false about why.
     *
     * If `site-assets` ever needs to stop accepting SVG, the change is one
     * `allowed_mime_types` update — the same shape as 0011.
     */
    dangerouslyAllowSVG: true,
    contentDispositionType: "attachment",
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    remotePatterns: [
      {
        // Real photography, once the owner uploads it from /admin/products.
        protocol: "https",
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },
};

export default nextConfig;
