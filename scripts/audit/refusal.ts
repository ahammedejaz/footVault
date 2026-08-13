/**
 * Why a probe was refused — not merely that it was.
 *
 * ## The bug this module is a rule about
 *
 * Three separate gates were found asserting the same wrong thing, in three
 * shapes:
 *
 * ```ts
 * check("X refuses a customer", error !== null);              // 1 · any error will do
 * check("Y is not readable",    (data?.length ?? 0) === 0);   // 2 · nothing came back
 * check("Z did not change",     error === null && rows === 0);// 3 · nothing happened
 * ```
 *
 * All three are green when the control they name has been deleted. Shape 1 is
 * satisfied by an error from somewhere else entirely; shapes 2 and 3 are
 * satisfied by there being nothing there in the first place.
 *
 * **Shape 1 collapses four different facts into one boolean.** A refused write
 * against this database can come back as any of these, and they are *not*
 * interchangeable:
 *
 * | what actually refused          | code       | message                                              |
 * |--------------------------------|------------|------------------------------------------------------|
 * | no `GRANT` on the table        | `42501`    | `permission denied for table X`                      |
 * | no `GRANT EXECUTE` on the fn   | `42501`    | `permission denied for function X`                   |
 * | an RLS policy                  | `42501`    | `new row violates row-level security policy for "X"` |
 * | the function's own `is_admin()`| `FVADM`    | `not_admin`                                          |
 * | **nothing — the probe missed** | `PGRST202` | `Could not find the function … in the schema cache`  |
 *
 * Note that the first three share a SQLSTATE and are told apart only by the
 * message, and that the last one is not a refusal at all. `audit:security-advance`
 * §3 learned that the hard way: when a migration added a parameter to
 * `create_order_with_stock`, the gate's fixed 25-argument POST started coming
 * back `PGRST202`, the gate read that non-null error as "refused", and stayed
 * green for two days while the new 26-argument function sat executable by anon.
 * A new arity is a new function and inherits no ACL. The door was open and the
 * alarm was reporting all clear.
 *
 * **Shape 2 is worse, because no predicate can fix it.** A read that RLS
 * filtered to nothing and a read of an empty table are byte-identical:
 * `rows=0, error=null`. `audit:admin` asserted that eight admin-only tables were
 * unreadable by a customer; five of those tables were empty in staging, so five
 * of those assertions would have passed with RLS switched off entirely — and
 * that was *demonstrated*, not inferred, by disabling RLS on `coupons` and
 * watching the gate stay green.
 *
 * ## The rule
 *
 * 1. **Name the layer.** Every refusal assertion states which control it expects
 *    to do the refusing, and fails if a *different* one did — including the case
 *    where the probe never reached a control at all.
 * 2. **An assertion against an empty table is unprovable, not passed.** It gets
 *    its own outcome, printed in its own colour, and it counts against the run.
 *    A green tick that proves nothing is the thing this whole exercise is about.
 * 3. **Prefer making it provable to reporting it unprovable.** If a witness row
 *    can be planted with the service role, plant one — then RLS has something to
 *    hide and the assertion means what it says. `unreadableBy` takes a `witness`
 *    for exactly this, and removes it afterwards.
 *
 * ## How to check a converted assertion is real
 *
 * Disable the specific control it names — the policy, the grant, the `is_admin()`
 * line — and re-run. It must go red, and the detail it prints must say the
 * *layer* changed rather than merely that something did. Every conversion in
 * this repository was proved that way; see `docs/staging.md`.
 */
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../src/lib/database.types";

type TableName = keyof Database["public"]["Tables"];

/**
 * Which control refused.
 *
 * Deliberately finer-grained than the SQLSTATE, because three of these share
 * `42501` and the whole point is telling them apart.
 */
export type RefusalLayer =
  /** `GRANT SELECT/INSERT … TO authenticated` is absent. PostgREST never reaches RLS. */
  | "table-grant"
  /** `GRANT EXECUTE` is absent. The function body never runs. */
  | "function-grant"
  /** An RLS policy refused a write — `USING` on update/delete, `WITH CHECK` on insert. */
  | "rls-write"
  /** An RLS policy filtered a read to nothing. Only provable against a table that has rows. */
  | "rls-read"
  /** The function ran and refused on its own logic — `is_admin()`, an ownership test. */
  | "app-check"
  /**
   * A data-integrity constraint — `CHECK`, `UNIQUE`, `NOT NULL`, a foreign key.
   * SQLSTATE class 23.
   *
   * **Never evidence of authorization.** A constraint refuses the shop's owner
   * exactly as readily as it refuses an attacker; all it says is that the row
   * was malformed. A gate that accepted one as proof of "a customer cannot do X"
   * would be proving "nobody can do X in that particular way", which is a
   * different and much weaker claim — and one that evaporates the moment the
   * attacker sends a well-formed row instead.
   *
   * Found by opening RLS on `orders` and watching two of six money-tamper
   * probes stay green: `orders_settlement_sums` was rejecting them because
   * advance and balance no longer summed, not because the caller was refused.
   * The third probe moved both fields at once, satisfied the constraint, and
   * went straight through.
   */
  | "constraint"
  /**
   * `PGRST202`. **Not a refusal.** The signature did not match anything, so no
   * control was consulted and nothing was proved. This is the layer that made a
   * dead gate look alive for two days.
   */
  | "not-found"
  /** No error and no filtering. The call went through. */
  | "none";

export type Refusal = {
  layer: RefusalLayer;
  code: string | null;
  message: string;
  /** A sentence for the gate's detail column, naming the layer. */
  describe: string;
};

const LAYER_ENGLISH: Record<RefusalLayer, string> = {
  "table-grant": "table grant",
  "function-grant": "function grant",
  "rls-write": "RLS policy",
  "rls-read": "RLS policy",
  "app-check": "the function's own check",
  constraint: "a data-integrity constraint (refuses anyone, proves nothing about the caller)",
  "not-found": "NOTHING — no such signature, so no control was consulted",
  none: "NOTHING — the call succeeded",
};

/**
 * Read a PostgREST error for what it actually says.
 *
 * Keys on the message as well as the code, because `42501` alone cannot
 * distinguish a missing grant from an RLS policy, and the difference is the
 * difference between "authorization is intact" and "authorization is intact for
 * a reason other than the one this test claims to be checking".
 */
export function classifyRefusal(error: PostgrestError | null): Refusal {
  if (!error) {
    return {
      layer: "none",
      code: null,
      message: "",
      describe: LAYER_ENGLISH.none,
    };
  }

  const code = error.code ?? null;
  const message = error.message ?? "";
  const layer = layerOf(code, message);

  return {
    layer,
    code,
    message,
    describe:
      `${LAYER_ENGLISH[layer]}${code ? ` (${code})` : ""}` +
      // For an application check the message *is* the discriminator — "not_admin"
      // and "Only an admin can change a profile role" are different controls
      // wearing the same layer — so it is carried into the passing detail too,
      // not only into failures.
      ((layer === "app-check" || layer === "constraint") && message
        ? `: ${message.slice(0, 90)}`
        : ""),
  };
}

function layerOf(code: string | null, message: string): RefusalLayer {
  if (code === "PGRST202") return "not-found";

  // SQLSTATE class 23 — integrity_constraint_violation. Checked before the
  // catch-all below so a malformed row cannot be mistaken for a refused caller.
  if (code?.startsWith("23")) return "constraint";

  if (code === "42501") {
    if (/row-level security policy/i.test(message)) return "rls-write";
    if (/permission denied for function/i.test(message)) return "function-grant";
    if (/permission denied for (table|relation|view|sequence)/i.test(message))
      return "table-grant";
    /*
      A 42501 whose message is none of the above was raised deliberately.
      Postgres's own `insufficient_privilege` messages come in a small and
      well-known set of shapes — the three matched above, plus "must be owner
      of" — so anything else is a `raise … using errcode = '42501'` in a trigger
      or a function body. `guard_profile_role` is the live example: it answers a
      self-promotion attempt with 42501 and "Only an admin can change a profile
      role", which is an application check wearing a privilege error's clothes.

      Calling it `table-grant` because the SQLSTATE matched is exactly the class
      of mistake this module exists to stop, so it is classified by what it
      actually is.
    */
    return "app-check";
  }

  /*
    Everything else is the function having run and decided. Postgres raises
    `P0001` for a bare `raise exception`, and this codebase's functions carry
    their own SQLSTATEs (`FVADM` for `not_admin`, and friends) so that callers
    can tell an authorization refusal from a business-rule one. Either way the
    body executed, which is a materially different fact from "the caller could
    not execute the body".
  */
  return "app-check";
}

/* ══ outcomes ═══════════════════════════════════════════════════════════════ */

/**
 * A check's outcome, with the third state a boolean could not express.
 *
 * `unprovable` exists because "this assertion could not be made to mean
 * anything" is neither a pass nor a hole in the shop, and flattening it into
 * either one loses the only information that matters about it.
 */
export type Verdict = {
  state: "held" | "hole" | "unprovable";
  detail: string;
};

const held = (detail: string): Verdict => ({ state: "held", detail });
const hole = (detail: string): Verdict => ({ state: "hole", detail });
const unprovable = (detail: string): Verdict => ({
  state: "unprovable",
  detail,
});

/* ══ writes and RPCs ════════════════════════════════════════════════════════ */

/**
 * Assert that a write or an RPC was refused, **and that the named control did
 * the refusing**.
 *
 * `expect` is the list of layers that would satisfy the claim in the label. It
 * is a list rather than one value because some probes are legitimately covered
 * by either of two controls — a table with no INSERT grant *and* an RLS policy
 * is refused by whichever PostgREST reaches first, and both are correct answers.
 * What it may never contain is `not-found` or `none`.
 *
 * A refusal from an unexpected layer is a **hole**, not a pass. That is the
 * whole change: if a gate says "the RLS policy stops this" and the truth is
 * "the function does not exist at this arity", the gate was lying and should
 * say so.
 */
export function refusedBy(
  error: PostgrestError | null,
  ...expect: RefusalLayer[]
): Verdict {
  const refusal = classifyRefusal(error);

  if (refusal.layer === "none") {
    return hole("NOT REFUSED — the call succeeded");
  }

  if (refusal.layer === "not-found") {
    return hole(
      `PGRST202 — the probe never reached a control, so nothing was proved. ` +
        `${refusal.message.slice(0, 120)}`,
    );
  }

  if (!expect.includes(refusal.layer)) {
    return hole(
      `refused by ${refusal.describe}, but this check claims ` +
        `${expect.map((l) => LAYER_ENGLISH[l]).join(" or ")} — ` +
        `the named control may be gone. ${refusal.message.slice(0, 120)}`,
    );
  }

  return held(`refused by ${refusal.describe}`);
}

/* ══ reads ══════════════════════════════════════════════════════════════════ */

/**
 * Plant a row for RLS to hide, and take it away afterwards.
 *
 * Returns the cleanup. A witness that cannot be planted (a foreign key with
 * nothing to point at) should return `null`, which leaves the check honestly
 * unprovable rather than silently skipped.
 */
export type Witness = (
  admin: SupabaseClient<Database>,
) => Promise<(() => Promise<void>) | null>;

/**
 * Take a witness row away again, complaining loudly if it will not go.
 *
 * Worth a warning rather than a silent `.catch(() => {})`: a witness left
 * behind changes the *next* run's preconditions. The table stops being empty,
 * so the check that planted it starts passing on the leftover instead of on a
 * row it controls — which is a quieter version of the same bug this module is
 * about.
 */
export async function removeWitness(
  label: string,
  query: PromiseLike<{ error: PostgrestError | null }>,
): Promise<void> {
  const { error } = await query;
  if (error) {
    console.warn(
      `  \x1b[33m!!\x1b[0m witness row left behind in ${label}: ${error.message} ` +
        `— the next run's preconditions are now different`,
    );
  }
}

/**
 * Assert that a table is not readable by this caller — against a table that
 * demonstrably **has rows**.
 *
 * The precondition is the point. Without it the assertion is
 * `0 === 0` dressed up as security, and it stays green through `alter table …
 * disable row level security`.
 *
 * Order of business — and **the read comes first**, which is not an
 * optimisation:
 *
 *   1. read as the caller
 *   2. an error → classify it; it must come from a layer in `expect`. The row
 *      count is irrelevant here, because a `permission denied for table` is a
 *      *positive observation* that holds whether the table has a million rows
 *      or none. `shipping_quotes` is empty and refuses by grant; demanding a
 *      witness of it would report a perfectly sound check as unprovable.
 *   3. rows came back → a hole, with the count
 *   4. no error, no rows → **now** the precondition bites, because this is the
 *      byte-identical case. Count as service role; if the table is empty, the
 *      assertion proved nothing. Plant a witness if one was given, re-read, and
 *      remove it in `finally`.
 *
 * Step 4 is only sound because the probe accounts are minted fresh for the run,
 * so no pre-existing row can belong to them. A witness planted here is written
 * with the service role and owned by nobody, which has the same property.
 */
export async function unreadableBy({
  admin,
  caller,
  table,
  expect,
  witness,
}: {
  admin: SupabaseClient<Database>;
  caller: SupabaseClient<Database>;
  table: TableName;
  /** The layers that would satisfy the claim. Usually `["rls-read"]` or `["table-grant"]`. */
  expect: RefusalLayer[];
  witness?: Witness;
}): Promise<Verdict> {
  // `no-unchecked-supabase-error` wants the error destructured and acted on.
  // It is — acting on it *is* the check here, which is why this reads as a
  // deliberate exception to the usual `rows()` wrapper: an error is the result,
  // not a failure to obtain one.
  const { data: firstRows, error: firstError } = await caller
    .from(table)
    .select("*")
    .limit(5);

  // An error is an observation in its own right — it does not need a row to
  // exist to mean something. Classify and return.
  if (firstError) return refusedBy(firstError, ...expect);

  if ((firstRows?.length ?? 0) > 0) {
    return hole(`${firstRows!.length} rows readable by a plain customer`);
  }

  // Zero rows and no error. This is the vacuous case: indistinguishable from an
  // empty table until we go and look.
  const { count, error: countError } = await admin
    .from(table)
    .select("*", { count: "exact", head: true });

  if (countError) {
    return unprovable(
      `could not count ${table} as service role, so "0 rows" cannot be ` +
        `told apart from "no rows exist": ${countError.message}`,
    );
  }

  if ((count ?? 0) > 0) {
    if (!expect.includes("rls-read")) {
      return hole(
        `no rows and no error — the refusal came from RLS, but this check ` +
          `claims ${expect.map((l) => LAYER_ENGLISH[l]).join(" or ")}. That ` +
          `layer did not fire; the grant it names may have been removed.`,
      );
    }
    return held(`RLS returned 0 of ${count} existing rows`);
  }

  if (!witness) {
    return unprovable(
      `${table} is empty, so a customer reading nothing proves nothing — ` +
        `this assertion passes with RLS disabled. Give it a witness row.`,
    );
  }

  const planted = await witness(admin);
  if (!planted) {
    return unprovable(
      `${table} is empty and its witness could not be planted — ` +
        `nothing here is being tested.`,
    );
  }

  try {
    const { data, error } = await caller.from(table).select("*").limit(5);
    if (error) return refusedBy(error, ...expect);
    if ((data?.length ?? 0) > 0) {
      return hole(
        `the planted witness row is readable by a plain customer ` +
          `(${data!.length} rows)`,
      );
    }
    if (!expect.includes("rls-read")) {
      return hole(
        `no rows and no error against a planted row — the refusal came from ` +
          `RLS, but this check claims ` +
          `${expect.map((l) => LAYER_ENGLISH[l]).join(" or ")}.`,
      );
    }
    return held("RLS hid a planted row");
  } finally {
    await planted();
  }
}

/**
 * Assert that an UPDATE or DELETE **changed nothing**, against a row that
 * demonstrably exists.
 *
 * The third shape, and the quietest. An update that RLS filtered and an update
 * that matched no row are both `rows=0, error=null` — so `error === null &&
 * affected === 0` is the write-side twin of the empty-table read, and it passes
 * against a table with nothing in it just as happily.
 *
 * `readBack` is what makes it real: the row is fetched with the service role
 * before and after, and the assertion is that the two agree. A caller who
 * cannot produce a `readBack` has nothing to compare and gets `unprovable`.
 */
export async function unchangedBy<T>({
  attempt,
  readBack,
  baseline,
  describe = (value: T) => JSON.stringify(value),
  expect = ["rls-write", "app-check"],
}: {
  /**
   * The forbidden write. Returns whatever PostgREST said about it.
   *
   * `PromiseLike` rather than `Promise` so a `PostgrestFilterBuilder` can be
   * handed over unawaited — it is a thenable, not a promise, and requiring the
   * caller to wrap it in an `async () => await …` would be noise at every site.
   */
  attempt: () => PromiseLike<{ error: PostgrestError | null }>;
  /** The row as the service role sees it. `null` means it is not there. */
  readBack: () => Promise<T | null>;
  /**
   * The value the row must **still** have, captured once before any attempt.
   *
   * Pass this whenever several attempts run against the same row. Without it
   * each attempt re-reads its own "before", so an attack that *already
   * succeeded* becomes the baseline for the next one and every subsequent check
   * reports "unchanged" — the assertion quietly redefines itself from "the row
   * is intact" to "no further damage was done". A six-iteration loop against one
   * order behaved exactly that way: opening RLS let the first write through, and
   * three of the six checks stayed green off the back of it.
   */
  baseline?: T;
  describe?: (value: T) => string;
  /** Layers that may legitimately refuse. An error from anywhere else is a hole. */
  expect?: RefusalLayer[];
}): Promise<Verdict> {
  const before = baseline ?? (await readBack());
  if (before === null || before === undefined) {
    return unprovable(
      "the row this check writes to does not exist, so 'nothing changed' is " +
        "true no matter what the policy says",
    );
  }

  const { error } = await attempt();
  const after = await readBack();

  if (after === null) {
    return hole("the row is gone — the write was not refused, it landed");
  }

  const changed = describe(before) !== describe(after);
  if (changed) {
    return hole(`the row changed: ${describe(before)} → ${describe(after)}`);
  }

  /*
    Unchanged, which is the property that matters. But *why* is still worth
    saying: an error names its layer, and silence means RLS filtered the update
    to zero rows without complaint — which is what a `USING` clause does and is
    a perfectly good refusal, just a different one from a `WITH CHECK`.
  */
  if (!error) return held("unchanged; RLS matched no row to update");

  const refusal = classifyRefusal(error);
  if (refusal.layer === "not-found") {
    return hole(
      `unchanged, but only because PGRST202 — the probe never reached a ` +
        `control. ${refusal.message.slice(0, 120)}`,
    );
  }
  if (!expect.includes(refusal.layer)) {
    return hole(
      `unchanged, but refused by ${refusal.describe} where this check claims ` +
        `${expect.map((l) => LAYER_ENGLISH[l]).join(" or ")}`,
    );
  }
  return held(`unchanged; refused by ${refusal.describe}`);
}

/* ══ preconditions ══════════════════════════════════════════════════════════ */

/**
 * How many rows a table has, as service role.
 *
 * Exported for the checks that need the number for their own reasons — an
 * assertion on somebody *else's* order, say, which is unprovable for a
 * different reason (nobody else has one) than an empty table is.
 */
export async function rowCount(
  admin: SupabaseClient<Database>,
  table: TableName,
): Promise<number | null> {
  const { count, error } = await admin
    .from(table)
    .select("*", { count: "exact", head: true });
  return error ? null : (count ?? 0);
}

/* ══ reporting ══════════════════════════════════════════════════════════════ */

/**
 * Flatten a `Verdict` onto a harness that only knows `(label, ok, detail)`.
 *
 * For the gates whose output format predates this module and is not worth
 * rewriting. `unprovable` maps to **not ok**, with the word in the detail so it
 * is still distinguishable in the log — the one thing that must not happen is
 * an unprovable check being folded into a pass to fit an older signature.
 */
export function renderVerdict(verdict: Verdict): {
  ok: boolean;
  detail: string;
} {
  return verdict.state === "unprovable"
    ? { ok: false, detail: `UNPROVABLE — ${verdict.detail}` }
    : { ok: verdict.state === "held", detail: verdict.detail };
}


/**
 * The shared tally, so that `unprovable` cannot be quietly dropped on the floor
 * by a harness that only knows how to count two things.
 *
 * Each harness had its own `check`/`section` pair and its own two counters.
 * Adding a third state to eight files independently is how the third state ends
 * up meaning something slightly different in each of them, so it lives here.
 */
export function gate(name: string) {
  let heldCount = 0;
  let holeCount = 0;
  let unprovableCount = 0;
  const holes: string[] = [];
  const unprovables: string[] = [];

  return {
    section(title: string) {
      console.log(`\n\x1b[1m${title}\x1b[0m`);
    },

    /** A plain boolean check, for the assertions that are not about refusals. */
    check(label: string, ok: boolean, detail = "") {
      this.verdict(
        label,
        ok ? held(detail) : hole(detail || "did not hold"),
      );
    },

    /** A refusal check, whose verdict carries its own detail. */
    verdict(label: string, verdict: Verdict) {
      if (verdict.state === "held") {
        heldCount += 1;
        console.log(
          `  \x1b[32m✓\x1b[0m ${label}${verdict.detail ? `  \x1b[2m${verdict.detail}\x1b[0m` : ""}`,
        );
        return;
      }
      if (verdict.state === "unprovable") {
        unprovableCount += 1;
        unprovables.push(`${label} — ${verdict.detail}`);
        console.log(
          `  \x1b[35m? UNPROVABLE\x1b[0m ${label} — ${verdict.detail}`,
        );
        return;
      }
      holeCount += 1;
      holes.push(`${label} — ${verdict.detail}`);
      console.log(`  \x1b[31m✗ HOLE\x1b[0m ${label} — ${verdict.detail}`);
    },

    /**
     * Print the tally and exit.
     *
     * **Unprovable fails the run.** It is not a hole in the shop and it is not a
     * pass; it is a test that does not test anything, which for a suite whose
     * entire premise is "verification must be able to fail" is a defect in the
     * suite. Making it exit 0 would restore precisely the property this module
     * was written to remove.
     */
    finish(): never {
      const parts = [`\x1b[1m${heldCount} held`, `${holeCount} holes`];
      if (unprovableCount) parts.push(`${unprovableCount} unprovable`);
      console.log(`\n${parts.join(", ")}\x1b[0m`);

      if (holes.length) {
        console.log("\nHoles:");
        for (const h of holes) console.log(`  - ${h}`);
      }
      if (unprovables.length) {
        console.log(
          "\nUnprovable — these assertions could not be made to mean anything:",
        );
        for (const u of unprovables) console.log(`  - ${u}`);
        console.log(
          `\n  An unprovable check is not a pass. Either give it a witness row\n` +
            `  (see \`unreadableBy\`'s \`witness\`) or delete it, but do not let\n` +
            `  ${name} report it green.`,
        );
      }

      process.exit(holeCount + unprovableCount > 0 ? 1 : 0);
    },

    get counts() {
      return {
        held: heldCount,
        holes: holeCount,
        unprovable: unprovableCount,
      };
    },
  };
}
