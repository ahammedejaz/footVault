/**
 * footvault/no-unchecked-supabase-error
 *
 * A PostgREST query returns `{ data, error }`. If you read `data` and never
 * look at `error`, a failed query is indistinguishable from a query that
 * matched nothing — and the page renders empty and calls that the answer.
 *
 * That is not hypothetical here: it is how the Phase 1 category 404 hid, and
 * `getSiteSettings()` and `listPageSlugs()` shipped with the same shape.
 * Fixing the three call sites would have left the fourth to be written next
 * week, so the shape itself is banned.
 *
 * Flagged:
 *   const { data } = await supabase.from("x").select()      // error dropped
 *   const { data, error } = await q; use(data)              // error never read
 *   const r = await supabase.from("x").select()             // never destructured
 *   supabase.from("x").select().then(r => r.data)           // routed around
 *   Promise.all([supabase.from("x").select(), …])           // ditto, in bulk
 *
 * Allowed — and the intended shape:
 *   const rows = await rows("label", supabase.from("x").select())
 *   const { data, error } = await q; if (error) throw …
 *
 * `src/lib/queries/run.ts` needs no exemption: it awaits a typed parameter, not
 * a builder chain, so the detector below never sees a query there.
 */

/** Methods that mint a PostgREST builder. Everything else is chained onto one. */
const BUILDER_ROOTS = new Set(["from", "rpc"]);

/** Wrappers that already unwrap the error. Passing a builder to one is fine. */
const SAFE_WRAPPERS = new Set(["run", "rows", "maybeRow", "pagedRows"]);

const PROMISE_COMBINATORS = new Set(["all", "allSettled", "any", "race"]);

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a Supabase query's error to be read, so a failed query cannot render as an empty page.",
    },
    schema: [],
    messages: {
      unchecked:
        "This drops the query's `error`, so a failure renders as no rows. Wrap it: `await rows(\"{{label}}\", …)` from @/lib/queries/run, or destructure `error` and act on it.",
      unusedError:
        "`error` is destructured but never read, which is the same as dropping it. Throw on it, or use the helpers in @/lib/queries/run.",
      unbound:
        "The result of this query is never destructured, so nothing checks `error`. Wrap it: `await rows(\"{{label}}\", …)` from @/lib/queries/run.",
      thenOnBuilder:
        "`.then()` on a query builder skips the error check. Wrap the builder instead: `run(\"{{label}}\", builder)` from @/lib/queries/run.",
      inCombinator:
        "A raw query builder inside Promise.{{combinator}} resolves to an unchecked `{ data, error }`. Wrap each one first: `Promise.{{combinator}}([rows(\"…\", builder), …])`.",
    },
  },

  create(context) {
    /** Locals known to hold a builder, so `let q = supabase.from(…); await q.eq(…)` is caught. */
    const builderLocals = new Set();

    /** Walk to the root of a member/call chain and report whether it starts at .from()/.rpc(). */
    function isBuilder(node) {
      let current = node;
      // Unwrap parens/assertions the parser may leave in place.
      while (
        current &&
        (current.type === "TSNonNullExpression" ||
          current.type === "TSAsExpression" ||
          current.type === "ChainExpression")
      ) {
        current = current.expression;
      }
      if (!current) return false;

      if (current.type === "Identifier") return builderLocals.has(current.name);

      if (current.type === "CallExpression") {
        const callee = current.callee;
        if (
          callee.type === "MemberExpression" &&
          callee.property.type === "Identifier" &&
          BUILDER_ROOTS.has(callee.property.name)
        ) {
          return true;
        }
        return isBuilder(callee);
      }

      if (current.type === "MemberExpression") return isBuilder(current.object);

      return false;
    }

    /** A best-effort call-site label for the fix-it message. */
    function labelFor(node) {
      let current = node;
      while (current) {
        if (
          current.type === "CallExpression" &&
          current.callee.type === "MemberExpression" &&
          current.callee.property.type === "Identifier" &&
          BUILDER_ROOTS.has(current.callee.property.name)
        ) {
          const arg = current.arguments[0];
          return arg && arg.type === "Literal" ? String(arg.value) : "query";
        }
        current =
          current.type === "CallExpression"
            ? current.callee
            : current.type === "MemberExpression"
              ? current.object
              : null;
      }
      return "query";
    }

    function checkAwaitedResult(awaitNode) {
      const parent = awaitNode.parent;
      const label = labelFor(awaitNode.argument);

      // `run("…", await …)` — someone awaited early but is still unwrapping.
      if (
        parent.type === "CallExpression" &&
        parent.callee.type === "Identifier" &&
        SAFE_WRAPPERS.has(parent.callee.name)
      ) {
        return;
      }

      // `(await supabase.from(…).insert(…)).error` — the error is the only
      // thing read, which is the point. Writes take this shape because there is
      // no data to unwrap. `.data` on its own still fails below.
      if (
        parent.type === "MemberExpression" &&
        parent.object === awaitNode &&
        parent.property.type === "Identifier" &&
        parent.property.name === "error"
      ) {
        return;
      }

      // `return await supabase…`, `use(await supabase…)`, and the bare
      // `await supabase.from(…).insert(…)` statement all end the same way: the
      // result exists and nothing in this file looks at its error.
      if (parent.type !== "VariableDeclarator" || parent.init !== awaitNode) {
        context.report({ node: awaitNode, messageId: "unbound", data: { label } });
        return;
      }

      const pattern = parent.id;
      if (pattern.type !== "ObjectPattern") {
        context.report({ node: awaitNode, messageId: "unbound", data: { label } });
        return;
      }

      const errorProp = pattern.properties.find(
        (p) =>
          p.type === "Property" && p.key.type === "Identifier" && p.key.name === "error",
      );
      if (!errorProp) {
        context.report({ node: awaitNode, messageId: "unchecked", data: { label } });
        return;
      }

      // Shorthand and renamed (`error: dbError`) both land on the value node.
      const localName =
        errorProp.value.type === "Identifier" ? errorProp.value.name : null;
      if (!localName) return;
      const declared = context.sourceCode.getDeclaredVariables(parent);
      const errorVar = declared.find((v) => v.name === localName);
      if (errorVar && errorVar.references.length === 0) {
        context.report({ node: errorProp, messageId: "unusedError" });
      }
    }

    return {
      VariableDeclarator(node) {
        if (node.init && node.id.type === "Identifier" && isBuilder(node.init)) {
          builderLocals.add(node.id.name);
        }
      },

      AssignmentExpression(node) {
        if (node.left.type === "Identifier" && isBuilder(node.right)) {
          builderLocals.add(node.left.name);
        }
      },

      AwaitExpression(node) {
        if (!isBuilder(node.argument)) return;
        checkAwaitedResult(node);
      },

      CallExpression(node) {
        // `.then()` over a builder.
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "then" &&
          isBuilder(node.callee.object)
        ) {
          context.report({
            node,
            messageId: "thenOnBuilder",
            data: { label: labelFor(node.callee.object) },
          });
          return;
        }

        // Builders handed straight to Promise.all and friends.
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.type === "Identifier" &&
          node.callee.object.name === "Promise" &&
          node.callee.property.type === "Identifier" &&
          PROMISE_COMBINATORS.has(node.callee.property.name)
        ) {
          const combinator = node.callee.property.name;
          const list = node.arguments[0];
          if (list?.type !== "ArrayExpression") return;
          for (const element of list.elements) {
            if (element && isBuilder(element)) {
              context.report({ node: element, messageId: "inCombinator", data: { combinator } });
            }
          }
        }
      },
    };
  },
};

export default rule;
