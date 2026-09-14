// Motion primitives. Every value is a pure function of (frame, fps); nothing here uses CSS
// transitions. Easing is never linear (see storyboard.json, aesthetic.motionCharacter).
import { Easing, interpolate, spring } from "remotion";

export const EASE_SNAP = Easing.bezier(0.16, 1, 0.3, 1);
export const EASE_GLIDE = Easing.bezier(0.25, 0.1, 0.25, 1);
export const EASE_DRAMA = Easing.bezier(0.7, 0, 0.3, 1);
export const EASE_DRIFT = Easing.bezier(0.4, 0, 0.6, 1);

export const PRECISE = { damping: 200, stiffness: 300, mass: 1 };
export const HEAVY = { damping: 200, stiffness: 80, mass: 2 };
export const BOUNCE = { damping: 12, stiffness: 200, mass: 0.6 };
export const SLAM = { damping: 15, stiffness: 300, mass: 0.8 };

const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };

/** 0 → 1 between delay and delay + duration (seconds). */
export function ramp(frame: number, fps: number, delaySec: number, durationSec: number, easing = EASE_SNAP) {
  return interpolate(frame, [delaySec * fps, (delaySec + durationSec) * fps], [0, 1], {
    ...clamp,
    easing,
  });
}

/** 1 → 0 between delay and delay + duration. */
export function rampOut(frame: number, fps: number, delaySec: number, durationSec: number, easing = EASE_GLIDE) {
  return 1 - ramp(frame, fps, delaySec, durationSec, easing);
}

/** Spring progress starting at delay (seconds). */
export function pop(
  frame: number,
  fps: number,
  delaySec: number,
  config: { damping: number; stiffness: number; mass: number } = PRECISE,
) {
  const delay = Math.round(delaySec * fps);
  if (frame < delay) return 0;
  return spring({ frame: frame - delay, fps, config });
}

/** An entrance: opacity, translate (px), scale, blur (px), all from one progress value. */
export function enter(
  frame: number,
  fps: number,
  delaySec: number,
  options: {
    durationSec?: number;
    from?: { x?: number; y?: number; scale?: number; blur?: number; rotate?: number };
    spring?: { damping: number; stiffness: number; mass: number } | null;
  } = {},
) {
  const from = { x: 0, y: 24, scale: 0.96, blur: 8, rotate: 0, ...options.from };
  const p = options.spring
    ? pop(frame, fps, delaySec, options.spring)
    : ramp(frame, fps, delaySec, options.durationSec ?? 0.5);
  const fade = ramp(frame, fps, delaySec, Math.min(options.durationSec ?? 0.5, 0.4));
  return {
    p,
    opacity: fade,
    x: from.x * (1 - p),
    y: from.y * (1 - p),
    scale: from.scale + (1 - from.scale) * p,
    blur: from.blur * (1 - fade),
    rotate: from.rotate * (1 - p),
  };
}

/** Compound scene exit: opacity, scale, blur over the last `durationSec` of `sceneSec`. */
export function exit(frame: number, fps: number, sceneSec: number, durationSec = 0.45) {
  const p = ramp(frame, fps, sceneSec - durationSec, durationSec, EASE_DRAMA);
  return { opacity: 1 - p, scale: 1 - 0.05 * p, blur: 8 * p };
}

export const stagger = (index: number, baseSec: number, stepSec: number) => baseSec + index * stepSec;

export const float = (frame: number, fps: number, amplitude: number, periodSec: number, phase = 0) =>
  Math.sin(((frame / fps) * Math.PI * 2) / periodSec + phase) * amplitude;

export const pulse = (frame: number, fps: number, amount: number, periodSec: number, phase = 0) =>
  1 + float(frame, fps, amount, periodSec, phase);

/** Characters visible for a typewriter that starts at delay and types at cps characters/second. */
export function typed(frame: number, fps: number, delaySec: number, text: string, cps = 45) {
  const chars = Math.floor(Math.max(0, frame / fps - delaySec) * cps);
  return text.slice(0, Math.min(text.length, chars));
}

export const caretOn = (frame: number, fps: number) => Math.floor((frame / fps) * 2.2) % 2 === 0;

export const style = (e: ReturnType<typeof enter>) => ({
  opacity: e.opacity,
  transform: `translate(${e.x}px, ${e.y}px) scale(${e.scale}) rotate(${e.rotate}deg)`,
  filter: `blur(${e.blur}px)`,
});
