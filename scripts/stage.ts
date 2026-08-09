/**
 * Run any command against the staging Supabase project.
 *
 *   npm run dev:stage                     # the dev server the gates drive
 *   npm run seed:stage                    # the catalog, into staging
 *   npm run stage -- npx tsx scripts/audit/teardown.ts --dry-run
 *
 * ## Why this exists rather than a line in package.json
 *
 * The browser gates drive a real `next dev`, and that server reads
 * `NEXT_PUBLIC_SUPABASE_URL` from `.env.local` — which is production. Pointing
 * `scripts/audit/clients.ts` at staging without pointing the server there too
 * produces the single worst outcome available: fixtures written into staging,
 * a browser measuring production, and a gate that passes. Both halves have to
 * move together, so both read `scripts/staging-env.ts`.
 *
 * The values cannot be inlined into an npm script because they live in
 * `.env.local`, which npm does not read. And they must arrive as *environment*
 * rather than as another env file, because Next resolves `process.env` before
 * `.env.local`: `@next/env` only assigns a key it does not already find set
 * (`loadEnvConfig` → `processEnv`, the `typeof p[t] === "undefined"` test). So
 * a variable exported into the child process wins over the same name in
 * `.env.local` — which is exactly the override this needs, and the reason a
 * `.env.staging` file would not have worked: `.env.local` outranks it.
 *
 * ## The port
 *
 * 3210, not 3000. Every harness in `scripts/audit/` defaults to
 * `http://localhost:3210` (`AUDIT_BASE_URL` in `routes.ts`), so a server on
 * 3210 makes `npm run audit:overflow` and friends work with no extra
 * environment — and, more to the point, makes it impossible to measure a
 * *different* server that happens to be on 3000. Override with `PORT`.
 *
 * The staging project's own Site URL is `http://localhost:3000`, which matters
 * only for the Google sign-in redirect; nothing in the gates uses it, because
 * `fixtures.ts` signs up with email and password.
 */
import { spawn } from "node:child_process";

import {
  loadEnvLocal,
  requireStagingCredentials,
  RUNTIME_VARS,
  isStagingUrl,
  STAGING_PROJECT_REF,
  STAGING_VARS,
} from "./staging-env";

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error(
      "Usage: tsx scripts/stage.ts <command> [args...]\n" +
        "  e.g. tsx scripts/stage.ts next dev --port 3210",
    );
    process.exit(2);
  }

  loadEnvLocal();
  const staging = requireStagingCredentials();

  /**
   * The last check before a real server starts.
   *
   * `scripts/audit/clients.ts` guards the process that writes fixtures. This
   * guards the process that *serves the pages those fixtures are measured on*,
   * and it is a separate process with a separate copy of the environment — so a
   * `SUPABASE_STAGE_URL` quietly holding a production ref would sail past the
   * other guard entirely. Refuse here too, by name.
   */
  if (!isStagingUrl(staging.url)) {
    console.error(
      `\n${STAGING_VARS.url} does not point at the staging project.\n\n` +
        `  got:      ${staging.url}\n` +
        `  expected: a URL containing ${STAGING_PROJECT_REF}\n\n` +
        `  Refusing to start a server against it. See docs/staging.md.\n`,
    );
    process.exit(1);
  }

  const env = {
    ...process.env,
    [RUNTIME_VARS.url]: staging.url,
    [RUNTIME_VARS.anonKey]: staging.anonKey,
    [RUNTIME_VARS.serviceKey]: staging.serviceKey,
    // So a harness started as a child of this — `npm run stage -- ...` — reads
    // the same project rather than falling back to .env.local.
    AUDIT_TARGET: "staging",
  };

  // The project ref is public: it is the hostname of every request the browser
  // makes. The keys are not, and are never printed — only whether they are set.
  console.log(
    `\nstaging · ${STAGING_PROJECT_REF} · ` +
      `anon key set · service-role key set\n` +
      `  ${command} ${args.join(" ")}\n`,
  );

  const child = spawn(command, args, { stdio: "inherit", env, shell: false });
  child.on("error", (error) => {
    console.error(`could not start ${command}: ${error.message}`);
    process.exit(1);
  });
  // Forward the signals a dev server is expected to die from, so Ctrl-C stops
  // the server rather than orphaning it behind a dead wrapper.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main();
