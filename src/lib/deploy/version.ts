/**
 * Which commit this running build was made from.
 *
 * ## Why this exists
 *
 * On 2026-08-20 four deployments in a row were refused by Vercel *before any
 * build started* — `readyState: BLOCKED`, `buildingAt == ready == createdAt`,
 * no logs, because there was nothing to log. `main` moved three commits ahead,
 * every CI job stayed green, and production went on serving a build from six
 * days earlier. **Nothing anywhere in this project could tell.** The only way it
 * was noticed was a person opening the shop and looking at the colour behind a
 * photograph.
 *
 * That is the failure this module exists to make impossible to miss: a shop
 * that is silently one deploy behind is indistinguishable, from the inside,
 * from a shop that is up to date.
 *
 * ## Where the values come from
 *
 * Vercel injects these at build time when a project has `autoExposeSystemEnvs`
 * on, which this one does. They are **baked into the bundle**, not read at
 * request time, which is exactly the property wanted: the answer describes the
 * build that is answering, so a stale deployment reports its own staleness
 * rather than the truth about some newer build it knows nothing about.
 *
 * Everywhere that is not a Vercel build — `next dev`, `start:stage`, a CI
 * container — they are absent, and that is reported as `unknown` rather than
 * papered over. See the note on `DeployedCommit`.
 */

/**
 * **`unknown` is a third state and it is never a pass.**
 *
 * The temptation is to treat a missing SHA as "fine, probably local" and let
 * the check succeed. That would make every consumer of this module silently
 * useless the first time an env var was renamed — which is the same shape as
 * the bug it is here to catch: a check that cannot see anything reporting that
 * it sees nothing wrong. Callers must handle all three states.
 */
export type DeployedCommit =
  | {
      state: "known";
      /** Full 40-character SHA, as Vercel provides it. */
      sha: string;
      /** The branch it was built from — `main` for production. */
      ref: string | null;
      /** `production`, `preview`, or `development`. */
      environment: string | null;
    }
  | { state: "unknown"; reason: string };

export function deployedCommit(): DeployedCommit {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (!sha) {
    return {
      state: "unknown",
      reason:
        "VERCEL_GIT_COMMIT_SHA is not set — this build was not made by Vercel " +
        "(next dev, start:stage and CI containers all land here).",
    };
  }
  // Guard the shape rather than trusting it. A truncated or decorated value
  // would compare unequal to a full SHA forever, which would read as permanent
  // drift and train the owner to ignore the one alarm that matters.
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    return {
      state: "unknown",
      reason: `VERCEL_GIT_COMMIT_SHA is not a 40-character SHA: ${JSON.stringify(sha.slice(0, 60))}`,
    };
  }
  return {
    state: "known",
    sha: sha.toLowerCase(),
    ref: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    environment: process.env.VERCEL_ENV ?? null,
  };
}

/** The first seven, which is what a person compares by eye. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
