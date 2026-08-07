/**
 * A colourway's slug, used in its image file names.
 *
 * Shared by the image generator and the seed so the two cannot drift. The seed
 * also derives the same string in Postgres — `trim(both '-' from
 * lower(regexp_replace(color, '[^a-zA-Z0-9]+', '-', 'g')))` — because the SQL
 * path builds the URLs set-based rather than listing 122 literals. All three
 * have to agree; a mismatch is a broken image on a product page.
 */
export function colorSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
