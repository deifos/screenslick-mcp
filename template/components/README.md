# ScreenSlick motion components

Ready-made Remotion animations that people and Claude drop on the Motion Studio timeline and tune
through props, without writing a scene. The same code runs in the studio preview, the browser export,
a local render and the public gallery.

## How a component is used

In a project's `layers.json`, a scene-track clip names the component instead of a scene file:

```json
{ "id": "title", "from": 0, "duration": 90, "component": "text-reveal",
  "props": { "lines": ["Make videos", "with *Claude*"], "accent": "#34d399" } }
```

Props left out get their defaults. The inspector shows a form for them; Claude finds components with
`screenslick_studio_components`.

## Add a component

1. Make a folder: `motion/components/<id>/` (kebab-case id).
2. `<Name>.tsx`: a React component that takes `MotionBaseProps` (width, height, fps, durationInFrames,
   variant) plus its props. Rules:
   - Animate only from `useCurrentFrame()` (no timers, no `Math.random()` without a seed), so the
     preview, the export and every re-render match frame for frame.
   - Import only `react`, `remotion` and `../lib`. No CSS 3D (`perspective`, `preserve-3d`),
     `backdrop-filter`, `mix-blend-mode` or inset shadows: the browser export can't draw them.
   - Size everything from `unit(width, height)` so it works in wide (16:9) and mobile (9:16).
   - Fit any clip length: enter at the start, use `exitOut()` for the end.
   - `layer: "overlay"` components keep a transparent background unless a `background` prop is set.
3. `meta.json`: id, name, category, description, `useWhen` (when Claude should pick it), a good
   `durationInFrames`, tags, `props` (each with type, label, default and limits) and 2–3 `examples`.
4. Register it: its meta in `catalog.ts` and its component in `COMPONENTS` in `index.ts`.
5. Check it: open the gallery (`/motion/components`) and look at it in wide and mobile, then
   `npm run verify:components` (registration, defaults and examples).

The helper gets a copy of this folder for local renders and for Claude to read
(`npm run sync:skill` in screenslick-mcp copies the skill and the components).
