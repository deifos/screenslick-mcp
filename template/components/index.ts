// The registry. Add a component: create its folder (Component.tsx + meta.json), add its meta to
// catalog.ts and its component to COMPONENTS below. The studio preview, the browser export, the
// gallery, the inspector form and Claude's catalog all read from here.
import type { ComponentType } from "react";
import type { MotionBaseProps, MotionComponent, PropValues } from "./types";

import { COMPONENT_METAS } from "./catalog";
import { LightLeakTransition } from "./light-leak/LightLeakTransition";
import { LowerThird } from "./lower-third/LowerThird";
import { PromptBox } from "./prompt-box/PromptBox";
import { SlideZoomMessage } from "./slide-zoom-message/SlideZoomMessage";
import { StatCounter } from "./stat-counter/StatCounter";
import { TextReveal } from "./text-reveal/TextReveal";

type AnyComponent = ComponentType<MotionBaseProps & PropValues>;
const COMPONENTS: Record<string, unknown> = {
  "text-reveal": TextReveal,
  "slide-zoom-message": SlideZoomMessage,
  "lower-third": LowerThird,
  "stat-counter": StatCounter,
  "prompt-box": PromptBox,
  "light-leak": LightLeakTransition,
};

export const MOTION_COMPONENTS: Record<string, MotionComponent> = Object.fromEntries(
  Object.entries(COMPONENT_METAS).map(([id, meta]) => [
    id,
    { meta, Component: COMPONENTS[id] as AnyComponent },
  ]),
);

export const COMPONENT_CATEGORIES = [
  "Text & Titles",
  "Overlays",
  "Charts & Stats",
  "AI & Product",
  "Backgrounds",
  "Transitions",
] as const;

export { checkComponentProps, resolveComponentProps } from "./props";

export { COMPONENT_METAS } from "./catalog";
export type { ComponentMeta, MotionBaseProps, MotionComponent, PropSpec, PropValues } from "./types";
