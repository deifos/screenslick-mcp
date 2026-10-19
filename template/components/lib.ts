// Small helpers shared by the components. Components import only react, remotion and this file,
// so they bundle the same way in the gallery, the studio preview, the browser export and a local render.
import { Easing, interpolate, spring } from "remotion";

/** Scale for the frame size: 1 at 1080 px on the short side. */
export const unit = (width: number, height: number) => Math.min(width, height) / 1080;

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 0→1 over `frames` starting at `start`, eased. */
export function ramp(frame: number, start: number, frames: number, easing = Easing.bezier(0.22, 1, 0.36, 1)) {
  return interpolate(frame, [start, start + Math.max(1, frames)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing,
  });
}

/** A soft spring for entrances (no overshoot past ~4%). */
export function pop(frame: number, fps: number, delay = 0, stiffness = 170) {
  return spring({ frame: frame - delay, fps, config: { damping: 18, stiffness, mass: 0.9 } });
}

/** 1 while on screen, easing to 0 over the last `frames` of the clip (the shared exit). */
export function exitOut(frame: number, durationInFrames: number, frames = 12) {
  return 1 - ramp(frame, durationInFrames - frames, frames, Easing.bezier(0.55, 0, 0.75, 0.25));
}

export const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Split "Make videos with *Claude*" into words, marking *starred* ones as highlighted. */
export function splitHighlights(line: string) {
  return line
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const highlighted = /^\*.*\*[.,!?:;]*$/.test(word);
      return { text: highlighted ? word.replace(/\*/g, "") : word, highlighted };
    });
}

export const FONTS: Record<string, string> = {
  sans: 'Inter, "Geist", "Segoe UI", system-ui, -apple-system, sans-serif',
  display: '"Bricolage Grotesque", "Geist", Inter, system-ui, sans-serif',
  serif: '"Instrument Serif", Georgia, "Times New Roman", serif',
  mono: '"Geist Mono", "JetBrains Mono", ui-monospace, Menlo, monospace',
};

/** Readable text on a color: near-black or white. */
export function onColor(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? "#0b0d10" : "#ffffff";
}
