import "server-only";

import { rows } from "@/lib/queries/run";
import { createClient } from "@/lib/supabase/server";

/**
 * Every setting, read fresh for the settings screen.
 *
 * Deliberately not `cachedSiteSettings`. That reader is the storefront's, and
 * it is cached for an hour — an owner who saved a change and was shown the
 * cached value back would reasonably conclude the save had failed and do it
 * again. The editing screen reads through RLS, uncached, every time.
 */
export type AdminSettings = Record<string, unknown>;

export async function getAdminSettings(): Promise<AdminSettings> {
  const data = await rows<{ key: string; value: unknown }>(
    "admin.settings",
    (await createClient()).from("site_settings").select("key, value"),
  );
  return Object.fromEntries(data.map((row) => [row.key, row.value]));
}

/** Read one setting into a known shape, falling back field by field. */
export function settingObject(
  settings: AdminSettings,
  key: string,
): Record<string, unknown> {
  const value = settings[key];
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function settingString(settings: AdminSettings, key: string): string {
  const value = settings[key];
  return typeof value === "string" ? value : "";
}

/** Paise in the database, rupees in the form. Never make the owner type paise. */
export function paiseToRupees(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value / 100
    : fallback;
}
