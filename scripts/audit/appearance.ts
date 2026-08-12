/**
 * `npm run audit:appearance` — the homepage editor, operated like an owner.
 *
 *   npm run dev:stage          # a server on :3210, pointed at staging
 *   npm run audit:appearance
 *
 * ## What this proves, in one sentence each
 *
 *   - Reordering in the editor and publishing **changes the live homepage's
 *     order** — asserted against the served HTML of `/`, not against the
 *     editor's own optimism.
 *   - Hide removes a section from the live page; Show returns it.
 *   - Preview renders the *unpublished* layout through the real renderer —
 *     tokens resolved — while the database provably does not change. This is
 *     also the proof that returning elements from the Server Action works,
 *     which the preview design leans on.
 *   - Add and Delete round-trip: a section created here appears live with its
 *     token substituted, and deleting it removes the row, with the editor
 *     naming the removal before Publish is pressed.
 *
 * Every control is operated by its **visible, accessible name** — the same
 * rule `audit:settings-controls` enforces, for the same reason: a control this
 * harness cannot find by name is a control a screen reader cannot name.
 *
 * ## Why the drag handle is not driven
 *
 * Reorder is asserted through the arrow buttons, which are the mechanism of
 * record (WCAG 2.2 SC 2.5.7 requires the single-pointer alternative; a
 * keyboard user gets the arrows, not the drag). Native HTML5 drag in headless
 * Playwright needs a synthetic event sequence that passes without any real
 * drag machinery attached — a green result there would prove the *simulation*,
 * not the control. The arrows drive the identical `move()`.
 *
 * Staging only. The layout is snapshotted first and restored in a `finally`,
 * and the last act is a fetch of `/` so the cache is left holding the real
 * homepage rather than this file's fixtures — the lesson `audit:homepage-tokens`
 * learned the observable way.
 */
import "./clients";
import { assertNotProduction } from "./clients";

assertNotProduction("run the appearance audit");

import { readFileSync } from "node:fs";

import AxeBuilder from "@axe-core/playwright";
import { chromium, type Page } from "playwright";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

import type { Json } from "../../src/lib/database.types";
import { adminClient, createAccount, sessionCookies } from "./fixtures";
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

/** The served homepage, as text. `no-store` so no fetch-side cache interferes. */
async function liveHomepage(): Promise<string> {
  const response = await fetch(`${BASE_URL}/`, { cache: "no-store" });
  return response.text();
}

/** Press Publish and give the round trip room. The read-backs are the assertions. */
async function publish(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.waitForTimeout(3_000);
}

type SectionRow = {
  id: string;
  section_type:
    | "hero"
    | "category_grid"
    | "product_rail"
    | "promo_strip"
    | "banner"
    | "testimonials"
    | "rich_text";
  title: string | null;
  subtitle: string | null;
  payload: Json;
  sort_order: number;
  is_active: boolean;
};

/** Where section 6's placeholder clip lives when staging has no real one. */
const FIXTURE_CLIP_PATH = "qa-appearance-fixture.mp4";

async function main() {
  const admin = adminClient();
  let fixtureClipInstalled = false;

  /* The layout as it stands, for the finally. */
  const { data: originals, error: snapError } = await admin
    .from("homepage_sections")
    .select("id, section_type, title, subtitle, payload, sort_order, is_active")
    .order("sort_order");
  if (snapError || !originals) {
    throw new Error(`could not snapshot the homepage: ${snapError?.message}`);
  }
  const originalRows = originals as SectionRow[];

  const account = await createAccount("appearance");
  {
    const { error } = await admin
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", account.userId);
    if (error) throw new Error(`could not promote the probe: ${error.message}`);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
  });
  await context.addCookies(await sessionCookies(account.session));
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const open = async () => {
    await page.goto(`${BASE_URL}/admin/appearance`, { waitUntil: "load" });
  };

  try {
    /* ═══ 1 · the editor shows the whole layout ═══════════════════════════ */
    section("1 · the editor lists every section, in order");
    await open();
    const heroTitle = originalRows[0]?.title ?? "";
    check(
      "the run has a seeded homepage to work with",
      originalRows.length >= 3 && heroTitle.length > 0,
      `${originalRows.length} rows`,
    );
    let allListed = true;
    for (const row of originalRows) {
      const name = row.title ?? row.section_type;
      if (!(await page.getByText(name, { exact: false }).first().isVisible())) {
        allListed = false;
        check(`"${name}" is on the editor page`, false);
      }
    }
    if (allListed) {
      check(`all ${originalRows.length} sections are on the editor page`, true);
    }

    /* ═══ 2 · reorder, publish, and the live page moves ═══════════════════ */
    section("2 · reorder is real: the live page changes order");
    const second = originalRows[1];
    const secondName = second?.title ?? second?.section_type ?? "";
    {
      const before = await liveHomepage();
      const heroFirst =
        before.indexOf(heroTitle) !== -1 &&
        before.indexOf(secondName) !== -1 &&
        before.indexOf(heroTitle) < before.indexOf(secondName);
      check(
        "before: the hero precedes the second section on the live page",
        heroFirst,
        "the baseline order is not what the seed says — refusing to assert on top of it",
      );

      await page
        .getByRole("button", { name: `Move ${secondName} up` })
        .click();
      await publish(page);

      const after = await liveHomepage();
      check(
        "after publish: the second section now precedes the hero live",
        after.indexOf(secondName) !== -1 &&
          after.indexOf(heroTitle) !== -1 &&
          after.indexOf(secondName) < after.indexOf(heroTitle),
        "the live page did not change order",
      );

      /* Put it back through the same control, which is itself the down-arrow's test. */
      await page
        .getByRole("button", { name: `Move ${secondName} down` })
        .click();
      await publish(page);
      const restored = await liveHomepage();
      check(
        "moving it back down restores the live order",
        restored.indexOf(heroTitle) < restored.indexOf(secondName),
      );
    }

    /* ═══ 3 · hide and show ═══════════════════════════════════════════════ */
    section("3 · hide removes it from the live page; show returns it");
    {
      const last = originalRows[originalRows.length - 1];
      const lastName = last.title ?? last.section_type;
      /* The probe string must be one the live page actually renders. */
      const probe = lastName;

      await page.getByRole("button", { name: `Hide ${lastName}` }).click();
      await publish(page);
      check(
        `hidden: "${probe}" is gone from the live page`,
        !(await liveHomepage()).includes(probe),
      );

      await page.getByRole("button", { name: `Show ${lastName}` }).click();
      await publish(page);
      check(
        `shown again: "${probe}" is back on the live page`,
        (await liveHomepage()).includes(probe),
      );
    }

    /* ═══ 4 · preview renders the unpublished layout and writes nothing ══ */
    section("4 · preview: real renderer, resolved tokens, zero writes");
    {
      const hero = originalRows[0];
      await open();
      await page.getByRole("button", { name: `Edit ${heroTitle}` }).click();
      const marker = "QA preview {{free_shipping_threshold}}";
      await page.getByLabel("Title", { exact: true }).first().fill(marker);
      await page.getByRole("button", { name: "Preview", exact: true }).click();
      await page.waitForTimeout(3_000);

      const pane = page.getByRole("region", {
        name: "Preview of the homepage",
      });
      const paneText = (await pane.count())
        ? await pane.innerText()
        : "";
      check(
        "the preview pane rendered the edited title with its token resolved",
        paneText.includes("QA PREVIEW ₹") || paneText.includes("QA preview ₹"),
        paneText.slice(0, 120) || "no preview pane appeared",
      );
      check(
        "the raw token does not appear in the preview",
        !paneText.includes("{{free_shipping_threshold}}"),
      );

      const { data: rowNow, error: rowNowError } = await admin
        .from("homepage_sections")
        .select("title")
        .eq("id", hero.id)
        .maybeSingle();
      /* A read that failed must not impersonate "the title is unchanged". */
      if (rowNowError) {
        check("the database row could be re-read", false, rowNowError.message);
      }
      check(
        "the database row is untouched by preview",
        rowNow?.title === hero.title,
        `stored title is now ${JSON.stringify(rowNow?.title)}`,
      );
      check(
        "the live page is untouched by preview",
        !(await liveHomepage()).includes("QA preview"),
      );
    }

    /* ═══ 5 · add a section, publish, delete it, publish ═════════════════ */
    section("5 · a section created here goes live, then goes away");
    {
      const body =
        "QA appearance: free over {{free_shipping_threshold}}, said by a section this test created.";
      await open();
      await page.getByRole("button", { name: "Add a section" }).click();
      await page.getByRole("button", { name: /Text block/ }).click();
      await page.getByLabel("Title", { exact: true }).last().fill("QA text block");
      await page.getByLabel("The words").fill(body);
      await publish(page);

      const live = await liveHomepage();
      check(
        "the new section is on the live page with its token resolved",
        live.includes("QA appearance: free over ₹"),
        live.includes("QA appearance")
          ? "present but the token did not resolve"
          : "absent entirely",
      );
      const { count: afterAdd, error: afterAddError } = await admin
        .from("homepage_sections")
        .select("id", { count: "exact", head: true });
      if (afterAddError) {
        check("the row count could be read", false, afterAddError.message);
      }
      check(
        "the row exists",
        afterAdd === originalRows.length + 1,
        `${afterAdd} rows`,
      );

      await page
        .getByRole("button", { name: "Delete QA text block" })
        .click();
      check(
        "the editor names what publishing will remove",
        await page
          .getByText(/Publishing will permanently remove: QA text block/)
          .isVisible(),
      );
      await publish(page);
      check(
        "deleted: the section is gone from the live page",
        !(await liveHomepage()).includes("QA appearance: free over"),
      );
      const { count: afterDelete, error: afterDeleteError } = await admin
        .from("homepage_sections")
        .select("id", { count: "exact", head: true });
      if (afterDeleteError) {
        check("the row count could be re-read", false, afterDeleteError.message);
      }
      check(
        "and the row is gone",
        afterDelete === originalRows.length,
        `${afterDelete} rows`,
      );
    }

    /* ═══ 6 · the hero's media mode, operated by its visible label ═══════ */
    section("6 · the video/still switch does what its label says");
    {
      /*
        The switch is only meaningful with a clip to keep or lose. Production
        has one the owner uploaded; a staging database rebuilt from empty has
        an empty `site-video` bucket and a hero with no `video_url` — the seed
        cannot carry a binary. Without this block, "switching back restores
        the clip" is unprovable on exactly the database the suite runs
        against, which is how this section sat red the first time it ran.

        So: no clip configured → install one. A tiny placeholder object in the
        real bucket (the assertion greps the served HTML for the URL; nothing
        plays it), and `video_url` written onto the hero the same way the
        uploader action would. Removed in the finally; the payload itself is
        covered by the wholesale row restore.
      */
      const heroRow = originalRows.find((row) => row.section_type === "hero");
      const heroPayload = (heroRow?.payload ?? {}) as Record<string, unknown>;
      if (
        heroRow &&
        !String(heroPayload.video_url ?? "").includes("site-video")
      ) {
        const { error: uploadError } = await admin.storage
          .from("site-video")
          .upload(FIXTURE_CLIP_PATH, Buffer.from("qa fixture, never played"), {
            contentType: "video/mp4",
            upsert: true,
          });
        if (uploadError) {
          check(
            "a fixture clip could be installed for the switch to operate on",
            false,
            uploadError.message,
          );
        } else {
          fixtureClipInstalled = true;
          const { data: publicUrl } = admin.storage
            .from("site-video")
            .getPublicUrl(FIXTURE_CLIP_PATH);
          const { error: patchError } = await admin
            .from("homepage_sections")
            .update({
              payload: {
                ...heroPayload,
                video_url: publicUrl.publicUrl,
                media_mode: "video",
              } as Json,
            })
            .eq("id", heroRow.id);
          if (patchError) {
            check(
              "the fixture clip could be wired onto the hero",
              false,
              patchError.message,
            );
          }
        }
      }
      /*
        The rule `audit:settings-controls` is the mechanism for: an owner-facing
        control ships with a test that finds it **by its visible label**,
        changes it, and asserts the stored value changed. `getByRole("radio",
        { name })` resolves through the accessible name, so a switch a screen
        reader cannot name fails here.

        And then one step further, because a stored value is not a feature: the
        live homepage is re-fetched and asserted to contain no `<video>` at all.
        That is the property the mode exists to produce — no element, no bytes —
        and asserting the payload alone would pass in a world where the renderer
        ignored the field entirely.
      */
      await open();
      await page.getByRole("button", { name: `Edit ${heroTitle}` }).click();

      const stillOnly = page.getByRole("radio", { name: /Still image only/ });
      const videoMode = page.getByRole("radio", { name: /^Video/ });
      check(
        "both modes are on the page and reachable by their visible names",
        (await stillOnly.count()) === 1 && (await videoMode.count()) === 1,
        `${await stillOnly.count()} still, ${await videoMode.count()} video`,
      );

      const heroId = originalRows.find((row) => row.section_type === "hero")?.id;
      const modeNow = async () => {
        const { data, error } = await admin
          .from("homepage_sections")
          .select("payload")
          .eq("id", heroId!)
          .single();
        // A dropped error here would read as "the field is absent", which is
        // indistinguishable from "the switch did nothing" — the exact result
        // this section is trying to tell apart.
        if (error) throw new Error(`could not re-read the hero: ${error.message}`);
        return (data?.payload as Record<string, unknown> | null)?.media_mode;
      };

      await stillOnly.check();
      await publish(page);
      check("choosing “Still image only” stores it", (await modeNow()) === "poster");
      const stillHtml = await liveHomepage();
      check(
        "and the live homepage then has no <video> element at all",
        !/<video[\s>]/i.test(stillHtml) && !stillHtml.includes("site-video"),
        "poster mode must cost zero video bytes, not hide a loaded one",
      );

      await open();
      await page.getByRole("button", { name: `Edit ${heroTitle}` }).click();
      await page.getByRole("radio", { name: /^Video/ }).check();
      await publish(page);
      check("choosing “Video” stores it", (await modeNow()) === "video");
      check(
        "and the live homepage carries the video again",
        (await liveHomepage()).includes("site-video"),
        "switching back must restore the clip, not lose it",
      );
    }

    /* ═══ 7 · the page is clean ═══════════════════════════════════════════ */
    section("7 · axe, with the editor open");
    {
      await open();
      await page.getByRole("button", { name: `Edit ${heroTitle}` }).click();
      /*
        Let the previous section's publish toast leave the stage first. Axe once
        caught a color-contrast node here that no standalone scan of the same
        state could reproduce — the sonner toast from section 5 was still
        visible during the scan. A gate that reddens on a toast's exit
        animation teaches people to re-run gates until they pass.
      */
      await page.waitForTimeout(4_500);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      check(
        "axe finds no violations with a section expanded",
        results.violations.length === 0,
        results.violations.map((v) => `${v.id} (${v.nodes.length})`).join("; "),
      );
      check(
        "no uncaught page errors across the whole run",
        pageErrors.length === 0,
        pageErrors.join("; "),
      );
    }
  } finally {
    /*
      Wholesale restore: the published layout may differ from the snapshot in
      ids and rows, so everything goes and the originals return under their own
      ids. Then one fetch of `/`, so the cache serves the restored homepage
      rather than this file's last fixture — verified, not assumed.
    */
    const { error: wipeError } = await admin
      .from("homepage_sections")
      .delete()
      .gte("sort_order", -1);
    if (wipeError) {
      console.error(`\n  !! could not clear the fixtures: ${wipeError.message}`);
    }
    const { error: restoreError } = await admin
      .from("homepage_sections")
      .insert(originalRows);
    if (restoreError) {
      console.error(
        `\n  !! THE HOMEPAGE IS NOT RESTORED — reseed with npm run seed:stage: ${restoreError.message}`,
      );
    } else {
      await fetch(`${BASE_URL}/`, { cache: "no-store" }).catch(() => {});
      const served = await fetch(`${BASE_URL}/`, { cache: "no-store" })
        .then((r) => r.text())
        .catch(() => "");
      const firstTitle = originalRows[0]?.title ?? "";
      if (firstTitle && served.includes(firstTitle)) {
        console.log(`\n  restored ${originalRows.length} homepage section(s), and the live page serves them`);
      } else {
        console.error(
          "\n  !! rows restored but the served homepage does not show them yet — the cache may lag",
        );
      }
    }
    if (fixtureClipInstalled) {
      const { error: clipError } = await admin.storage
        .from("site-video")
        .remove([FIXTURE_CLIP_PATH]);
      if (clipError) {
        console.error(`\n  !! fixture clip not removed: ${clipError.message}`);
      }
    }
    await admin.auth.admin.deleteUser(account.userId).catch(() => {});
    await browser.close();
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
