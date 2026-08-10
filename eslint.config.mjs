import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

import adminActionsMustGuard from "./eslint-rules/admin-actions-must-guard.mjs";
import noDerivedMoneyLine from "./eslint-rules/no-derived-money-line.mjs";
import noUncheckedSupabaseError from "./eslint-rules/no-unchecked-supabase-error.mjs";
import noHardcodedFontSize from "./eslint-rules/no-off-scale-type.mjs";

/**
 * The three project rules are here rather than in a published plugin because
 * they encode decisions this repo has already made and paid for:
 *
 *  - no-unchecked-supabase-error: a dropped PostgREST error renders as an empty
 *    page. Phase 1 shipped that bug three times; the shape is now a build
 *    failure rather than a thing to remember.
 *  - no-off-scale-type: docs/design-system.md fixes the type scale at seven
 *    steps. Tailwind ships more, and one `text-3xl` is all it takes for the
 *    scale to stop being a scale.
 *  - admin-actions-must-guard: a Server Action's endpoint id ships in the
 *    browser bundle, so an unguarded admin action is a public endpoint that
 *    reads like private code. Phase 6 added the panel; this makes forgetting
 *    the guard a build failure rather than a compromise.
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  {
    plugins: {
      footvault: {
        rules: {
          "no-unchecked-supabase-error": noUncheckedSupabaseError,
          "no-off-scale-type": noHardcodedFontSize,
          "admin-actions-must-guard": adminActionsMustGuard,
          "no-derived-money-line": noDerivedMoneyLine,
        },
      },
    },
    rules: {
      "footvault/no-unchecked-supabase-error": "error",
      "footvault/no-off-scale-type": "error",
      "footvault/admin-actions-must-guard": "error",
      "footvault/no-derived-money-line": "error",
    },
  },

  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent-created git worktrees hold stale copies of the tree; linting them
    // reports defects that were already fixed in the real checkout.
    ".claude/**",
  ]),
]);

export default eslintConfig;
