import type { Gender } from "@/lib/catalog-types";

/**
 * UK → EU → US → CM.
 *
 * UK is primary throughout the site because it is what an Indian shelf label
 * says. The conversions here are the ones the major brands publish for adult
 * lasts; they are close but not identical between brands, which the modal says
 * out loud rather than pretending to a precision shoes do not have.
 *
 * CM is the foot length, not the shoe length, and it is the only column that
 * means anything absolute — which is why the modal tells you how to measure.
 */
export type SizeConversion = { uk: string; eu: string; us: string; cm: string };

const MEN: SizeConversion[] = [
  { uk: "6", eu: "39.5", us: "7", cm: "25.0" },
  { uk: "7", eu: "40.5", us: "8", cm: "26.0" },
  { uk: "8", eu: "42", us: "9", cm: "27.0" },
  { uk: "9", eu: "43", us: "10", cm: "28.0" },
  { uk: "10", eu: "44.5", us: "11", cm: "29.0" },
  { uk: "11", eu: "46", us: "12", cm: "30.0" },
  { uk: "12", eu: "47", us: "13", cm: "31.0" },
];

const WOMEN: SizeConversion[] = [
  { uk: "3", eu: "35.5", us: "5", cm: "22.0" },
  { uk: "4", eu: "37", us: "6", cm: "23.0" },
  { uk: "5", eu: "38", us: "7", cm: "24.0" },
  { uk: "6", eu: "39.5", us: "8", cm: "25.0" },
  { uk: "7", eu: "40.5", us: "9", cm: "26.0" },
  { uk: "8", eu: "42", us: "10", cm: "27.0" },
];

const KIDS: SizeConversion[] = [
  { uk: "10C", eu: "28", us: "10.5C", cm: "17.0" },
  { uk: "11C", eu: "29", us: "11.5C", cm: "18.0" },
  { uk: "12C", eu: "30.5", us: "12.5C", cm: "19.0" },
  { uk: "13C", eu: "32", us: "13.5C", cm: "20.0" },
  { uk: "1", eu: "33", us: "1.5Y", cm: "20.5" },
  { uk: "2", eu: "34", us: "2.5Y", cm: "21.5" },
  { uk: "3", eu: "35.5", us: "3.5Y", cm: "22.5" },
];

export function conversionsFor(gender: Gender): SizeConversion[] {
  if (gender === "kids") return KIDS;
  if (gender === "women") return WOMEN;
  return MEN;
}

/** The row for one UK size, if the table has it. */
export function conversionFor(
  gender: Gender,
  uk: string,
): SizeConversion | undefined {
  return conversionsFor(gender).find((row) => row.uk === uk);
}
