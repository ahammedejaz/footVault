import { getImageProps, type ImageProps } from "next/image";

/**
 * next/image carries two layout strategies, and exactly one may be used per
 * rendered image:
 *
 *   fill            the image is absolutely positioned to fill a positioned
 *                   ancestor, and the ancestor owns the box
 *   width + height  the image carries its own intrinsic box
 *
 * `ImageProps` declares all three as independent optionals, so supplying both
 * type-checks and then throws at render: *"has both width and fill properties.
 * Only one should be used."* That is how the homepage went down. A shared props
 * object carrying `fill: true` was spread into two `getImageProps` calls that
 * each also supplied `width`/`height` for their crop, and the collision existed
 * only at runtime — on the hero, which is the LCP element of the busiest page
 * on the site, so the failure was a 500 rather than a bad-looking image.
 *
 * The shape of the mistake is what matters more than the instance: a *shared*
 * props object is exactly the thing that ends up holding a layout key it should
 * not own, because it reads as "the props both images agree on" and a layout is
 * never something two differently-shaped images agree on.
 *
 * So the two halves are typed to make the merge safe by construction:
 *
 *   `SharedImageProps` is structurally incapable of holding a layout key —
 *   `fill`, `width` and `height` are `?: never`, so writing one into the shared
 *   object is the compile error, at the place the mistake is actually made.
 *
 *   `ImageLayout` is a discriminated union, so the layout half can be `fill` or
 *   `width`+`height` and never both.
 *
 * A spread of one into the other can then only produce one strategy, and tsc
 * says so before the page does.
 */

/** One layout strategy. Never both — that is the entire point of the union. */
export type ImageLayout =
  | { fill: true; width?: never; height?: never }
  | { fill?: never; width: number; height: number };

/**
 * Everything two renderings of an image can legitimately agree on: alt, sizes,
 * quality, priority, loading. Deliberately not the layout, and not the src.
 */
export type SharedImageProps = Omit<
  ImageProps,
  "src" | "fill" | "width" | "height"
> & {
  fill?: never;
  width?: never;
  height?: never;
};

/**
 * The `<img>` attributes for one crop of an art-directed image.
 *
 * `getImageProps` rather than an `<Image>` element because `<Image>` cannot emit
 * a `<source media>`, and two `<Image>` elements make the browser download both
 * crops and discard one — on a 4G phone that is the entire image budget spent
 * twice.
 */
export function imageSourceProps(
  shared: SharedImageProps,
  src: ImageProps["src"],
  layout: ImageLayout,
) {
  return getImageProps({ ...shared, src, ...layout }).props;
}
