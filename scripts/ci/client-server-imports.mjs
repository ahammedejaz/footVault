/**
 * A Client Component may not *value*-import a server-only module.
 *
 * Next turns that into a build error, but only for a value import. A type-only
 * import is erased at compile time and reaches no server code, so it is allowed
 * on purpose: the query modules are where the shared view models are inferred
 * from, and making every client file re-declare them by hand is a worse boundary
 * than letting the types flow. What this stops is a *value* reaching the browser
 * bundle.
 *
 * ## Why this is a script and not a line of YAML
 *
 * It used to be a shell loop around `grep -Pzq`. `-P` is a GNU extension, and
 * BSD grep — every macOS checkout — does not have it. Run there, every
 * invocation exits with `grep: invalid option -- P`, `offenders` stays empty,
 * and the check prints nothing and succeeds. **It passed because it failed.**
 * Green on Ubuntu, vacuous on the machine the code is written on, which is the
 * worst place for a guard to be absent.
 *
 * That is the same defect this repository keeps hitting — a check whose failure
 * mode is silence. `npm run lint | tail -4 && echo OK` printed OK over a real
 * error; `audit:literals` reported one match per column and hid the second; and
 * this. So the pattern moved into a regex engine that exists wherever Node
 * does, and the script reports what it *scanned* rather than only what it
 * found: a run that scans zero files is now visibly wrong instead of quietly
 * green.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/*
  Matches an import/export statement that is NOT `import type` / `export type`,
  up to its `from` clause. `[^;]*?` cannot cross a statement boundary because
  Prettier ends every statement with a semicolon, so a multi-line
  `import type {\n … \n} from "@/lib/queries/…"` is correctly ignored — that
  shape is what kept the old grep red on main for two days. An inline-mixed
  `import { type A, b } from` is still a value import and is still flagged.
*/
const VALUE_IMPORT =
  /\b(import|export)\s+(?!type\b)[^;]*?from\s+"@\/lib\/(supabase\/(server|admin|static)"|queries\/)/;

const files = execSync(`grep -rln '"use client"' src || true`, {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

if (files.length === 0) {
  console.error(
    'No "use client" files found under src/. That is not a pass — either the\n' +
      "directive changed spelling or this script is looking in the wrong place.",
  );
  process.exit(1);
}

const offenders = files.filter((file) =>
  VALUE_IMPORT.test(readFileSync(file, "utf8")),
);

if (offenders.length > 0) {
  console.error(
    "Client components importing a server-only module (value import):",
  );
  for (const file of offenders) console.error(`  ${file}`);
  process.exit(1);
}

console.log(
  `${files.length} "use client" files scanned, none value-imports a server-only module.`,
);
