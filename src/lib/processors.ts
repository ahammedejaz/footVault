/**
 * Every third party that sees a customer's data, and how the shop can tell.
 *
 * ## Why this is a module and not a paragraph
 *
 * The privacy policy said, in the shop's own words:
 *
 * > "We do not sell it, and we do not share it with anyone other than the
 * > courier carrying your parcel."
 *
 * That was false on the day it was written and false in six directions at once.
 * The order goes to Razorpay to be charged, to Shiprocket to be carried, to
 * Resend to be emailed about, to Supabase to be stored, to Vercel to be served,
 * and the customer's identity may come from Google. None of that is wrong; all
 * of it is undisclosed, which under the DPDP Act is the part that matters.
 *
 * The defect has the same shape as the ₹2,499 incident `audit:literals` was
 * built for — **the system changed and the copy did not** — but it is not a
 * number, so a `{{token}}` cannot protect it. What it has instead is a
 * mechanism the threshold never had: the shop already declares, in
 * `src/lib/csp.ts`, exactly which external origins a browser is allowed to
 * reach. That list is maintained under pain of breaking payments, so it is kept
 * accurate by something much stronger than diligence.
 *
 * So `audit:privacy-processors` reads this file against that one, and against
 * the environment, and fails when a processor the shop actually uses is not
 * named on the privacy page. Adding a host to the CSP without naming its owner
 * in the policy stops being a silent falsehood and becomes a red build with the
 * hostname in the message.
 *
 * ## Three ways a processor is detected, because they arrive three ways
 *
 *   - **`hosts`** — the browser talks to them, so they are in the CSP. Razorpay
 *     and Supabase.
 *   - **`env`** — the *server* talks to them, so the browser never does and the
 *     CSP is silent. Shiprocket and Resend are exactly this, and are the reason
 *     the CSP alone is not a sufficient source: a gate built only on the
 *     allowlist would have declared the policy complete while two processors
 *     went unmentioned.
 *   - **`code`** — neither. Google sign-in is a top-level redirect, which no CSP
 *     directive governs, and it is configured in the Supabase dashboard rather
 *     than in any variable this repository can read. What the repository can
 *     read is whether the shop still offers the button.
 *
 * They compose, and Google is why. It arrived as `code` alone, and then the
 * contact page embedded a Google map — a frame, which the CSP does govern. It
 * carries both now, so neither route silently un-declares a processor the other
 * one still proves.
 *
 * `always` is the fourth and is not a detection at all: the shop cannot be
 * served without its host seeing every request.
 */

import { CSP_DIRECTIVES } from "./csp";

export type Processor = {
  /**
   * The name as it must appear on the privacy page, spelled the way a customer
   * would recognise it.
   */
  name: string;
  /** What they receive and why, in the words the page should be making plain. */
  purpose: string;
  /**
   * CSP host families that belong to this processor — the registrable part, so
   * four `razorpay.com` hosts are one processor and not four.
   */
  hosts?: string[];
  /**
   * Environment variables whose presence means the shop is configured to send
   * them data. Any one is enough.
   */
  env?: string[];
  /**
   * A source file and a symbol in it. Present means the feature still ships.
   * Deliberately narrow: it is a fact about this repository, checkable without
   * running anything.
   */
  code?: { file: string; symbol: string };
  /** Configured by existing. Carries its own reason rather than a bare `true`. */
  always?: string;
};

/**
 * The processors, in the order a customer meets them.
 *
 * A processor with neither `hosts`, `env`, `code` nor `always` cannot be
 * detected, and the gate rejects it rather than quietly never requiring it — an
 * entry nothing can trigger is worse than no entry, because it reads like
 * coverage.
 */
export const PROCESSORS: Processor[] = [
  {
    name: "Razorpay",
    purpose:
      "takes the payment. They receive the amount, the order reference, and whatever the customer types into their payment form — the shop never sees a card number",
    hosts: ["razorpay.com"],
  },
  {
    name: "Shiprocket",
    purpose:
      "carries the parcel. They receive the recipient's name, full delivery address, phone number and the contents of the order, and pass them to whichever courier actually collects it",
    env: ["SHIPROCKET_EMAIL", "SHIPROCKET_PASSWORD"],
  },
  {
    name: "Resend",
    purpose:
      "sends the shop's email. They receive the email address and the contents of each message — order confirmations, dispatch notices, delivery updates",
    env: ["RESEND_API_KEY"],
  },
  {
    name: "Supabase",
    purpose:
      "hosts the database and runs the sign-in. Every account, order and address is stored there",
    hosts: ["supabase.co"],
  },
  {
    /*
      Two routes, and the second one arrived later: sign-in is a top-level
      redirect that no CSP directive governs, and the map on `/page/contact` is
      a frame that one does. `hosts` is listed as well as `code` so that removing
      the sign-in button does not quietly un-declare a processor the contact page
      still loads on every visit — and so that the reverse check in section 1,
      which demands an owner for every host in the CSP, has one to find.
    */
    name: "Google",
    purpose:
      "signs customers in, for those who choose to use it — Google confirms who the customer is and returns their name and email address, and the shop never receives a Google password — and serves the map embedded on the contact page, which tells Google the IP address and browser of everybody who opens that page",
    hosts: ["google.com"],
    code: { file: "src/lib/actions/auth.ts", symbol: "signInWithGoogle" },
  },
  {
    name: "Vercel",
    purpose:
      "serves the website. Every request passes through them and is logged, which includes the visitor's IP address",
    always:
      "the shop is deployed there — a request cannot reach the site without passing through it, so there is no configuration to check",
  },
];

/**
 * CSP values that are not a third party: keywords, schemes, and the shop
 * itself.
 */
const NOT_A_THIRD_PARTY =
  /^'|^data:$|^blob:$|^upgrade-insecure-requests$|footvault\.in$/;

/**
 * The registrable host families the CSP admits, mapped to the directives that
 * named them.
 *
 * "Family" rather than "host" because `checkout.razorpay.com`,
 * `cdn.razorpay.com`, `api.razorpay.com` and three `lumberjack*` hosts are one
 * company with one privacy consequence. Taking the last two labels is crude and
 * is correct for every origin this shop has ever used; the gate reports what it
 * derived, so a case it gets wrong is visible rather than silent.
 */
export function cspHostFamilies(): Map<string, string[]> {
  const families = new Map<string, string[]>();
  for (const [directive, values] of Object.entries(CSP_DIRECTIVES)) {
    for (const value of values) {
      if (NOT_A_THIRD_PARTY.test(value)) continue;
      const host = value.replace(/^[a-z]+:\/\//, "").replace(/^\*\./, "");
      if (!host || host.includes("/")) continue;
      const family = host.split(".").slice(-2).join(".");
      // Deduplicated: six `razorpay.com` hosts across `script-src` is one fact
      // about that directive, and printing it six times buries the next line.
      const seen = families.get(family) ?? [];
      if (!seen.includes(directive)) seen.push(directive);
      families.set(family, seen);
    }
  }
  return families;
}
