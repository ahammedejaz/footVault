import type { Metadata } from "next";

import { TreadMark } from "@/components/brand/logo";
import { SizeRun } from "@/components/storefront/size-run";
import type { SizeAvailability } from "@/lib/catalog-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRupees } from "@/lib/format";

export const metadata: Metadata = {
  title: "Design system",
  description:
    "The Foot Vault tokens, type scale and restyled primitives, rendered.",
  robots: { index: false, follow: false },
};

const SWATCHES = [
  { name: "ink", hex: "#0A1526", note: "hero, footer, admin chrome" },
  { name: "ink-soft", hex: "#0E2A5C", note: "raised navy" },
  { name: "blue", hex: "#033894", note: "logo blue — mark only" },
  { name: "steel", hex: "#596475", note: "secondary text" },
  { name: "line", hex: "#C8D0DB", note: "hairlines, inputs" },
  { name: "fog", hex: "#EEF1F5", note: "cards, section bands" },
  { name: "paper", hex: "#FBFCFD", note: "page base" },
  { name: "orange", hex: "#FE9301", note: "the only accent" },
  { name: "orange-ink", hex: "#A85400", note: "orange as text on light" },
  { name: "brand-green", hex: "#1F7A55", note: "admin status only" },
];

const SCALE = [
  { cls: "text-6xl font-display font-extrabold tracking-[-0.03em]", label: "64 / 60 · Archivo 800 Expanded", sample: "Hero" },
  { cls: "text-4xl font-display font-extrabold tracking-[-0.02em]", label: "40 / 44 · Archivo 800 Expanded", sample: "Section head" },
  { cls: "text-2xl font-display font-bold tracking-[-0.02em]", label: "28 / 34 · Archivo 700 Expanded", sample: "Product title" },
  { cls: "text-lg font-semibold", label: "20 / 28 · Instrument Sans 600", sample: "Sub-head" },
  { cls: "text-base", label: "16 / 26 · Instrument Sans 400", sample: "Body copy default" },
  { cls: "text-base font-mono font-medium", label: "16 / 16 · Geist Mono 500", sample: formatRupees(8995) },
  { cls: "text-sm", label: "14 / 22 · Instrument Sans 400", sample: "Card title, labels" },
  { cls: "text-xs font-mono tracking-[0.06em]", label: "12 / 16 · Geist Mono 400 +0.06em", sample: "SIZE RUN · SKU · ORDER NO." },
];

/** Shaped like the real thing: SizeRun now takes stock counts, not a boolean. */
const SAMPLE_RUN: SizeAvailability[] = [
  { size: "6", stock: 6, available: true },
  { size: "7", stock: 4, available: true },
  { size: "8", stock: 9, available: true },
  { size: "9", stock: 2, available: true },
  { size: "10", stock: 0, available: false },
  { size: "11", stock: 5, available: true },
  { size: "12", stock: 0, available: false },
];

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border border-t py-12">
      <h2 className="font-display text-2xl font-bold tracking-[-0.02em] uppercase">
        {title}
      </h2>
      <div className="mt-6">{children}</div>
    </section>
  );
}

export default function StyleGuidePage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <h1 className="font-display text-4xl font-extrabold tracking-[-0.03em] uppercase">
        Design system
      </h1>
      <p className="text-muted-foreground mt-3 max-w-2xl text-base">
        Every token, type step and primitive shipped in Phase 0. Full rationale
        and the measured contrast table live in{" "}
        <code className="font-mono text-sm">docs/design-system.md</code>.
      </p>

      <Section title="Colour">
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {SWATCHES.map((swatch) => (
            <li key={swatch.name}>
              <div
                className="border-border h-20 rounded-lg border"
                style={{ backgroundColor: swatch.hex }}
              />
              <p className="mt-2 font-mono text-xs tracking-[0.06em]">
                {swatch.name}
              </p>
              <p className="text-muted-foreground font-mono text-xs">
                {swatch.hex}
              </p>
              <p className="text-muted-foreground mt-1 text-sm">{swatch.note}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Type">
        <ul className="space-y-6">
          {SCALE.map((step) => (
            <li
              key={step.label}
              className="border-border grid gap-2 border-b pb-6 last:border-0 sm:grid-cols-[16rem_1fr] sm:items-baseline"
            >
              <span className="text-muted-foreground font-mono text-xs tracking-[0.06em]">
                {step.label}
              </span>
              <span className={step.cls}>{step.sample}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="The size run">
        <p className="text-muted-foreground max-w-2xl text-base">
          UK sizes. Sold out is struck through and dimmed, never hidden.
        </p>
        <div className="mt-6 grid gap-8 sm:grid-cols-2">
          <div>
            <p className="text-muted-foreground font-mono text-xs tracking-[0.06em] uppercase">
              On a card — compact
            </p>
            <div className="border-border mt-3 rounded-lg border p-4">
              <p className="text-sm">Runner Low Leather</p>
              <p className="mt-1 font-mono text-base font-medium">
                {formatRupees(8995)}
              </p>
              <div className="border-border mt-3 border-t pt-3">
                <SizeRun sizes={SAMPLE_RUN} compact />
              </div>
            </div>
          </div>
          <div>
            <p className="text-muted-foreground font-mono text-xs tracking-[0.06em] uppercase">
              On the product page — 48px chips
            </p>
            <div className="mt-3">
              <SizeRun sizes={SAMPLE_RUN} />
            </div>
          </div>
        </div>
      </Section>

      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          <Button size="lg">Add to bag</Button>
          <Button>Place order</Button>
          <Button variant="outline">Continue shopping</Button>
          <Button variant="secondary">Save address</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="destructive">Delete product</Button>
          <Button variant="link">Size guide</Button>
          <Button size="sm">Edit</Button>
        </div>
        <p className="text-muted-foreground mt-4 max-w-2xl text-sm">
          Primary is navy on orange, never white on orange — white measures
          2.24:1 against #FE9301 and fails. Tab through these to see the
          composite focus ring.
        </p>
      </Section>

      <Section title="Forms and status">
        <div className="grid max-w-md gap-4">
          <div className="grid gap-2">
            <Label htmlFor="sg-email">Email</Label>
            <Input id="sg-email" type="email" placeholder="you@example.com" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge>New</Badge>
            <Badge variant="secondary">Confirmed</Badge>
            <Badge variant="outline">Packed</Badge>
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </div>
      </Section>

      <Section title="Navy surface">
        <div data-surface="ink" className="relative isolate overflow-hidden rounded-lg p-8">
          <div className="tread-texture pointer-events-none absolute inset-0" aria-hidden="true" />
          <div className="relative flex flex-wrap items-center gap-6">
            <TreadMark className="text-orange h-16 w-8" />
            <div>
              <p className="font-display text-2xl font-bold tracking-[-0.02em] uppercase">
                Same primitives, inverted
              </p>
              <p className="text-muted-foreground mt-2 max-w-md text-sm">
                Anything inside <code className="font-mono">data-surface=&quot;ink&quot;</code>{" "}
                remaps the semantic tokens, so components restyle themselves
                without per-component overrides.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <Button>Add to bag</Button>
                <Button variant="outline">Track order</Button>
              </div>
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}
