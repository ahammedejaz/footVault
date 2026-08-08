import type { PostgrestError } from "@supabase/supabase-js";

/**
 * The one way a PostgREST result is allowed to become data.
 *
 * Destructuring `{ data }` and dropping `{ error }` makes a failed query
 * indistinguishable from an empty one. That is how a malformed embed hint in
 * getCategory() turned every category page into a 404 nobody could see, and how
 * getSiteSettings() would have rendered a footer with no phone number rather
 * than an error, forever, if the settings table had ever become unreadable.
 *
 * Nothing here is clever. The value is that it is the *only* path: the
 * `footvault/no-unchecked-supabase-error` ESLint rule fails the build on any
 * await of a query builder whose `error` is not destructured and read, on any
 * `.then()` over one, and on any builder handed to `Promise.all` unwrapped. So
 * the failure mode cannot come back by someone writing the shorter thing.
 *
 * These deliberately throw. A thrown error reaches error.tsx, which tells the
 * customer something failed and gives them a way back; a swallowed one renders
 * an empty page that claims the shop has nothing in it.
 */

type QueryResult<T> = { data: T; error: PostgrestError | null };

function fail(label: string, error: PostgrestError): never {
  // The label is the call site, not the table: "getCategory(mens-boots)" is
  // findable in the logs, "PGRST200" on its own is not.
  const detail = [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(" — ");
  throw new Error(
    `${label}: ${detail || "query failed"} [${error.code ?? "unknown"}]`,
  );
}

/** Any result, as-is. Throws on a PostgREST error. */
export async function run<T>(
  label: string,
  query: PromiseLike<QueryResult<T>>,
): Promise<T> {
  const { data, error } = await query;
  if (error) fail(label, error);
  return data;
}

/** A list. A successful query that matched nothing is `[]`, never null. */
export async function rows<T>(
  label: string,
  query: PromiseLike<QueryResult<T[] | null>>,
): Promise<T[]> {
  const { data, error } = await query;
  if (error) fail(label, error);
  return data ?? [];
}

/** A single row or none — for `.maybeSingle()`. Absence is a legitimate answer. */
export async function maybeRow<T>(
  label: string,
  query: PromiseLike<QueryResult<T | null>>,
): Promise<T | null> {
  const { data, error } = await query;
  if (error) fail(label, error);
  return data ?? null;
}

/** A list plus PostgREST's exact count, for paginated reads. */
export async function pagedRows<T>(
  label: string,
  query: PromiseLike<QueryResult<T[] | null> & { count: number | null }>,
): Promise<{ rows: T[]; total: number }> {
  const { data, error, count } = await query;
  if (error) fail(label, error);
  return { rows: data ?? [], total: count ?? 0 };
}
