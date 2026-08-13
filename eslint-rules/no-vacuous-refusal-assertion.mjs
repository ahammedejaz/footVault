/**
 * footvault/no-vacuous-refusal-assertion
 *
 * `someError !== null` is not evidence that a security control refused
 * anything. In the audit harnesses, it may not be an assertion's condition.
 *
 * ## The defect this encodes
 *
 * A refused write against this database comes back as one of five things, and a
 * boolean cannot tell them apart:
 *
 *   42501 "permission denied for table X"      — no GRANT
 *   42501 "permission denied for function X"   — no GRANT EXECUTE
 *   42501 "new row violates row-level …"       — an RLS policy
 *   FVADM "not_admin"                          — the function's own check
 *   PGRST202 "Could not find the function …"   — *nothing refused it*
 *
 * Three of those share a SQLSTATE, and the last is not a refusal at all. A gate
 * asserting `error !== null` therefore passes when the control it names has
 * been deleted and something unrelated errored instead. Found three times:
 *
 *  - `audit:security-advance` §3: a migration added a parameter to
 *    `create_order_with_stock`; the gate's fixed-arity POST started answering
 *    PGRST202; `error !== null` read that as "refused" and stayed green for two
 *    days while the new 26-argument function sat executable by `anon`. A new
 *    arity is a new function and inherits no ACL.
 *  - `audit:admin` §2: eight admin-only tables asserted unreadable via
 *    `rows === 0`. Five were empty, so five ticks were `0 === 0` — demonstrated
 *    by disabling RLS on `coupons` and watching the gate report 8 held.
 *  - `audit:coins-earning`: a check whose *label* said "no grant, not merely no
 *    policy" and whose condition could not distinguish the two.
 *
 * Every one of those survives testing, because the gate does pass — it just
 * passes for a reason other than the one it claims. That is what makes it a
 * lint rule rather than a test.
 *
 * ## What to write instead
 *
 * `scripts/audit/refusal.ts`:
 *
 *   g.verdict("X refuses a customer", refusedBy(error, "app-check"));
 *   g.verdict("Y is unreadable", await unreadableBy({ admin, caller, table,
 *     expect: ["rls-read"], witness }));
 *   g.verdict("Z is unchanged", await unchangedBy({ attempt, readBack }));
 *
 * ## Scope
 *
 * `scripts/audit/` only. Application code legitimately branches on "did this
 * fail" without caring why; a security gate never does.
 *
 * Flagged — an error-null comparison as the condition of an assertion call:
 *   check("refuses a customer", error !== null);
 *   ok("is refused", forgeError !== null, "detail");
 *   check("unreadable", readError !== null || (data?.length ?? 0) === 0);
 *
 * Not flagged:
 *   - control flow: `if (error !== null) throw new Error(...)` — a harness
 *     giving up on its own setup is not making a claim about a control.
 *   - `!error` / `error === null` — asserting something *worked* is the
 *     opposite direction and has no layer to name.
 *   - a bare `rows.length === 0`, which is ambiguous without semantics: it is
 *     the vacuous shape in a refusal check and the correct shape in a
 *     reconciliation (`drift.length === 0`). Only the compound
 *     `error !== null || …length === 0` is unambiguous, and that is caught by
 *     its first half anyway.
 */

/** The assertion helpers the harnesses declare. `verdict` is the fixed form. */
const ASSERTION_CALLEES = new Set(["check", "ok", "assert", "expect"]);

/** `error`, `readError`, `quoteWriteError`, `forgeError`, … */
const ERROR_IDENTIFIER = /error$/i;

function isNullLiteral(node) {
  return node?.type === "Literal" && node.value === null;
}

/** `x !== null` / `x != null` where `x` reads as an error. */
function errorNotNull(node) {
  if (node?.type !== "BinaryExpression") return null;
  if (node.operator !== "!==" && node.operator !== "!=") return null;

  for (const [side, other] of [
    [node.left, node.right],
    [node.right, node.left],
  ]) {
    if (!isNullLiteral(other)) continue;
    if (side.type === "Identifier" && ERROR_IDENTIFIER.test(side.name)) {
      return side.name;
    }
    // `result.error !== null`
    if (
      side.type === "MemberExpression" &&
      side.property?.type === "Identifier" &&
      ERROR_IDENTIFIER.test(side.property.name)
    ) {
      return side.property.name;
    }
  }
  return null;
}

/** Walk `a || b || c` and any parenthesised nesting, collecting error tests. */
function findErrorNotNull(node, found = []) {
  if (!node) return found;
  const direct = errorNotNull(node);
  if (direct) found.push({ node, name: direct });
  if (node.type === "LogicalExpression") {
    findErrorNotNull(node.left, found);
    findErrorNotNull(node.right, found);
  }
  return found;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "An audit assertion may not use `error !== null` as its condition — " +
        "name the refusing layer with refusedBy/unreadableBy/unchangedBy.",
    },
    schema: [],
    messages: {
      vacuous:
        "`{{name}} !== null` does not say *which* control refused — a missing " +
        "grant, an RLS policy, the function's own check and a PGRST202 " +
        "signature miss all satisfy it, and the last one means nothing refused " +
        "at all. Use `refusedBy({{name}}, \"<layer>\")` from ./refusal and name " +
        "the layer this check is about. For a read, `unreadableBy` — it also " +
        "requires the table to be non-empty, which `rows === 0` does not.",
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    // Normalised so the check holds on Windows separators too.
    if (!filename.replace(/\\/g, "/").includes("/scripts/audit/")) return {};

    // The module that defines the replacement cannot be made to use it.
    if (/\/scripts\/audit\/refusal\.ts$/.test(filename.replace(/\\/g, "/")))
      return {};

    return {
      CallExpression(node) {
        const callee = node.callee;
        const name =
          callee.type === "Identifier"
            ? callee.name
            : callee.type === "MemberExpression" &&
                callee.property?.type === "Identifier"
              ? callee.property.name
              : null;
        if (!name || !ASSERTION_CALLEES.has(name)) return;

        // The condition is the second argument: check(label, condition, detail).
        for (const arg of node.arguments.slice(1)) {
          for (const hit of findErrorNotNull(arg)) {
            context.report({
              node: hit.node,
              messageId: "vacuous",
              data: { name: hit.name },
            });
          }
        }
      },
    };
  },
};

export default rule;
