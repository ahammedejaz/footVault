import type * as React from "react";

/**
 * The one renderer for owner-typed prose, wherever it is stored.
 *
 * Two surfaces hold text a shopkeeper wrote: `pages.body` (About, Contact, the
 * policies) and — from Phase 10 Batch C — the `rich_text` homepage section. They
 * take the same conventions and now share this file, because the alternative was
 * a second implementation of "split on blank lines, understand `- ` and `**`"
 * living next to the first. This codebase has already paid twice for two copies
 * of one rule: the ₹2,499 threshold in three places, and "5–7 working days"
 * typed independently into an email and a page. A divergent second prose
 * renderer would be the same shape — the day somebody teaches one of them
 * `_italics_`, the other silently keeps printing underscores.
 *
 * ## The format, which is deliberately tiny
 *
 * Blank lines separate blocks. A block whose every line starts with `- ` is a
 * list; anything else is a paragraph. `**text**` becomes `<strong>`. That is
 * all, and it is all on purpose.
 *
 * **There is no HTML path from the database into the page.** These build React
 * elements out of split strings, so a `<script>` typed into the admin renders as
 * the literal characters a customer can read. Reaching for a markdown library or
 * `dangerouslySetInnerHTML` would hand every future admin an XSS primitive in
 * exchange for italics, and the owner has never asked for italics.
 *
 * Tokens are **not** substituted here. Callers fill `{{free_shipping_threshold}}`
 * before handing text over — see `src/lib/content-tokens.ts` — because the
 * substitution needs a database read and this file is pure.
 */

/** `**text**` becomes <strong>. Everything else passes through as text. */
function emphasise(text: string): React.ReactNode[] {
  return text
    .split(/\*\*([^*]+)\*\*/)
    .map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part));
}

/** One block: a bullet list if every line is a bullet, otherwise a paragraph. */
function Block({ text }: { text: string }) {
  const lines = text.split("\n").map((line) => line.trim());
  if (lines.length > 1 && lines.every((line) => line.startsWith("- "))) {
    return (
      <ul className="list-disc space-y-2 pl-5 text-base">
        {lines.map((line, i) => (
          <li key={i} className="text-pretty">
            {emphasise(line.slice(2))}
          </li>
        ))}
      </ul>
    );
  }
  return <p className="text-base text-pretty">{emphasise(text)}</p>;
}

/**
 * Split owner-typed text into blocks and render them.
 *
 * Returns null for text that is empty or only whitespace, so a caller can use
 * the result to decide whether the surrounding section is worth drawing at all —
 * a `rich_text` section whose body has been emptied should disappear, not leave
 * a heading floating above nothing.
 */
export function ProseBlocks({
  text,
  className,
}: {
  text: string | null | undefined;
  className?: string;
}) {
  const blocks = (text ?? "")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (blocks.length === 0) return null;

  return (
    <div className={className ?? "space-y-5"}>
      {blocks.map((block, index) => (
        <Block key={index} text={block} />
      ))}
    </div>
  );
}

/** Whether this text would render anything, without rendering it. */
export function hasProse(text: string | null | undefined): boolean {
  return (text ?? "").trim().length > 0;
}
