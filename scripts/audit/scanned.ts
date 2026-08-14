/**
 * "I looked at N things" — printed, and refused when N is zero.
 *
 * ## The rule, and the three times this repository has needed it
 *
 * A check that iterates a set and reports on what it found is only as good as
 * the set. When the set is empty the loop body never runs, every assertion
 * inside it is vacuously satisfied, and the harness prints a tick. That is not
 * a hypothetical failure mode here — it is the same bug three times:
 *
 *   - the `use server` guard was an inline shell loop that word-split correctly
 *     under bash and not under zsh, so on the machine the code is written on it
 *     ran **once**, with all 28 paths as a single filename, and passed having
 *     checked nothing (2026-08-14);
 *   - the client-component guard wrapped `grep -Pzq`, and `-P` is a GNU
 *     extension: on BSD grep every invocation errored, the offender list stayed
 *     empty, and the step passed on every macOS checkout (2026-08-14);
 *   - `audit:literals` scanned a named column list, so the worst copy defect on
 *     the shop — a meta description promising a 7-day refund — sat in a column
 *     nobody had named and the sweep printed a tick (2026-08-14).
 *
 * Both guards were rewritten to fail on a zero-file scan. This is that property
 * as one function, so a harness gets it by saying what it is about to examine
 * rather than by remembering to guard afterwards.
 *
 * ## Why it exits rather than counting a failure
 *
 * A failed *check* means the shop is wrong. An empty *scan* means the harness
 * is wrong, and every result it goes on to print is unfounded — including the
 * green ones. Continuing would produce a report whose summary line is a
 * confident number over an unknown denominator, which is worse than no report.
 * So it stops, names the set, and says what it expected.
 */
export function scanned(label: string, count: number, minimum = 1): number {
  if (count >= minimum) {
    console.log(`  \x1b[2m·\x1b[0m scanned ${count} ${label}`);
    return count;
  }
  console.error(
    `\n\x1b[31mRefusing to report a pass: scanned ${count} ${label}, ` +
      `needed at least ${minimum}.\x1b[0m\n` +
      "  A gate that examined nothing is not a gate that found nothing.\n",
  );
  process.exit(1);
}
