// StudioComposition: draws a project's layers.json with Remotion.
// Tracks are drawn bottom → top (tracks[0] is the top layer) so stacking never
// depends on z-index, which the browser export ignores.
import { useEffect, useMemo, useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import {
  AbsoluteFill,
  Img,
  Sequence,
  continueRender,
  delayRender,
  interpolate,
  useCurrentFrame,
  useRemotionEnvironment,
} from "remotion";
import { Audio, Video } from "@remotion/media";
// The ScreenSlick component library, provided by the studio page (and by a copy in
// .screenslick/components for local renders).
import { MOTION_COMPONENTS, resolveComponentProps } from "screenslick-studio/components";
import {
  StudioRuntimeContext,
  asset,
  clamp,
  setRuntimeState,
  type StudioRuntimeContextValue,
} from "./helpers";
import type {
  AudioClip,
  Box,
  CaptionsClip,
  ClipAnim,
  ImageClip,
  SceneClip,
  SceneProps,
  StudioClip,
  StudioCompositionProps,
  StudioFont,
  StudioTrack,
  TextClip,
  VideoClip,
} from "./types";

export type SceneRegistry = Record<string, ComponentType<SceneProps & Record<string, unknown>>>;

// ---------------------------------------------------------------------------
// Fonts

const loadedFontSpecs = new Map<string, Promise<void>>();

function fontSpecToCss(spec: string) {
  // "Inter:400;700;900" → family=Inter:wght@400;700;900 ; "Inter" → family=Inter
  const [family, weights] = spec.split(":");
  const name = family.trim().replace(/\s+/g, "+");
  return weights ? `family=${name}:wght@${weights.trim()}` : `family=${name}`;
}

function loadLocalFont(font: Exclude<StudioFont, string>): Promise<void> {
  const key = `${font.family}|${font.src}|${font.weight ?? ""}|${font.style ?? ""}`;
  const existing = loadedFontSpecs.get(key);
  if (existing) return existing;
  const promise = (async () => {
    if (typeof document === "undefined") return;
    const face = new FontFace(font.family, `url(${JSON.stringify(asset(font.src))})`, {
      weight: font.weight ?? "400",
      style: font.style ?? "normal",
    });
    try {
      document.fonts.add(await face.load());
    } catch {
      // Missing font file: keep rendering with the fallback font.
    }
  })();
  loadedFontSpecs.set(key, promise);
  return promise;
}

function loadFont(font: StudioFont): Promise<void> {
  return typeof font === "string" ? loadFontSpec(font) : loadLocalFont(font);
}

function loadFontSpec(spec: string): Promise<void> {
  const existing = loadedFontSpecs.get(spec);
  if (existing) return existing;
  const promise = (async () => {
    if (typeof document === "undefined") return;
    const href = `https://fonts.googleapis.com/css2?${fontSpecToCss(spec)}&display=block`;
    if (!document.querySelector(`link[data-studio-font="${CSS.escape(spec)}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.crossOrigin = "anonymous";
      link.dataset.studioFont = spec;
      await new Promise<void>((resolve) => {
        link.onload = () => resolve();
        link.onerror = () => resolve();
        document.head.appendChild(link);
      });
    }
    const [family, weights] = spec.split(":");
    const list = weights ? weights.split(";").map((w) => w.trim()) : ["400"];
    await Promise.all(
      list.map((weight) =>
        document.fonts.load(`${weight} 32px "${family.trim()}"`).catch(() => undefined),
      ),
    );
  })();
  loadedFontSpecs.set(spec, promise);
  return promise;
}

function useProjectFonts(fonts: StudioFont[]) {
  const key = fonts.map((font) => (typeof font === "string" ? font : `${font.family}|${font.src}|${font.weight ?? ""}`)).join("||");
  const [handle] = useState(() =>
    fonts.length > 0 ? delayRender(`Loading fonts ${key}`, { timeoutInMilliseconds: 20_000 }) : null,
  );
  useEffect(() => {
    if (handle === null) return;
    let cancelled = false;
    Promise.all(fonts.map(loadFont)).finally(() => {
      if (!cancelled) continueRender(handle);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, key]);
}

// ---------------------------------------------------------------------------
// Clip helpers

export function resolveClip<T extends StudioClip>(clip: T, variant: string): T {
  const override = (clip as { variants?: Record<string, Partial<T>> }).variants?.[variant];
  return override ? ({ ...clip, ...override } as T) : clip;
}

function animState(anim: ClipAnim | undefined, t: number) {
  // t: 0 = fully hidden, 1 = fully shown
  const preset = anim?.preset ?? "none";
  const out: { opacity: number; transform: string; filter?: string } = { opacity: 1, transform: "" };
  if (preset === "none" || t >= 1) return out;
  const inv = 1 - t;
  switch (preset) {
    case "fade":
      out.opacity = t;
      break;
    case "slide-up":
      out.opacity = t;
      out.transform = `translateY(${inv * 8}%)`;
      break;
    case "slide-down":
      out.opacity = t;
      out.transform = `translateY(${-inv * 8}%)`;
      break;
    case "slide-left":
      out.opacity = t;
      out.transform = `translateX(${inv * 8}%)`;
      break;
    case "slide-right":
      out.opacity = t;
      out.transform = `translateX(${-inv * 8}%)`;
      break;
    case "pop": {
      // overshoot: 0 → 1.08 → 1
      const s = t < 0.7 ? interpolate(t, [0, 0.7], [0.6, 1.08]) : interpolate(t, [0.7, 1], [1.08, 1]);
      out.opacity = Math.min(1, t * 2);
      out.transform = `scale(${s})`;
      break;
    }
    case "scale":
      out.opacity = t;
      out.transform = `scale(${0.85 + 0.15 * t})`;
      break;
    case "blur":
      out.opacity = t;
      out.filter = `blur(${inv * 16}px)`;
      break;
  }
  return out;
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/** Enter/exit + opacity wrapper for one visual clip; frame is local to the clip. */
function useClipStyle(clip: StudioClip): CSSProperties {
  const frame = useCurrentFrame();
  const enterFrames = clip.enter && clip.enter.preset !== "none" ? Math.max(1, clip.enter.frames) : 0;
  const exitFrames = clip.exit && clip.exit.preset !== "none" ? Math.max(1, clip.exit.frames) : 0;
  const tIn = enterFrames ? easeOutCubic(interpolate(frame, [0, enterFrames], [0, 1], clamp)) : 1;
  const tOut = exitFrames
    ? easeOutCubic(interpolate(frame, [clip.duration - exitFrames, clip.duration], [1, 0], clamp))
    : 1;
  const a = animState(clip.enter, tIn);
  const b = animState(clip.exit, tOut);
  const transform = [a.transform, b.transform].filter(Boolean).join(" ");
  const filter = [a.filter, b.filter].filter(Boolean).join(" ");
  return {
    opacity: a.opacity * b.opacity * (clip.opacity ?? 1),
    transform: transform || undefined,
    filter: filter || undefined,
  };
}

function boxStyle(box: Box | undefined): CSSProperties {
  if (!box) return { position: "absolute", left: 0, top: 0, width: "100%", height: "100%" };
  return {
    position: "absolute",
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.width * 100}%`,
    height: `${box.height * 100}%`,
  };
}

// ---------------------------------------------------------------------------
// Clip renderers (all frames local to the clip's <Sequence>)

function SceneClipView({
  clip,
  scenes,
  ctx,
}: {
  clip: SceneClip;
  scenes: SceneRegistry;
  ctx: StudioRuntimeContextValue;
}) {
  const style = useClipStyle(clip);
  if (clip.component) {
    const entry = MOTION_COMPONENTS[clip.component];
    if (!entry) {
      return (
        <AbsoluteFill
          style={{
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(220,38,38,0.25)",
            color: "#fff",
            fontFamily: "sans-serif",
            fontSize: Math.round(ctx.height * 0.03),
          }}
        >
          Unknown component “{clip.component}”
        </AbsoluteFill>
      );
    }
    const Component = entry.Component;
    return (
      <AbsoluteFill style={style}>
        <Component
          {...resolveComponentProps(clip.component, clip.props)}
          width={ctx.width}
          height={ctx.height}
          fps={ctx.fps}
          durationInFrames={clip.duration}
          variant={ctx.variant}
        />
      </AbsoluteFill>
    );
  }
  const Scene = clip.scene ? scenes[clip.scene] : undefined;
  if (!Scene) {
    return (
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(220,38,38,0.25)",
          color: "#fff",
          fontFamily: "sans-serif",
          fontSize: Math.round(ctx.height * 0.03),
        }}
      >
        Missing scene “{clip.scene}” (scenes/{clip.scene}.tsx)
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={style}>
      <Scene
        {...(clip.props ?? {})}
        clip={{ id: clip.id, from: clip.from, duration: clip.duration }}
        variant={ctx.variant}
        width={ctx.width}
        height={ctx.height}
        fps={ctx.fps}
      />
    </AbsoluteFill>
  );
}

function ImageClipView({ clip }: { clip: ImageClip }) {
  const style = useClipStyle(clip);
  return (
    <div style={{ ...boxStyle(clip.box), ...style, overflow: "hidden", borderRadius: clip.radius }}>
      <Img
        src={asset(clip.src)}
        style={{ width: "100%", height: "100%", objectFit: clip.fit ?? "cover", display: "block" }}
      />
    </div>
  );
}

/** CSS filter for a color grade (supported by the browser export). */
function gradeFilter(grade: VideoClip["grade"]): string | undefined {
  if (!grade) return undefined;
  const parts: string[] = [];
  if (grade.brightness !== undefined && grade.brightness !== 1) parts.push(`brightness(${grade.brightness})`);
  if (grade.contrast !== undefined && grade.contrast !== 1) parts.push(`contrast(${grade.contrast})`);
  if (grade.saturation !== undefined && grade.saturation !== 1) parts.push(`saturate(${grade.saturation})`);
  const warmth = grade.warmth ?? 0;
  if (warmth > 0) parts.push(`sepia(${(warmth * 0.35).toFixed(3)})`, `saturate(${(1 + warmth * 0.25).toFixed(3)})`);
  const hue = (grade.hue ?? 0) + (warmth < 0 ? warmth * -12 : warmth * -4);
  if (hue) parts.push(`hue-rotate(${hue.toFixed(1)}deg)`);
  return parts.length ? parts.join(" ") : undefined;
}

function VideoClipView({ clip, trackMuted, gain }: { clip: VideoClip; trackMuted: boolean; gain: number }) {
  const style = useClipStyle(clip);
  return (
    <div style={{ ...boxStyle(clip.box), ...style, overflow: "hidden" }}>
      <Video
        src={asset(clip.src)}
        trimBefore={clip.trimStart && clip.trimStart > 0 ? clip.trimStart : undefined}
        volume={(clip.volume ?? 1) * gain}
        muted={trackMuted || clip.muted}
        playbackRate={clip.playbackRate}
        style={{ width: "100%", height: "100%", objectFit: clip.fit ?? "cover", filter: gradeFilter(clip.grade) }}
      />
    </div>
  );
}

function TextClipView({ clip, ctx }: { clip: TextClip; ctx: StudioRuntimeContextValue }) {
  const style = useClipStyle(clip);
  const s = clip.style ?? {};
  const align = s.align ?? "center";
  return (
    <div
      style={{
        ...boxStyle(clip.box ?? { x: 0.05, y: 0.4, width: 0.9, height: 0.2 }),
        ...style,
        display: "flex",
        alignItems: "center",
        justifyContent: align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center",
      }}
    >
      <div
        style={{
          fontFamily: s.fontFamily ? `"${s.fontFamily}", sans-serif` : "sans-serif",
          fontSize: s.fontSize ?? Math.round(ctx.height * 0.07),
          fontWeight: s.fontWeight ?? 800,
          color: s.color ?? "#ffffff",
          textAlign: align,
          lineHeight: s.lineHeight ?? 1.1,
          letterSpacing: s.letterSpacing,
          textTransform: s.textTransform,
          textShadow: s.shadow,
          whiteSpace: "pre-wrap",
          width: "100%",
        }}
      >
        {clip.text}
      </div>
    </div>
  );
}

function CaptionsClipView({ clip, ctx }: { clip: CaptionsClip; ctx: StudioRuntimeContextValue }) {
  const frame = useCurrentFrame();
  const style = useClipStyle(clip);
  const s = clip.style ?? {};
  const perLine = Math.max(1, s.maxWordsPerLine ?? 4);
  const words = clip.words;
  // Group words into lines of N; show the line containing the current (or last spoken) word.
  let current = -1;
  for (let i = 0; i < words.length; i += 1) {
    if (words[i].from <= frame) current = i;
    else break;
  }
  if (current < 0) return null;
  const lineStart = Math.floor(current / perLine) * perLine;
  const line = words.slice(lineStart, lineStart + perLine);
  const lastWord = line[line.length - 1];
  // Hide the line once its last word ended and the next line hasn't started (pause > 12 frames).
  const next = words[lineStart + perLine];
  if (frame > lastWord.to + 12 && (!next || next.from > frame)) return null;

  const fontSize = s.fontSize ?? Math.round(ctx.height * (ctx.height > ctx.width ? 0.045 : 0.06));
  const top = s.position === "top" ? "8%" : s.position === "center" ? "50%" : undefined;
  const bottom = s.position === "top" || s.position === "center" ? undefined : "10%";
  const preset = s.preset ?? "pop";
  return (
    <AbsoluteFill style={{ ...style, pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: "6%",
          right: "6%",
          top,
          bottom,
          transform: s.position === "center" ? "translateY(-50%)" : undefined,
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: `0 ${Math.round(fontSize * 0.28)}px`,
          fontFamily: s.fontFamily ? `"${s.fontFamily}", sans-serif` : "sans-serif",
          fontWeight: s.fontWeight ?? 900,
          fontSize,
          lineHeight: 1.15,
          textAlign: "center",
        }}
      >
        {line.map((word, i) => {
          const index = lineStart + i;
          const active = index === current && frame <= word.to + 2;
          const spoken = index <= current;
          let scale = 1;
          if (preset === "pop" && index === current) {
            scale = interpolate(frame, [word.from, word.from + 4, word.from + 8], [0.85, 1.12, 1], clamp);
          }
          const color =
            preset === "plain"
              ? (s.color ?? "#fff")
              : active || (preset === "karaoke" && spoken)
                ? (s.highlight ?? "#facc15")
                : (s.color ?? "#fff");
          return (
            <span
              key={`${index}-${word.text}`}
              style={{
                display: "inline-block",
                color,
                opacity: preset === "pop" && !spoken ? 0 : 1,
                transform: `scale(${scale})`,
                textShadow: "0 4px 18px rgba(0,0,0,0.55)",
              }}
            >
              {word.text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

function AudioClipView({ clip, trackMuted, gain }: { clip: AudioClip; trackMuted: boolean; gain: number }) {
  const base = (clip.volume ?? 1) * gain;
  const fadeIn = Math.max(0, clip.fadeIn ?? 0);
  const fadeOut = Math.max(0, clip.fadeOut ?? 0);
  const duration = clip.duration;
  return (
    <Audio
      src={asset(clip.src)}
      trimBefore={clip.trimStart && clip.trimStart > 0 ? clip.trimStart : undefined}
      muted={trackMuted}
      loop={clip.loop}
      playbackRate={clip.playbackRate}
      volume={
        fadeIn || fadeOut
          ? (f: number) => {
              const a = fadeIn ? interpolate(f, [0, fadeIn], [0, 1], clamp) : 1;
              const b = fadeOut ? interpolate(f, [duration - fadeOut, duration], [1, 0], clamp) : 1;
              return base * a * b;
            }
          : base
      }
    />
  );
}

const PREMOUNT_SECONDS = 1;

function TrackView({
  track,
  scenes,
  ctx,
  masterGain,
}: {
  track: StudioTrack;
  scenes: SceneRegistry;
  ctx: StudioRuntimeContextValue;
  masterGain: number;
}) {
  const visual = track.kind !== "audio";
  const { isRendering } = useRemotionEnvironment();
  if (visual && track.hidden) return null;
  const gain = (track.volume ?? 1) * masterGain;
  const trackMuted = Boolean(track.muted);
  return (
    <>
      {(track.clips as StudioClip[]).map((raw) => {
        const clip = resolveClip(raw, ctx.variant);
        if (clip.duration <= 0) return null;
        let body: ReactNode = null;
        switch (track.kind) {
          case "scene":
            body = <SceneClipView clip={clip as SceneClip} scenes={scenes} ctx={ctx} />;
            break;
          case "image":
            body = <ImageClipView clip={clip as ImageClip} />;
            break;
          case "video":
            body = <VideoClipView clip={clip as VideoClip} trackMuted={trackMuted} gain={gain} />;
            break;
          case "text":
            body = <TextClipView clip={clip as TextClip} ctx={ctx} />;
            break;
          case "captions":
            body = <CaptionsClipView clip={clip as CaptionsClip} ctx={ctx} />;
            break;
          case "audio":
            body = <AudioClipView clip={clip as AudioClip} trackMuted={trackMuted} gain={gain} />;
            break;
        }
        const premountFor = clip.from > 0 ? Math.round(ctx.fps * PREMOUNT_SECONDS) : undefined;
        const name = `${track.name} · ${clip.name ?? clip.id}`;
        if (!visual && !isRendering) {
          // Audio in the preview. Remotion only premounts a <Sequence> that has a layout box
          // (layout="none" silently skips premountFor), and an <Audio> that mounts on its start frame
          // pauses the player while it fetches and decodes the file, which is the hitch you feel on
          // every voice line, SFX and music cut. So give it an invisible box purely to enable premount.
          return (
            <Sequence
              key={clip.id}
              from={clip.from}
              durationInFrames={clip.duration}
              premountFor={premountFor}
              name={name}
              style={{ display: "none" }}
            >
              {body}
            </Sequence>
          );
        }
        return (
          <Sequence
            key={clip.id}
            from={clip.from}
            durationInFrames={clip.duration}
            // Mount each clip a moment early in the preview (hidden), so heavy scene setup
            // (WebGL, big DOM) and media buffering happen before the cut instead of on it.
            // No effect on captures or the export.
            premountFor={premountFor}
            name={name}
            layout={visual ? "absolute-fill" : "none"}
          >
            {body}
          </Sequence>
        );
      })}
    </>
  );
}

// Compositions render inside the ScreenSlick page (Player, captures, browser export). Its global CSS
// (Tailwind preflight: border-box everywhere, line-height 1.5, image rules…) must not leak in, or a
// project would lay out differently than in a plain Remotion render. Revert author styles inside the
// composition to browser defaults; inline styles (everything scenes set) still win.
// SVG content is excluded: its presentation attributes (fill, stroke…) lose to any CSS rule.
// Then Remotion's own page defaults (remotion/dist default-css: * { box-sizing: border-box }).
const ISOLATION_CSS = `.studio-composition, .studio-composition :not(svg, svg *) { all: revert; }
.studio-composition, .studio-composition :not(svg, svg *), .studio-composition svg, .studio-composition svg * { box-sizing: border-box; }
.studio-composition svg { display: inline; vertical-align: baseline; }`;

function useStyleIsolation() {
  if (typeof document === "undefined") return;
  if (document.getElementById("studio-composition-isolation")) return;
  const style = document.createElement("style");
  style.id = "studio-composition-isolation";
  style.textContent = ISOLATION_CSS;
  document.head.appendChild(style);
}

export function createStudioComposition(scenes: SceneRegistry) {
  function StudioComposition(props: StudioCompositionProps) {
    const { project, layers, variant, assetBase, libraryBase } = props;
    const size = project.variants[variant] ?? project.variants[project.defaultVariant] ?? {
      width: 1920,
      height: 1080,
    };
    setRuntimeState({ fps: project.fps, assetBase, libraryBase });
    useStyleIsolation();
    useProjectFonts(project.fonts ?? []);
    const ctx = useMemo<StudioRuntimeContextValue>(
      () => ({
        project,
        variant,
        width: size.width,
        height: size.height,
        fps: project.fps,
        assetBase,
        libraryBase,
      }),
      [project, variant, size.width, size.height, assetBase, libraryBase],
    );
    const masterGain = props.masterGain ?? 1;
    const ordered = [...layers.tracks].reverse();
    return (
      <StudioRuntimeContext.Provider value={ctx}>
        <AbsoluteFill
          className="studio-composition"
          style={{
            background: project.background || "#000",
            overflow: "hidden",
            // Same starting point as a bare Remotion page: browser default font, size, color, line height.
            font: "initial",
            color: "black",
            letterSpacing: "normal",
          }}
        >
          {ordered.map((track, index) => (
            <TrackView key={`${track.id}:${index}`} track={track} scenes={scenes} ctx={ctx} masterGain={masterGain} />
          ))}
        </AbsoluteFill>
      </StudioRuntimeContext.Provider>
    );
  }
  return StudioComposition;
}
