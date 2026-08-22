"use client";

import * as React from "react";

import {
  clampFraming,
  frameRect,
  MAX_ADJUSTMENT,
  MAX_ZOOM,
  MIN_ZOOM,
  type Framing,
} from "@/lib/images/frame";

/**
 * The window the picture is dragged around behind.
 *
 * ## What this is
 *
 * A **viewer for five numbers**. It renders `framing` and reports changes to
 * it; it cuts nothing and produces no pixels. The rectangle is cut server-side
 * from the same five numbers by `renderSiteImage`, and both sides compute it
 * with the same imported `frameRect` — which is the only reason the owner can
 * trust that what they let go of is what the shop stores.
 *
 * The product crop tool (`crop-stage.tsx`) makes the same promise about a
 * square. This one is about an arbitrary rectangle, and it is a separate
 * component rather than a parameter on that one because the two differ in the
 * property that shapes every line: a product crop is *allowed to overhang* the
 * photograph and pad the difference, and this one is not. That single
 * difference removes the padding colour, the rotated-frame arithmetic and the
 * fill guide, and it adds a hard clamp at the edges. Threading a flag through
 * the other component to switch all of that off would have left one file where
 * half the code is dead on every call.
 *
 * ## Touch first
 *
 * Drag with one finger, pinch with two; on a desktop drag with the mouse and
 * scroll to zoom. One set of Pointer Events gives all of it, so there is no
 * separate touch path to fall out of sync, and pointer capture means a drag
 * that leaves the box keeps working instead of stopping dead at the edge —
 * which on a phone is most drags, and the owner is on a phone.
 *
 * The sliders below are not a fallback for the gestures. They are the version
 * that works with a keyboard, that a screen reader can name, and that a harness
 * can operate by its visible label. The rule in this codebase is that a control
 * which cannot be found by its label is a defect.
 */

/** How far one arrow-key press moves the picture, as a fraction of the frame. */
const NUDGE = 0.02;

/** One wheel notch, as a proportion of the current zoom. */
const WHEEL_STEP = 0.0012;

export type Source = { width: number; height: number };

export function FrameStage({
  src,
  source,
  aspect,
  framing,
  onChange,
  disabled,
  label,
}: {
  /** The **original**, not the derivative. Framing a framed picture is a copy. */
  src: string;
  /** The original's dimensions, as the server measured them. */
  source: Source;
  /** The output shape, width divided by height. */
  aspect: number;
  framing: Framing;
  onChange: (next: Framing) => void;
  disabled?: boolean;
  /** Names the group, so a screen reader says which picture this is. */
  label: string;
}) {
  const stageRef = React.useRef<HTMLDivElement>(null);
  const pointers = React.useRef(new Map<number, { x: number; y: number }>());
  /** The pinch distance and zoom at the moment the second finger landed. */
  const pinch = React.useRef<{ distance: number; zoom: number } | null>(null);

  /**
   * The rectangle of the original that this framing selects.
   *
   * Everything below is laid out from it, so the preview cannot drift from the
   * extract: the picture is scaled so that `rect.width` spans the stage, and
   * shifted so that `rect.left` sits at the stage's left edge. There is no
   * second model of "where the picture is" to keep in step.
   */
  const rect = React.useMemo(
    () => frameRect(source.width, source.height, aspect, framing),
    [source.width, source.height, aspect, framing],
  );

  /** Apply a change through the same clamp the server will. */
  function commit(next: Framing) {
    onChange(clampFraming(source.width, source.height, aspect, next));
  }

  function move(dx: number, dy: number) {
    commit({ ...framing, cx: framing.cx + dx, cy: framing.cy + dy });
  }

  function zoomTo(zoom: number) {
    commit({ ...framing, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) });
  }

  /* ------------------------------------------------------- pointers ------ */

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      pinch.current = { distance: spread(pointers.current), zoom: framing.zoom };
    }
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (disabled) return;
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage || stage.width === 0) return;

    if (pointers.current.size >= 2 && pinch.current) {
      const distance = spread(pointers.current);
      if (pinch.current.distance > 0) {
        // Pinching apart magnifies, which is a *larger* zoom. The product tool
        // divides here because its number runs the other way.
        zoomTo(pinch.current.zoom * (distance / pinch.current.distance));
      }
      return;
    }

    /*
      A drag moves the picture, so the window moves the other way — and it moves
      by the fraction of the *selected rectangle* the finger crossed, not of the
      stage. Zoomed in, the same travel covers less photograph, which is what
      makes a magnified drag feel precise rather than skittish.
    */
    const perPixel = rect.width / stage.width;
    move(
      (-(event.clientX - previous.x) * perPixel) / source.width,
      (-(event.clientY - previous.y) * perPixel) / source.height,
    );
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  }

  /* ------------------------------------------------------ rendering ------ */

  /*
    Percentages of the stage, and the axes are deliberately not symmetric:
    `left` and `width` are percentages of the stage's *width*, `top` is a
    percentage of its *height*. Because the stage has the frame's aspect and the
    rectangle has the frame's aspect, the scale is the same in both directions —
    so `height: auto` on the image is correct and does not need stating.

    Getting a percentage's basis wrong here is invisible to every assertion:
    the numbers stay plausible, the readout stays right, and the picture sits in
    the wrong place. The product crop tool has that exact bug written up in its
    own comments; this layout avoids the class by never translating by a
    percentage of the element itself.
  */
  const widthPercent = (source.width / rect.width) * 100;
  const leftPercent = (-rect.left / rect.width) * 100;
  const topPercent = (-rect.top / rect.height) * 100;

  return (
    <div className="space-y-3">
      <div
        ref={stageRef}
        tabIndex={disabled ? -1 : 0}
        role="group"
        aria-label={`${label} — drag to move, pinch or scroll to zoom, arrow keys to nudge`}
        aria-disabled={disabled || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={(event) => {
          if (disabled) return;
          zoomTo(framing.zoom * (1 - event.deltaY * WHEEL_STEP));
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          const step = event.shiftKey ? NUDGE * 4 : NUDGE;
          switch (event.key) {
            case "ArrowLeft":
              move(-step, 0);
              break;
            case "ArrowRight":
              move(step, 0);
              break;
            case "ArrowUp":
              move(0, -step);
              break;
            case "ArrowDown":
              move(0, step);
              break;
            case "+":
            case "=":
              zoomTo(framing.zoom * 1.05);
              break;
            case "-":
              zoomTo(framing.zoom / 1.05);
              break;
            default:
              return;
          }
          // Only once a key has been handled: swallowing every key would take
          // the page's own scrolling and shortcuts with it.
          event.preventDefault();
        }}
        style={{ aspectRatio: String(aspect) }}
        className={[
          "bg-photo relative w-full overflow-hidden rounded-lg",
          /*
            No `outline-hidden`. This div is `tabIndex={0}` and is driven from
            the keyboard; a focusable control that shows no focus is a control a
            keyboard user is operating blind. `overflow-hidden` clips the image,
            not the ring — an outline is painted outside the border box.
          */
          // Without `touch-none` the browser claims the drag for page scrolling
          // and the picture twitches once and stops.
          "touch-none select-none",
          disabled
            ? "cursor-progress opacity-60"
            : "cursor-grab active:cursor-grabbing",
        ].join(" ")}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt=""
          draggable={false}
          className="absolute max-w-none"
          style={{
            width: `${widthPercent}%`,
            left: `${leftPercent}%`,
            top: `${topPercent}%`,
            filter: adjustmentFilter(framing),
          }}
        />
      </div>

      <FrameControls framing={framing} onChange={commit} disabled={disabled} />
    </div>
  );
}

/** Zoom and tone, labelled — the keyboard and screen-reader path to the same numbers. */
function FrameControls({
  framing,
  onChange,
  disabled,
}: {
  framing: Framing;
  onChange: (next: Framing) => void;
  disabled?: boolean;
}) {
  const id = React.useId().replace(/:/g, "");
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Slider
        id={`${id}-zoom`}
        label="Zoom"
        value={Number(framing.zoom.toFixed(2))}
        min={MIN_ZOOM}
        max={MAX_ZOOM}
        step={0.01}
        suffix="x"
        disabled={disabled}
        onChange={(next) => onChange({ ...framing, zoom: next })}
      />
      <Slider
        id={`${id}-brightness`}
        label="Brightness"
        value={framing.brightness}
        min={-MAX_ADJUSTMENT}
        max={MAX_ADJUSTMENT}
        step={1}
        disabled={disabled}
        onChange={(next) => onChange({ ...framing, brightness: next })}
      />
      <Slider
        id={`${id}-contrast`}
        label="Contrast"
        value={framing.contrast}
        min={-MAX_ADJUSTMENT}
        max={MAX_ADJUSTMENT}
        step={1}
        disabled={disabled}
        onChange={(next) => onChange({ ...framing, contrast: next })}
      />
    </div>
  );
}

function Slider({
  id,
  label,
  value,
  min,
  max,
  step,
  suffix,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 flex items-baseline justify-between text-sm font-medium"
      >
        <span>{label}</span>
        <span className="text-muted-foreground tabular-nums">
          {value}
          {suffix ?? ""}
        </span>
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        /* `accent-orange` is the mapped token name; `accent-fv-orange` silently
           produces no class and the slider renders in the browser's default
           blue. h-11 because 44px is the smallest reliable touch target. */
        className="accent-orange h-11 w-full"
        onChange={(event) => onChange(event.target.valueAsNumber)}
      />
    </div>
  );
}

/**
 * Brightness and contrast, previewed in CSS.
 *
 * An honest approximation rather than a promise, and the same one the product
 * crop tool makes: the server applies `modulate` and a linear ramp pivoting on
 * mid-grey, and the browser's filter functions are close but not identical. The
 * *framing* — the thing this component exists for — is exact.
 */
function adjustmentFilter(framing: Framing): string | undefined {
  if (framing.brightness === 0 && framing.contrast === 0) return undefined;
  const brightness = 1 + framing.brightness / (MAX_ADJUSTMENT * 2.5);
  const contrast = 1 + framing.contrast / (MAX_ADJUSTMENT * 2.5);
  return `brightness(${brightness}) contrast(${contrast})`;
}

function spread(pointers: Map<number, { x: number; y: number }>): number {
  const [first, second] = [...pointers.values()];
  if (!first || !second) return 0;
  return Math.hypot(first.x - second.x, first.y - second.y);
}
