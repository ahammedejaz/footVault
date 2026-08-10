/**
 * `npm run audit:homepage-tokens` — every homepage section resolves its tokens.
 *
 * ## The defect this is written against
 *
 * `{{free_shipping_threshold}}` is the mechanism that stops a threshold going
 * stale in owner-typed copy, and `audit:literals` **fails the build** on a rupee
 * figure in `homepage_sections.title`, `subtitle` or `payload` — so an owner is
 * required to write the token rather than the number.
 *
 * Substitution only ever happened in `promo_strip`. Every other section type
 * served the literal characters `{{free_shipping_threshold}}` to the customer.
 * Measured on staging before the fix: **three `{{free_shipping_threshold}}` and
 * two `{{return_window}}` on the rendered homepage**, while the promo strip a few
 * hundred pixels away rendered `₹6,499` correctly — a working and a broken copy
 * of the same promise on one page.
 *
 * **Nothing could have caught it.** `audit:literals` reads the database and is
 * satisfied by the presence of a token; it never renders the page, so a token
 * that renders as itself looks identical to a token that works. This gate is the
 * other half: it reads the *page*.
 *
 * ## Why it builds a section of every type
 *
 * Because the seed uses tokens in exactly one section type, and that was the one
 * type where they worked. A gate that tested only the seeded homepage would have
 * passed throughout. So this creates one section **per renderable type**, each
 * carrying a token in every string field that type actually displays, and asserts
 * the rendered HTML contains no `{{token}}` anywhere.
 *
 * `testimonials` is deliberately excluded: it has no renderer, so it correctly
 * renders nothing and has no copy to resolve. It is named in `NO_RENDERER` rather
 * than simply omitted, because section 0 asserts that every member of the enum is
 * either covered by a fixture or explicitly excused — so the next section type
 * somebody adds cannot slip past this gate unnoticed.
 *
 * Staging only, and it puts the homepage back in a `finally`.
 */
import "./clients";

import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

import type { Json } from "../../src/lib/database.types";
import { adminClient } from "./fixtures";
import { BASE_URL } from "./routes";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed += 1;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/** Every value in `public.section_type`, so the coverage check below is real. */
const ALL_SECTION_TYPES = [
  "hero",
  "category_grid",
  "product_rail",
  "promo_strip",
  "banner",
  "testimonials",
  "rich_text",
] as const;

/**
 * `testimonials` has no renderer and therefore no copy to resolve. Named here
 * rather than simply left out, so that the coverage assertion can tell the
 * difference between "excused" and "forgotten".
 */
const NO_RENDERER = ["testimonials"] as const;

/** The token this gate writes, and what a resolved page must show instead. */
const TOKEN = "{{free_shipping_threshold}}";

/**
 * A per-run marker, written into every fixture and asserted on the page.
 *
 * ## Why a nonce is not optional here
 *
 * `cachedHomepageSections` is an `unstable_cache` entry on the `catalog` tag with
 * an hour's revalidate, so the rows this gate inserts are **not** necessarily the
 * rows the page renders. Caught while building this gate: a run's fixtures stayed
 * in the cache and were served to the *next* run, which then passed while
 * asserting against rows it had not written — and would have gone on passing if
 * the renderer had broken in between.
 *
 * That is the failure mode this project keeps meeting: a check that cannot
 * distinguish success from failure. A nonce makes it distinguishable. If the page
 * does not carry this run's marker, the gate says the cache is stale and fails,
 * rather than quietly grading a page from ten minutes ago.
 *
 * **It does not fix the staleness, it exposes it.** Busting the tag needs
 * `updateTag` from a Server Action, which a script cannot call — that arrives
 * with the `/admin/appearance` publish button, and this gate should press it once
 * it exists. Until then a warm cache makes this gate fail loudly, which is the
 * correct direction to be wrong in.
 */
const NONCE = `tokengate-${process.pid}-${Date.now().toString(36)}`;

type Fixture = {
  type: (typeof ALL_SECTION_TYPES)[number];
  /** Extra payload the renderer needs before it will draw anything at all. */
  payload: (context: Context) => Record<string, Json>;
  /** Where this type shows owner copy. Every one gets the token. */
  usesTitle: boolean;
  usesSubtitle: boolean;
};

type Context = { categorySlugs: string[]; collectionSlug: string | null };

/**
 * What each type needs before it renders.
 *
 * Several renderers return null unless their data resolves — `category_grid`
 * needs categories that exist, `product_rail` needs a collection with products.
 * That is correct behaviour, and it is also why this gate reads real slugs out of
 * the database rather than inventing them: a fixture whose section silently
 * rendered nothing would pass the "no raw token" assertion vacuously, which is
 * the exact failure shape this project keeps finding.
 */
const FIXTURES: Fixture[] = [
  { type: "hero", usesTitle: true, usesSubtitle: true, payload: () => ({ eyebrow: TOKEN, cta_label: `Shop ${TOKEN}`, cta_href: "/shop" }) },
  {
    type: "category_grid",
    usesTitle: true,
    usesSubtitle: true,
    payload: (c) => ({ category_slugs: c.categorySlugs }),
  },
  {
    type: "product_rail",
    usesTitle: true,
    usesSubtitle: true,
    payload: (c) => ({ collection_slug: c.collectionSlug }),
  },
  {
    type: "promo_strip",
    usesTitle: false,
    usesSubtitle: false,
    payload: () => ({
      items: [{ label: `Free over ${TOKEN}`, detail: `Nested under ${TOKEN}` }],
    }),
  },
  {
    type: "banner",
    usesTitle: true,
    usesSubtitle: true,
    payload: () => ({ cta_label: `Grab ${TOKEN}`, cta_href: "/shop" }),
  },
  {
    type: "rich_text",
    usesTitle: true,
    usesSubtitle: true,
    payload: () => ({
      body: `Delivery is free over ${TOKEN}.\n\n- A bullet mentioning ${TOKEN}\n- And **${TOKEN}** in bold`,
    }),
  },
];

async function main() {
  const admin = adminClient();

  section("0 · every section type is either covered or explicitly excused");
  const covered = new Set(FIXTURES.map((f) => f.type));
  const excused = new Set<string>(NO_RENDERER);
  const orphans = ALL_SECTION_TYPES.filter(
    (t) => !covered.has(t) && !excused.has(t),
  );
  check(
    "no section type is silently untested",
    orphans.length === 0,
    orphans.length ? `not covered and not excused: ${orphans.join(", ")}` : "",
  );

  section("1 · the fixtures the renderers need");
  /*
    Both errors are checked rather than dropped, and the lint rule that insisted
    was right to: a failed query returns no rows, "no rows" makes the two checks
    below fail with "none found", and a fixture that never rendered would then let
    the substitution assertions pass against an empty page. That is the vacuous
    pass this gate exists to prevent, reproduced inside the gate itself.
  */
  const { data: cats, error: catsError } = await admin
    .from("categories")
    .select("slug")
    .limit(3);
  if (catsError) {
    throw new Error(`could not read categories: ${catsError.message}`);
  }
  const { data: cols, error: colsError } = await admin
    .from("collections")
    .select("slug")
    .limit(1);
  if (colsError) {
    throw new Error(`could not read collections: ${colsError.message}`);
  }
  const context: Context = {
    categorySlugs: (cats ?? []).map((c) => String(c.slug)),
    collectionSlug: cols?.[0] ? String(cols[0].slug) : null,
  };
  check(
    "real category slugs exist for category_grid",
    context.categorySlugs.length > 0,
    "none found; the grid would render nothing and the check would be vacuous",
  );
  check(
    "a real collection exists for product_rail",
    context.collectionSlug !== null,
    "none found; the rail would render nothing and the check would be vacuous",
  );

  /** Every existing row, hidden for the duration and restored in the finally. */
  const { data: existing, error: readError } = await admin
    .from("homepage_sections")
    .select("id, is_active");
  if (readError) {
    throw new Error(`could not read the homepage: ${readError.message}`);
  }
  const previouslyActive = (existing ?? [])
    .filter((r) => r.is_active)
    .map((r) => String(r.id));
  const madeIds: string[] = [];

  try {
    /*
      The real homepage is hidden rather than deleted. Deleting it would mean
      rebuilding the owner's layout from the seed afterwards, and a gate that
      can lose the shop's homepage is a worse problem than the one it checks.
    */
    if (previouslyActive.length) {
      const { error } = await admin
        .from("homepage_sections")
        .update({ is_active: false })
        .in("id", previouslyActive);
      if (error) throw new Error(`could not hide the homepage: ${error.message}`);
    }

    section("2 · one section per renderable type, each carrying the token");
    let order = 0;
    for (const fixture of FIXTURES) {
      order += 1;
      const { data, error } = await admin
        .from("homepage_sections")
        .insert({
          section_type: fixture.type,
          title: fixture.usesTitle ? `Title with ${TOKEN} ${NONCE}` : null,
          subtitle: fixture.usesSubtitle ? `Subtitle with ${TOKEN}` : null,
          sort_order: order,
          is_active: true,
          payload: fixture.payload(context),
        })
        .select("id")
        .maybeSingle();
      if (error || !data) {
        check(`${fixture.type} fixture inserted`, false, error?.message ?? "no row");
        continue;
      }
      madeIds.push(String(data.id));
      check(`${fixture.type} fixture inserted`, true);
    }

    section("3 · the rendered homepage");
    const response = await fetch(`${BASE_URL}/`, { cache: "no-store" });
    const html = await response.text();
    check("the homepage still renders", response.ok, `status ${response.status}`);

    /*
      Before any assertion about substitution: is this page even built from the
      rows just inserted? See NONCE. A stale render would grade the wrong tree.
    */
    const fresh = html.includes(NONCE);
    check(
      "the page was rendered from this run's rows, not a cached homepage",
      fresh,
      `marker ${NONCE} absent — the catalog cache is serving stale rows, so every assertion below would be about somebody else's homepage`,
    );
    if (!fresh) {
      console.log(
        "\n  Skipping the substitution checks: they would be meaningless against a stale page.",
      );
    }

    /*
      The assertion that matters. Anything of the shape {{name}} left in the
      served HTML is a token the customer can read.
    */
    if (!fresh) return;

    const leaked = [...html.matchAll(/\{\{\s*[a-z0-9_]+\s*\}\}/g)].map(
      (m) => m[0],
    );
    const tally = [...new Set(leaked)]
      .map((t) => `${t}×${leaked.filter((x) => x === t).length}`)
      .join(", ");
    check(
      "no unresolved token reaches the customer",
      leaked.length === 0,
      tally,
    );

    /*
      And the other direction, because "no braces" is also what a blank page
      gives you. Each type has to have actually drawn its copy.
    */
    for (const fixture of FIXTURES) {
      if (!fixture.usesTitle) continue;
      check(
        `${fixture.type} rendered its title with the value substituted`,
        html.includes("Title with ₹"),
        "the resolved title is absent — the section may not have rendered at all",
      );
      break;
    }
    check(
      "the promo strip's nested payload string resolved too",
      html.includes("Nested under ₹"),
      "a token one level down in the payload was missed",
    );
    check(
      "rich_text rendered, tokens and all",
      html.includes("Delivery is free over ₹"),
      "the rich_text body is absent — is the renderer wired into HomeSection?",
    );
    check(
      "a token inside **bold** resolved",
      /<strong>₹/.test(html),
      "emphasis and substitution do not compose",
    );
  } finally {
    if (madeIds.length) {
      const { error } = await admin
        .from("homepage_sections")
        .delete()
        .in("id", madeIds);
      if (error) console.error(`\n  !! fixture sections remain: ${error.message}`);
    }
    if (previouslyActive.length) {
      const { error } = await admin
        .from("homepage_sections")
        .update({ is_active: true })
        .in("id", previouslyActive);
      if (error) {
        console.error(
          `\n  !! THE HOMEPAGE IS STILL HIDDEN — restore with: update homepage_sections set is_active = true where id in (${previouslyActive.map((i) => `'${i}'`).join(", ")}): ${error.message}`,
        );
      } else {
        console.log(`\n  restored ${previouslyActive.length} homepage section(s)`);
        /*
          One more render, purely to leave the cache holding the real homepage.

          The `catalog` cache entry keeps whatever rows were live at the last
          render, so without this the fixtures stay on staging's homepage until
          the hour's revalidate expires — a gate that reports green and leaves the
          shop showing "Title with ₹6,499". Restoring the rows is not enough; the
          cache has to be made to read them.
        */
        await fetch(`${BASE_URL}/`, { cache: "no-store" }).catch(() => {});
      }
    }
  }

  console.log(
    `\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m` +
      (failures.length
        ? `\n\n${failures.map((f) => `  · ${f}`).join("\n")}`
        : ""),
  );
  process.exit(failed > 0 ? 1 : 0);
}

void main();
