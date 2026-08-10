"use client";

import Image, { type ImageProps } from "next/image";

import { loaderFor } from "@/lib/images/srcset";

/**
 * A product photograph, served from the pipeline's own variants when it has
 * them.
 *
 * ## Why this wrapper exists at all
 *
 * `next/image` takes a `loader`, and a loader is a function. `ProductCard` is a
 * Server Component, and a function cannot cross the server/client boundary as a
 * prop — so the choice of loader has to be made on the client side of that
 * line. This file is that line, and it is `"use client"` for no other reason.
 *
 * It costs nothing meaningful: `next/image` is already a client component, so
 * the element was going to be rendered by client code either way. Only the
 * decision about which URL to fetch moves here; the card's markup, its text and
 * its prices stay server-rendered.
 *
 * ## Why every product image should come through here
 *
 * The alternative is each of the six render sites deciding for itself whether a
 * URL is a derivative, which is six places to forget. `loaderFor` returns the
 * loader **or undefined**, so an image that is not a pipeline output silently
 * gets the ordinary optimiser path — the seed SVGs and anything uploaded before
 * Phase 10 keep behaving exactly as they did.
 *
 * That fallback is why this can be adopted one call site at a time and why the
 * catalogue does not need reprocessing before it works.
 */
export function ProductImage(props: ImageProps) {
  const src = typeof props.src === "string" ? props.src : null;

  /**
   * `loader` is passed as `undefined` rather than omitted when there is no
   * derivative, which `next/image` treats identically to not supplying it.
   * Writing it as one expression keeps the two halves — "is this ours" and
   * "how do we fetch it" — from ever being answered differently.
   */
  /*
    `alt` is required by `ImageProps` and arrives inside the spread, so tsc
    already guarantees every caller supplies one. jsx-a11y cannot see through a
    spread and reports it missing; re-declaring `alt` here to satisfy the rule
    would let this wrapper silently override what the caller passed, which is
    the worse outcome of the two.
  */
  // eslint-disable-next-line jsx-a11y/alt-text
  return <Image {...props} loader={src ? loaderFor(src) : undefined} />;
}
