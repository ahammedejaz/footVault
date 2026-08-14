/**
 * A `"use server"` module may only export async functions.
 *
 * Exporting a plain object from one type-checks, builds clean, and throws the
 * first time the action is invoked — which is in production, on a button press.
 * Phase 4 shipped exactly that (a `SIGN_IN_IDLE` constant) and it was found by
 * clicking. `export type` and `export interface` are erased at build time and
 * are fine.
 *
 * ## Why this is a script
 *
 * It was an inline shell loop. On CI that is bash and it works. Run in the zsh
 * that this repository is developed in, `for f in $directives` does **not**
 * word-split — zsh leaves `SH_WORD_SPLIT` off — so the loop ran once with all
 * 28 paths as a single filename, grep reported `No such file or directory`, and
 * the check printed a pass having tested nothing. Reported `1 "use server"
 * files` where there are 28.
 *
 * That is the second check in this workflow with that shape; the first was the
 * client-component guard, vacuous under BSD grep. Both are now scripts, and
 * both print what they scanned so a run that covers nothing is visibly wrong
 * rather than quietly green.
 *
 * The file list matches a *directive*, not a mention: `src/lib/orders/
 * replacement.ts` has a doc comment explaining this very rule, and a looser
 * match once tripped the check that enforces it. A directive is a
 * string-literal statement on its own line, and both quote styles are matched
 * because Prettier's choice is not a rule.
 */
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const DIRECTIVE = /^[ \t]*(["'])use server\1;?[ \t]*$/m;

/** Faithful to the shell version this replaces, including its exclusions. */
const SUSPECT = /^export (const|let|var|class|enum|function[^ ]*[^c] )/;
const ALLOWED = /^export (async function|type|interface)/;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.tsx?$/.test(entry.name)) yield path;
  }
}

const offenders = [];
let scanned = 0;

for (const file of walk("src")) {
  const source = readFileSync(file, "utf8");
  if (!DIRECTIVE.test(source)) continue;
  scanned += 1;
  source.split("\n").forEach((line, index) => {
    if (SUSPECT.test(line) && !ALLOWED.test(line)) {
      offenders.push(`${file}:${index + 1}  ${line.trim()}`);
    }
  });
}

if (scanned === 0) {
  console.error(
    'No "use server" files found under src/. That is not a pass — this repository\n' +
      "has 28 of them, so either the directive changed spelling or this script is\n" +
      "looking in the wrong place.",
  );
  process.exit(1);
}

if (offenders.length > 0) {
  console.error('A "use server" file may only export async functions:');
  for (const line of offenders) console.error(`  ${line}`);
  process.exit(1);
}

console.log(
  `${scanned} "use server" files scanned, all export only async functions.`,
);
