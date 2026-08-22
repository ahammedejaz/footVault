/**
 * Token substitution, and only that.
 *
 * ## Why it is not in `content-tokens.ts` any more
 *
 * That module is `server-only` and must stay so: it reads `site_settings`
 * through the service-role client to resolve what each token *means*. But the
 * substitution itself is a regex over a string with no I/O in it, and the pages
 * editor needs it in the browser — an owner typing `{{free_shipping_threshold}}`
 * into a policy page should see the threshold in the preview beside them, not
 * the braces.
 *
 * The alternative was for the preview to do its own small substitution. That is
 * exactly the arrangement `fillSectionTokens` was written to end one layer up:
 * two implementations of one rule agree until somebody teaches one of them
 * something. So the rule lives here, `content-tokens.ts` re-exports it, and the
 * browser and the server run the same characters.
 */

export type ContentTokens = Record<string, string>;

/**
 * Substitute, leaving anything unrecognised visible.
 *
 * The regex is deliberately narrow — lowercase, underscores, inside doubled
 * braces — so a price written as `{2,499}` in ordinary prose is untouched.
 *
 * An unknown token survives as typed rather than becoming an empty string. A
 * visible `{{free_shiping_threshold}}` is a typo somebody reports within the
 * hour; a silently blank sentence is not.
 */
export function fillTokens(text: string, tokens: ContentTokens): string {
  return text.replace(
    /\{\{\s*([a-z0-9_]+)\s*\}\}/g,
    (whole, name: string) => tokens[name] ?? whole,
  );
}
