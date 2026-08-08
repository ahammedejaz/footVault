import "server-only";

import {
  SHIPROCKET_BASE_URL,
  SHIPROCKET_TIMEOUT_MS,
} from "@/lib/shipping/config";
import {
  getShiprocketToken,
  refreshShiprocketToken,
  ShiprocketAuthError,
  ShiprocketLockedOutError,
  ShiprocketNotConfiguredError,
} from "@/lib/shipping/token";

/**
 * Every call to Shiprocket goes through here.
 *
 * Three things it guarantees, and one thing it deliberately does not do.
 *
 * **A single re-authentication on 401.** A token can be revoked in the panel or
 * invalidated by an API user being recreated, and neither is a deploy. So a 401
 * throws the cached token away, logs in once, and retries the request exactly
 * once. A second 401 is a real failure and is surfaced — a loop here would spend
 * the login rate limit and turn a credential problem into an account problem.
 *
 * **A deadline.** Every request is aborted at `SHIPROCKET_TIMEOUT_MS`. A
 * logistics API that has stopped answering must not hold a request open, and
 * the callers on the checkout path pass an even tighter budget.
 *
 * **A typed result rather than a throw.** Callers on the customer path have to
 * degrade rather than fail — a serviceability lookup that cannot answer must
 * leave checkout working — so the normal failure shape is a value. The one
 * exception is `ShiprocketNotConfiguredError`, which is a deployment problem
 * and is returned as `not_configured` rather than thrown, for the same reason.
 *
 * **It does not retry anything except the 401.** A timed-out
 * `courier/assign/awb` may or may not have assigned an AWB, and retrying it
 * automatically is how an order gets two. Retries of mutations are a decision
 * for a human at the button, and every fulfilment step is written to be safe to
 * press again.
 */

export type ShiprocketResult<T> =
  | { ok: true; data: T; status: number }
  | {
      ok: false;
      /**
       * `not_configured` — no credentials, so nothing was attempted.
       * `auth` — credentials rejected, or a second 401.
       * `timeout` / `network` — we never got an answer.
       * `provider` — Shiprocket answered with an error status.
       */
      reason:
        | "not_configured"
        | "auth"
        /** Sign-in is latched off after a credential rejection. See token.ts. */
        | "locked_out"
        | "timeout"
        | "network"
        | "provider";
      status: number | null;
      message: string;
      /** Shiprocket's own body, when it sent one worth showing an admin. */
      detail?: unknown;
    };

export async function shiprocketFetch<T>(
  path: string,
  init: {
    method?: "GET" | "POST" | "PATCH";
    body?: unknown;
    query?: Record<string, string | number | undefined>;
    timeoutMs?: number;
  } = {},
): Promise<ShiprocketResult<T>> {
  const {
    method = "GET",
    body,
    query,
    timeoutMs = SHIPROCKET_TIMEOUT_MS,
  } = init;

  let token: string;
  try {
    token = await getShiprocketToken();
  } catch (error) {
    if (error instanceof ShiprocketNotConfiguredError) {
      return {
        ok: false,
        reason: "not_configured",
        status: null,
        message: error.message,
      };
    }
    return {
      ok: false,
      // A latched lockout is its own answer, not a generic auth failure. The
      // admin needs to know shipping is stopped *deliberately* and that there
      // is a button to clear it, rather than that Shiprocket is unreachable.
      reason:
        error instanceof ShiprocketLockedOutError ? "locked_out" : "auth",
      status: null,
      message:
        error instanceof ShiprocketAuthError
          ? error.message
          : "Could not sign in to Shiprocket.",
    };
  }

  const url = buildUrl(path, query);

  const first = await attempt<T>(url, method, body, token, timeoutMs);
  if (first.kind !== "unauthorised") return first.result;

  // One re-authentication, then one retry. See the header.
  let fresh: string;
  try {
    fresh = await refreshShiprocketToken();
  } catch (error) {
    return {
      ok: false,
      reason: "auth",
      status: 401,
      message:
        error instanceof ShiprocketAuthError
          ? error.message
          : "Shiprocket rejected the token and signing in again failed.",
    };
  }

  const second = await attempt<T>(url, method, body, fresh, timeoutMs);
  if (second.kind === "unauthorised") {
    // Surfaced, never swallowed. A token minted a moment ago being refused
    // means the credentials themselves are wrong, and pretending otherwise
    // makes every shipping action fail silently for as long as nobody looks.
    console.error("[shiprocket] a freshly minted token was rejected", { path });
    return {
      ok: false,
      reason: "auth",
      status: 401,
      message:
        "Shiprocket rejected a token that was just issued. Check the API user still exists " +
        "in Settings → API → Configure and that its password has not been changed.",
    };
  }
  return second.result;
}

type Attempt<T> =
  | { kind: "done"; result: ShiprocketResult<T> }
  | { kind: "unauthorised"; result: ShiprocketResult<T> };

async function attempt<T>(
  url: string,
  method: string,
  body: unknown,
  token: string,
  timeoutMs: number,
): Promise<Attempt<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      kind: "done",
      result: {
        ok: false,
        reason: aborted ? "timeout" : "network",
        status: null,
        message: aborted
          ? "Shiprocket did not answer in time."
          : "Could not reach Shiprocket.",
      },
    };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401) {
    return {
      kind: "unauthorised",
      result: {
        ok: false,
        reason: "auth",
        status: 401,
        message: "Shiprocket rejected the token.",
      },
    };
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    return {
      kind: "done",
      result: {
        ok: false,
        reason: "provider",
        status: response.status,
        // Shiprocket puts the useful sentence in `message`, and it is usually
        // worth showing an admin verbatim — "Wrong Pickup location entered" is
        // more actionable than anything this file could write instead.
        message:
          providerMessage(payload) ?? `Shiprocket answered ${response.status}.`,
        detail: payload,
      },
    };
  }

  return {
    kind: "done",
    result: { ok: true, data: payload as T, status: response.status },
  };
}

function providerMessage(payload: unknown): string | null {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim())
      return record.message;
    if (typeof record.error === "string" && record.error.trim())
      return record.error;
  }
  return null;
}

function buildUrl(
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(`${SHIPROCKET_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "")
      url.searchParams.set(key, String(value));
  }
  return url.toString();
}
