"use server";

import { cookies } from "next/headers";

import {
  ANNOUNCEMENT_COOKIE,
  ANNOUNCEMENT_COOKIE_MAX_AGE,
  isAnnouncementKey,
} from "@/lib/announcement";

/**
 * Remember that this customer dismissed this announcement.
 *
 * httpOnly because client JavaScript has no reason to read it: the decision is
 * made on the server, before the bar is rendered at all. `lax` so it survives a
 * normal navigation back to the site without riding along on cross-site POSTs.
 */
export async function dismissAnnouncement(key: string): Promise<void> {
  if (!isAnnouncementKey(key)) return;

  const store = await cookies();
  store.set(ANNOUNCEMENT_COOKIE, key, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ANNOUNCEMENT_COOKIE_MAX_AGE,
  });
}
