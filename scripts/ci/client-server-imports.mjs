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
  ## The list is derived, not named

  This used to hard-code three specifiers — `@/lib/supabase/{server,admin,static}`
  and anything under `@/lib/queries/` — which is the same shape of mistake as the
  named column list in `audit:literals`: it can only cover what somebody
  remembered. On 2026-08-15 a Client Component value-imported `@/lib/payments/health`,
  which carries `import "server-only"` and was not on the list. This guard printed
  a tick; the *build* caught it, several minutes later, with a stack trace.

  So the list is now every module under `src/` whose first lines say
  `import "server-only"`. A module that adopts the directive tomorrow is covered
  the day it does, and a module that drops it stops being flagged for the right
  reason rather than because nobody updated a regex.
*/
const serverOnly = execSync(`grep -rl 'server-only' src --include=*.ts --include=*.tsx || true`, {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean)
  // `import "server-only"` proper, not a mention of the string in a comment —
  // several files in this repository explain the boundary at length.
  .filter((file) => /^\s*import\s+"server-only";/m.test(readFileSync(file, "utf8")))
  // src/lib/foo/bar.ts -> @/lib/foo/bar
  .map((file) => file.replace(/^src\//, "@/").replace(/\.tsx?$/, ""));

if (serverOnly.length === 0) {
  console.error(
    'No `import "server-only"` modules found under src/. That is not a pass —\n' +
      "either the directive changed spelling or this script is looking in the\n" +
      "wrong place, and either way it is about to scan for nothing.",
  );
  process.exit(1);
}

const escaped = serverOnly
  .map((specifier) => specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

/*
  Matches an import/export statement that is NOT `import type` / `export type`,
  up to its `from` clause. `[^;]*?` cannot cross a statement boundary because
  Prettier ends every statement with a semicolon, so a multi-line
  `import type {\n … \n} from "@/lib/queries/…"` is correctly ignored — that
  shape is what kept the old grep red on main for two days. An inline-mixed
  `import { type A, b } from` is still a value import and is still flagged.

  A type-only import is allowed on purpose: it is erased at compile time and
  reaches no server code, and the query modules are where the shared view models
  are inferred from. What this stops is a *value* reaching the browser bundle.
*/
const VALUE_IMPORT = new RegExp(
  `\\b(import|export)\\s+(?!type\\b)[^;]*?from\\s+"(${escaped})"`,
);

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
  `${files.length} "use client" files scanned against ${serverOnly.length} ` +
    "server-only modules, none value-imports one.",
);
