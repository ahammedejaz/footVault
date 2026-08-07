import { ImageResponse } from "next/og";

import { getProduct } from "@/lib/queries/catalog";
import { formatPaise } from "@/lib/format";

/**
 * A product's social card.
 *
 * Built from the same three facts the product page leads with — brand, name,
 * price — plus the size run, struck through where it is sold out. A card that
 * shows the shoe and not the sizes would be a card that says less than the
 * card on the listing page.
 *
 * PNG, because the seed's product imagery is SVG and no social platform renders
 * it. That also means the shoe itself cannot be composited in here without a
 * raster source; when the owner uploads photography in Phase 6 this is the one
 * place that gains an <img>.
 */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Product at Foot Vault";

export default async function ProductOpengraphImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const product = await getProduct(slug);

  const brand = product?.brandName ?? "Foot Vault";
  const name = product?.name ?? "No longer stocked";
  const price = product ? formatPaise(product.salePrice ?? product.basePrice) : "";
  const sizes = product?.sizes ?? [];

  return new ImageResponse(
    (
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
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ width: 14, height: 34, borderRadius: 7, background: "#fe9301" }} />
          <div style={{ fontSize: 26, letterSpacing: 6, textTransform: "uppercase" }}>
            Foot Vault
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: 28, letterSpacing: 6, textTransform: "uppercase", color: "#a8b4c6" }}>
            {brand}
          </div>
          <div style={{ fontSize: 68, fontWeight: 800, lineHeight: 1.05, maxWidth: 1000 }}>
            {name}
          </div>
          {price ? <div style={{ fontSize: 42, color: "#fe9301" }}>{price}</div> : null}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 22, letterSpacing: 4, color: "#a8b4c6", textTransform: "uppercase" }}>
            UK sizes
          </div>
          <div style={{ display: "flex", gap: 18, fontSize: 34, letterSpacing: 3 }}>
            {sizes.map((entry) => (
              <div
                key={entry.size}
                style={{
                  color: entry.available ? "#fbfcfd" : "#646e7b",
                  textDecoration: entry.available ? "none" : "line-through",
                }}
              >
                {entry.size}
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    size,
  );
}
