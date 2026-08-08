/**
 * footvault/admin-actions-must-guard
 *
 * Every exported Server Action under `src/lib/actions/admin/` must go through
 * `adminAction()` from `@/lib/admin/guard`.
 *
 * The threat is specific and it is not theoretical. A Server Action compiles to
 * a POST endpoint addressed by an opaque id, and that id is in the JavaScript
 * bundle every visitor downloads. The middleware 404 in
 * `src/lib/supabase/proxy.ts` guards *navigation to /admin* — it does not guard
 * an action invoked directly, because the action's route is not an /admin URL.
 * So an admin action that does not check `is_admin()` itself is callable by any
 * signed-in customer who read the bundle, and it looks completely fine in
 * review: it is in an admin folder, imported by an admin page, named
 * `deleteProduct`. Nothing about reading it says "public endpoint".
 *
 * One forgotten guard is a full compromise of the panel, and "remember to call
 * requireAdmin" is exactly the class of instruction this codebase has decided
 * not to rely on — see SHAPE_VERSION and no-unchecked-supabase-error for the
 * same argument applied to two earlier bugs.
 *
 * Flagged:
 *   export async function deleteProduct(id: string) { … }        // no guard
 *   export async function setStock(x) { const a = await currentAdmin(); … }
 *     — currentAdmin() alone is a *read* of who is asking. It returns null
 *       rather than refusing, so a caller who ignores the null proceeds. Only
 *       adminAction() both checks and short-circuits.
 *
 * Allowed:
 *   export async function deleteProduct(id: string) {
 *     return adminAction("deleteProduct", "adminMutation", async ({ supabase }) => { … });
 *   }
 *
 * Non-exported helpers are not flagged: they are unreachable from a browser,
 * because only exports of a "use server" module are registered as endpoints.
 */

const GUARD = "adminAction";

/** Only files that actually become admin Server Actions. */
const SCOPE = /src[\\/]lib[\\/]actions[\\/]admin[\\/]/;

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require every exported admin Server Action to authorize through adminAction(), which checks is_admin() server-side.",
    },
    schema: [],
    messages: {
      unguarded:
        '`{{name}}` is an exported Server Action, so its endpoint id is in the browser bundle and any signed-in customer can POST to it. Wrap the body in `adminAction("{{name}}", "adminMutation", async ({ supabase }) => …)` from @/lib/admin/guard. The middleware 404 does not protect this.',
      missingUseServer:
        'This file is under src/lib/actions/admin/ but has no "use server" directive, so its exports are not actions. Either add the directive or move the file — a half-registered admin module is how a guard gets skipped.',
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (!SCOPE.test(filename)) return {};

    return {
      Program(program) {
        const directive = program.body.find(
          (node) =>
            node.type === "ExpressionStatement" &&
            node.expression.type === "Literal" &&
            node.expression.value === "use server",
        );
        if (!directive) {
          context.report({ node: program, messageId: "missingUseServer" });
        }
      },

      ExportNamedDeclaration(node) {
        const declaration = node.declaration;
        if (!declaration) return;

        if (declaration.type === "FunctionDeclaration") {
          checkFunction(declaration, declaration.id?.name ?? "an export");
          return;
        }

        if (declaration.type === "VariableDeclaration") {
          for (const declarator of declaration.declarations) {
            const init = declarator.init;
            if (
              init &&
              (init.type === "ArrowFunctionExpression" ||
                init.type === "FunctionExpression")
            ) {
              checkFunction(
                init,
                declarator.id.type === "Identifier"
                  ? declarator.id.name
                  : "an export",
              );
            }
          }
        }
      },
    };

    /**
     * Does this function's body mention the guard anywhere inside it?
     *
     * Deliberately a containment check rather than a "first statement is a
     * return of adminAction(...)" check. Actions legitimately parse their input
     * before deciding what to do, and an early `return` on a validation failure
     * before the guard leaks nothing — it tells an unauthorised caller that a
     * string was too long, which they already knew. Requiring an exact shape
     * would make the rule fight the code and get suppressed, which is worse
     * than a rule with a slightly wider mouth.
     */
    function checkFunction(fn, name) {
      if (!fn.body || fn.body.type !== "BlockStatement") {
        // A concise arrow body: `export const f = async () => adminAction(…)`.
        if (mentionsGuard(fn.body)) return;
        context.report({ node: fn, messageId: "unguarded", data: { name } });
        return;
      }
      if (mentionsGuard(fn.body)) return;
      context.report({ node: fn, messageId: "unguarded", data: { name } });
    }

    function mentionsGuard(node) {
      let found = false;
      walk(node, (child) => {
        if (
          child.type === "CallExpression" &&
          child.callee.type === "Identifier" &&
          child.callee.name === GUARD
        ) {
          found = true;
        }
      });
      return found;
    }

    function walk(node, visit) {
      if (!node || typeof node.type !== "string") return;
      visit(node);
      for (const key of Object.keys(node)) {
        if (key === "parent") continue;
        const value = node[key];
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item && typeof item.type === "string") walk(item, visit);
          }
        } else if (value && typeof value.type === "string") {
          walk(value, visit);
        }
      }
    }
  },
};

export default rule;
