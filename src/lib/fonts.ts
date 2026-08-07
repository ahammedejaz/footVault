import { Archivo, Geist_Mono, Instrument_Sans } from "next/font/google";

/**
 * Three type roles, per docs/design-system.md §3.
 *
 * Display  — Archivo at expanded width. Hero and section headers only.
 * Body     — Instrument Sans. Everything readable.
 * Utility  — Geist Mono. Sizes, SKUs, prices, order numbers, stock counts.
 *
 * All self-hosted through next/font. No network font requests at runtime.
 */

/**
 * Archivo ships a `wdth` axis. Loading it as a variable font lets the display
 * role sit at 112% width without a second file, which is what gives headings
 * their squared-off stance.
 */
export const fontDisplay = Archivo({
  variable: "--fv-font-display",
  subsets: ["latin"],
  // Loaded as a variable font so the `wdth` axis is available. next/font
  // rejects `axes` alongside an explicit weight list, and the weight range
  // comes along on the `wght` axis anyway.
  axes: ["wdth"],
  display: "swap",
});

export const fontBody = Instrument_Sans({
  variable: "--fv-font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

/**
 * Geist Mono through next/font rather than through the `geist` package.
 *
 * The package ships one variable file covering every unicode range it has —
 * 71KB, preloaded, on every page. Google's copy subsets to latin, which is what
 * this site sets in mono: sizes, SKUs, prices and stock counts. Same typeface,
 * a fifth of the bytes, and the bytes it saves come straight off the critical
 * path in front of the LCP image.
 */
export const fontMono = Geist_Mono({
  variable: "--fv-font-mono",
  subsets: ["latin"],
  display: "swap",
});

export const fontVariables = [
  fontDisplay.variable,
  fontBody.variable,
  fontMono.variable,
].join(" ");
