/**
 * Where it is safe to send somebody after signing in.
 *
 * The destination arrives in a query string — `/auth/callback?next=…` — which
 * means it arrives from whoever wrote the link. An unchecked value there is an
 * open redirect: a link to *our* domain that lands on someone else's, which is
 * exactly the shape a phishing page wants, because the part the customer
 * inspects before clicking is genuinely ours.
 *
 * Only a same-origin absolute path is allowed through. The cases that matter:
 *
 *   //evil.com      protocol-relative; browsers treat it as absolute
 *   /\evil.com      some browsers normalise the backslash to a slash
 *   https://evil…   plainly absolute
 *   /foo%0A…        a newline, which is header injection on a Location
 *
 * Anything not obviously safe becomes the fallback rather than an error: a
 * customer who followed a mangled link should still end up signed in and
 * looking at the shop.
 */
export function safeNext(value: string | null | undefined, fallback = "/"): string {
  if (!value) return fallback;

  // Control characters, including CR and LF.
  if (/[\x00-\x1F\x7F]/.test(value)) return fallback;

  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;

  return value;
}
