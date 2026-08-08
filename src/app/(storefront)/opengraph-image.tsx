import { ImageResponse } from "next/og";

import { prerenderOrDefer } from "@/lib/prerender";
import { getSiteSettings, setting } from "@/lib/queries/content";

/**
 * The default social card.
 *
 * Generated rather than uploaded, for the same reason the sitemap is: the shop
 * name and the tagline live in `site_settings`, and a card that still says the
 * old name six months after the owner changed it is worse than no card.
 *
 * PNG, because that is what the platforms accept — the storefront's own imagery
 * is SVG, which Facebook, WhatsApp and X all refuse to render.
 */
export const alt = "Foot Vault — every size we hold, shown on every shoe";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage() {
  const settings = await prerenderOrDefer("og image", getSiteSettings);
  const name = setting<string>(settings, "store_name", "Foot Vault");
  const tagline = setting<string>(
    settings,
    "store_tagline",
    "Every step counts",
  );

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "linear-gradient(135deg, #12294c 0%, #0a1526 65%)",
        padding: 80,
        color: "#fbfcfd",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <div
          style={{
            width: 18,
            height: 44,
            borderRadius: 9,
            background: "#fe9301",
          }}
        />
        <div
          style={{
            fontSize: 34,
            letterSpacing: 6,
            textTransform: "uppercase",
            fontWeight: 700,
          }}
        >
          {name}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div
          style={{
            fontSize: 76,
            fontWeight: 800,
            lineHeight: 1.05,
            maxWidth: 900,
          }}
        >
          Every size we hold, shown on every shoe
        </div>
        <div style={{ fontSize: 30, color: "#a8b4c6" }}>{tagline}</div>
      </div>

      {/* The size run, which is the thing this shop is actually about. */}
      <div style={{ display: "flex", gap: 18, fontSize: 30, letterSpacing: 3 }}>
        {["6", "7", "8", "9", "10", "11", "12"].map((s, i) => (
          <div
            key={s}
            style={{
              color: i === 0 || i === 6 ? "#646e7b" : "#fbfcfd",
              textDecoration: i === 0 || i === 6 ? "line-through" : "none",
            }}
          >
            {s}
          </div>
        ))}
      </div>
    </div>,
    size,
  );
}
