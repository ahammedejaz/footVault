/**
 * footvault/no-off-scale-type
 *
 * docs/design-system.md §3 fixes the type scale at seven steps —
 * 12 · 14 · 16 · 20 · 28 · 40 · 64 — and globals.css snaps Tailwind's spare
 * steps onto their nearest neighbour so `text-3xl` cannot smuggle in an eighth.
 *
 * The one hole left is Tailwind's arbitrary-value syntax: `text-[13px]` and
 * `text-[0.9rem]` bypass the theme entirely. One of those is all it takes for
 * the scale to stop being a scale, and it is invisible in review because it
 * looks like every other utility class.
 *
 * Ratios (`text-[13px]/[18px]`), colours (`text-[#fff]`) and custom properties
 * (`text-[var(--x)]`) are not font sizes and are left alone.
 */

const CLASS_ATTRIBUTES = new Set(["className", "class"]);

/** text-[<number><length-unit>] — the arbitrary font-size form, and only that. */
const ARBITRARY_FONT_SIZE = /(?:^|\s)!?(?:[a-z-]+:)*text-\[(-?[\d.]+(?:px|rem|em|pt|ch|ex|vw|vh))\]/g;

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban arbitrary Tailwind font sizes so the seven-step type scale stays the only source of sizes.",
    },
    schema: [],
    messages: {
      offScale:
        "`text-[{{size}}]` is off the type scale. docs/design-system.md §3 allows 12 · 14 · 16 · 20 · 28 · 40 · 64 — use text-xs / text-sm / text-base / text-lg / text-2xl / text-4xl / text-6xl, or change the scale in globals.css and the doc together.",
    },
  },

  create(context) {
    function check(node, value) {
      if (typeof value !== "string") return;
      for (const match of value.matchAll(ARBITRARY_FONT_SIZE)) {
        context.report({ node, messageId: "offScale", data: { size: match[1] } });
      }
    }

    return {
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || !CLASS_ATTRIBUTES.has(node.name.name)) return;
        const value = node.value;
        if (!value) return;
        if (value.type === "Literal") check(node, value.value);
        if (value.type === "JSXExpressionContainer") {
          // Covers cn("…", cond && "…") and template literals alike: every
          // string literal inside the expression is a candidate class list.
          const source = context.sourceCode.getText(value);
          check(node, source);
        }
      },

      // cva(…) variant maps and any other bare class-list strings.
      Literal(node) {
        if (typeof node.value !== "string") return;
        if (node.parent.type === "JSXAttribute") return; // handled above
        check(node, node.value);
      },

      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};

export default rule;
