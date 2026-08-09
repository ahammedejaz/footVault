/**
 * Static image imports (`import logo from ".../logo.png"`) type-check via
 * `next/image-types/global`, which normally arrives through `next-env.d.ts` —
 * a file this repo gitignores because `next dev` rewrites it. CI runs `tsc`
 * on a fresh checkout where that file does not exist, so the reference has to
 * live somewhere committed. Here.
 */
/// <reference types="next/image-types/global" />
