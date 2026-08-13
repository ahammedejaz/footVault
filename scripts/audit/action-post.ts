/**
 * Driving a Server Action over HTTP, the way the browser does.
 *
 * Extracted so that more than one gate can do it. `server-actions.ts` needs it
 * to forge admin posts from identities that must be refused; `rate-limit-public.ts`
 * needs it to drive a *legitimate* action repeatedly and prove the limiter
 * catches it. Same wire format, different question.
 *
 * `server-actions.ts` keeps its own richer `postAction`, which classifies the
 * response into "which layer refused" — that is its whole subject and belongs
 * with it. What is shared here is the mechanical part: find the id, build the
 * cookies, make the request.
 *
 * ## The wire format (Next 16.3)
 *
 * `POST <route>` with `Next-Action: <id>` and a body that is the encoded reply
 * — for simple argument shapes, a JSON array with
 * `Content-Type: text/plain;charset=UTF-8`. The result comes back as a flight
 * stream whose rows are `N:<json>`. See
 * `node_modules/next/dist/server/app-render/action-handler.js`.
 *
 * Requires a production build: ids are read out of `.next/static/chunks`, which
 * `next dev` does not populate the same way. Callers should check for that
 * directory and skip loudly rather than reporting a pass they did not earn.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { createServerClient } from "@supabase/ssr";
import type { Session } from "@supabase/supabase-js";

import { anonKey, supabaseUrl } from "./clients";

/** `createServerReference("<id>", callServer, undefined, findSourceMapURL, "<name>")` */
function discover(): Map<string, string> {
  const re =
    /createServerReference\)\(\s*"([0-9a-f]{40,})"\s*,[^,]*,[^,]*,[^,]*,\s*"([^"]+)"\s*\)/g;
  const found = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith(".js")) {
        const src = readFileSync(p, "utf8");
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) if (!found.has(m[1])) found.set(m[1], m[2]);
      }
    }
  };
  walk(".next/static/chunks");
  return found;
}

/** The action id for an exported function name, as an attacker would find it. */
export function findActionId(exportName: string): string | null {
  for (const [id, name] of discover()) if (name === exportName) return id;
  return null;
}

/** Cookies the app actually reads, produced by @supabase/ssr, joined for a header. */
export async function sessionCookieHeader(session: Session): Promise<string> {
  const jar = new Map<string, string>();
  const client = createServerClient(supabaseUrl(), anonKey(), {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach((e) => jar.set(e.name, e.value)),
    },
  });
  await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  return [...jar].map(([n, v]) => `${n}=${v}`).join("; ");
}

/** Post an action and return the raw flight body. */
export async function postServerAction(
  base: string,
  route: string,
  id: string,
  body: string,
  cookie: string | null,
): Promise<string> {
  const res = await fetch(`${base}${route}`, {
    method: "POST",
    headers: {
      "Next-Action": id,
      "Content-Type": "text/plain;charset=UTF-8",
      Accept: "text/x-component",
      Origin: new URL(base).origin,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
  });
  return res.text();
}
