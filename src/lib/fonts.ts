import { Archivo, Instrument_Sans } from "next/font/google";
import { GeistMono } from "geist/font/mono";

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

export const fontMono = GeistMono;

export const fontVariables = [
  fontDisplay.variable,
  fontBody.variable,
  fontMono.variable,
].join(" ");
