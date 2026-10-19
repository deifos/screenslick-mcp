// Metadata only (no React, no Remotion): safe for server components, the sitemap and metadata.
import type { ComponentMeta } from "./types";
import lightLeak from "./light-leak/meta.json";
import lowerThird from "./lower-third/meta.json";
import promptBox from "./prompt-box/meta.json";
import slideZoomMessage from "./slide-zoom-message/meta.json";
import statCounter from "./stat-counter/meta.json";
import textReveal from "./text-reveal/meta.json";

export const COMPONENT_METAS: Record<string, ComponentMeta> = {
  "text-reveal": textReveal as unknown as ComponentMeta,
  "slide-zoom-message": slideZoomMessage as unknown as ComponentMeta,
  "lower-third": lowerThird as unknown as ComponentMeta,
  "stat-counter": statCounter as unknown as ComponentMeta,
  "prompt-box": promptBox as unknown as ComponentMeta,
  "light-leak": lightLeak as unknown as ComponentMeta,
};
