import { fillTokens, type ContentTokens } from "@/lib/content-tokens";

import type { HomepageSection } from "@/lib/queries/content";

/**
 * Token substitution for a homepage section, applied once at the boundary.
 *
 * ## The defect this exists to remove
 *
 * `{{free_shipping_threshold}}` was documented as the mechanism that stops a
 * threshold going stale in owner-typed copy, and `audit:literals` fails the build
 * on a rupee figure in `homepage_sections.title`, `subtitle` or `payload` — so
 * the owner is *required* to write the token.
 *
 * It only worked in one place. `home-sections.tsx` called `fillTokens` on
 * `promo_strip` items and nowhere else, so a token typed into a hero headline, a
 * banner, a rail title or a subtitle rendered to the customer as the literal
 * characters `{{free_shipping_threshold}}`. Five of the six section types.
 *
 * The two halves of that are both bad and the second is worse: the gate insists
 * on a token, and the page then prints the token. An owner following the rule
 * correctly produced a broken homepage, and the only way out was to type the
 * number — which is the exact thing the gate exists to forbid.
 *
 * ## Why it is done here rather than at each use site
 *
 * Because "call `fillTokens` at every use site" is the instruction that was
 * already in place and was already forgotten five times out of six. Adding a
 * sixth call site is not a fix, it is the same arrangement with one more chance
 * to forget.
 *
 * So the whole section is resolved **before** it reaches a renderer. Every
 * renderer — including ones nobody has written yet — receives strings that are
 * already substituted, and forgetting is no longer an available mistake. The
 * walk is recursive because payloads nest: `promo_strip` holds
 * `items[{label, detail}]`, and a rule that only reached the top level would
 * re-create the bug one layer down.
 *
 * ## What it deliberately does not do
 *
 * It does not validate. A payload written before a schema existed, or edited by
 * hand in SQL, must still render — `home-sections.tsx` keeps its defensive
 * `payloadString` reads for that reason, and a homepage must not 500 because a
 * payload is half-written. This function only ever replaces one string with
 * another; a payload it does not understand passes through unharmed.
 *
 * Unknown tokens survive as typed, which is `fillTokens`' own rule: a visible
 * `{{free_shiping_threshold}}` is a typo somebody reports within the hour, and a
 * silently blank sentence is not.
 */
export function fillSectionTokens(
  section: HomepageSection,
  tokens: ContentTokens,
): HomepageSection {
  return {
    ...section,
    title: section.title === null ? null : fillTokens(section.title, tokens),
    subtitle:
      section.subtitle === null ? null : fillTokens(section.subtitle, tokens),
    payload: fillDeep(section.payload, tokens) as Record<string, unknown>,
  };
}

/**
 * Substitute every string anywhere in a JSON value, preserving its shape.
 *
 * Arrays and plain objects are rebuilt; everything else — numbers, booleans,
 * null — is returned as it came. Nothing is coerced: a payload key holding the
 * number `4` stays the number `4`, because a renderer reading it with
 * `typeof value === "number"` must keep working.
 */
function fillDeep(value: unknown, tokens: ContentTokens): unknown {
  if (typeof value === "string") return fillTokens(value, tokens);
  if (Array.isArray(value)) return value.map((item) => fillDeep(item, tokens));
  /*
    Plain objects only. `typeof null === "object"`, and a Date or any other class
    instance would be silently flattened into a bare object by the spread below —
    jsonb from PostgREST never contains one, and if that ever changes this should
    fail loudly at the type level rather than quietly reshape data.
  */
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        fillDeep(inner, tokens),
      ]),
    );
  }
  return value;
}
