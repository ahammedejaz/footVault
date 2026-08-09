/**
 * The two decisions that stand between a server error and the owner's inbox.
 *
 * Split out from `report-server-error.ts` so they can be tested. That file
 * reaches the mail provider and the database and is `server-only`; importing it
 * from a plain script trips the guard, and these two functions are where most
 * of the risk actually lives — both fail *silently* when wrong:
 *
 *   - Classify a real error as control flow and nothing is ever reported. The
 *     shop looks healthy because the alarm is disconnected.
 *   - Fail to classify control flow and every 404 emails the owner. They filter
 *     the alerts within a day, and the next real one is filtered too.
 *
 * No imports, on purpose. A pure module is one a gate can hold still.
 */

/**
 * Next signals control flow by throwing an error carrying a `NEXT_`-prefixed
 * digest — `NEXT_REDIRECT`, and the 404 fallback. These are not failures and
 * are the single largest source of noise this filter removes: on a public shop
 * every stale link and every bot guessing `/wp-admin` is a 404.
 *
 * A prefix test rather than a set of known values, because the fallback digest
 * carries a status suffix (`NEXT_HTTP_ERROR_FALLBACK;404`) and the set has
 * changed across versions. The cost is that a third-party error whose digest
 * genuinely began `NEXT_` would be swallowed; nothing in this codebase produces
 * one, and the gate records the edge rather than pretending it is impossible.
 */
export function isControlFlow(digest: string | null): boolean {
  return digest !== null && digest.startsWith("NEXT_");
}

/**
 * What counts as "the same error" for throttling.
 *
 * Route plus digest, falling back to route plus message. The digest is stable
 * for a given error in a given build, which is the grouping wanted: the same
 * bug on the same page collapses to one bucket, while the same message on two
 * routes stays two — because those are two different places to go and look.
 *
 * The message is truncated before it becomes part of a key so that an error
 * embedding a unique id (a connection id, a request id) cannot mint a fresh
 * bucket on every occurrence and defeat the limit entirely. `errorReportTotal`
 * in `rate-limit.ts` is the backstop for the cases this still misses.
 */
export function fingerprint(
  routePath: string,
  digest: string | null,
  message: string,
): string {
  return `${routePath}:${digest ?? message.slice(0, 80)}`;
}
