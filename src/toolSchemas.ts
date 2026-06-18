import { z } from "zod";

const emptySchema = z.object({}).strict();
const jsonObjectSchema = z.record(z.unknown());
const optionalJsonObjectSchema = jsonObjectSchema.optional();
const cleanupSectionSchema = z.enum([
  "voiceover",
  "music",
  "text",
  "images",
  "zoom",
  "blur",
  "spotlight",
  "clipPosition",
  "freeze",
  "tapMarkers",
  "subtitles",
  "background",
  "cameraOverlay",
]);

const scriptClipSchema = z
  .object({
    text: z.string(),
    startMs: z.number().optional(),
    endMs: z.number().optional(),
    targetDurationMs: z.number().optional(),
    voice: z.string().optional(),
    speed: z.number().optional(),
    provider: z.enum(["local", "gemini"]).optional(),
    style: z
      .enum(["natural", "tutorial", "cheerful", "calm", "energetic", "dramatic"])
      .optional(),
    direction: z.string().optional(),
  })
  .strict();

export const passthroughToolSchemas = {
  screenslick_bridge_status: emptySchema,
  screenslick_get_project: emptySchema,
  screenslick_get_capabilities: emptySchema,
  screenslick_list_voices: emptySchema,
  screenslick_list_music: emptySchema,
  screenslick_list_sound_effects: emptySchema,
  screenslick_list_effects: emptySchema,
  screenslick_remove_silences: z
    .object({
      minDuration: z.number().optional(),
      dryRun: z.boolean().optional(),
      mode: z
        .enum(["aggressive", "default", "conservative", "long-pauses"])
        .optional(),
    })
    .strict(),
  screenslick_generate_transcript: z
    .object({
      language: z.string().optional(),
      modelSize: z.enum(["tiny", "base", "small"]).optional(),
      provider: z.enum(["local", "premium"]).optional(),
      enableSubtitles: z.boolean().optional(),
    })
    .strict(),
  screenslick_generate_script: z
    .object({
      mode: z.enum(["script", "improve"]).optional(),
      brief: z
        .object({
          videoType: z
            .enum(["demo", "tutorial", "walkthrough", "release", "sales"])
            .optional(),
          goal: z.string().optional(),
          audience: z.string().optional(),
          tone: z.string().optional(),
          notes: z.string().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  screenslick_generate_voiceover: z
    .object({
      source: z.enum(["transcript", "script"]).optional(),
      script: z.string().optional(),
      clips: z.array(scriptClipSchema).optional(),
      enable: z.boolean().optional(),
    })
    .strict(),
  screenslick_add_transcript_voiceover_to_timeline: z
    .object({
      source: z.enum(["transcript", "script"]).optional(),
      script: z.string().optional(),
      clips: z.array(scriptClipSchema).optional(),
    })
    .strict(),
  screenslick_clear_voiceover: emptySchema,
  screenslick_preview_voiceover: z
    .object({
      action: z.enum(["start", "stop"]).optional(),
    })
    .strict(),
  screenslick_toggle_voiceover: z
    .object({
      enabled: z.boolean().optional(),
    })
    .strict(),
  screenslick_cleanup_timeline: z
    .object({
      sections: z.array(cleanupSectionSchema).optional(),
      dryRun: z.boolean().optional(),
    })
    .strict(),
  screenslick_apply_commands: z
    .object({
      commands: z.array(jsonObjectSchema),
      dryRun: z.boolean().optional(),
      description: z.string().optional(),
    })
    .strict(),
  screenslick_capture_frame: z
    .object({
      time: z.number().optional(),
    })
    .strict(),
  screenslick_export_video: z
    .object({
      settings: optionalJsonObjectSchema,
      watermark: z.boolean().optional(),
    })
    .strict(),
};

export type ToolName = keyof typeof passthroughToolSchemas;

export const toolDescriptions: Record<ToolName, string> = {
  screenslick_bridge_status:
    "Check whether a ScreenSlick editor is connected to the local bridge.",
  screenslick_get_project: "Inspect the current ScreenSlick editor project.",
  screenslick_get_capabilities:
    "List ScreenSlick agent-editable commands, effect fields, animations, sound bindings, backgrounds, layouts, and workflow guidance.",
  screenslick_list_voices:
    "List ScreenSlick local and premium voiceover voices. Premium Gemini voices consume credits and require user confirmation.",
  screenslick_list_music: "List built-in ScreenSlick music tracks.",
  screenslick_list_sound_effects: "List built-in ScreenSlick sound effects.",
  screenslick_list_effects: "List agent-editable visual effect options.",
  screenslick_remove_silences:
    "Run the editor's silence removal feature on the current timeline.",
  screenslick_generate_transcript:
    "Run the editor's transcription/subtitle generation flow on the current video or timeline.",
  screenslick_generate_script:
    "Ask ScreenSlick's script assistant to write or improve a timed narration plan.",
  screenslick_generate_voiceover:
    "Generate a full voiceover track using ScreenSlick's native voiceover flow.",
  screenslick_add_transcript_voiceover_to_timeline:
    "Add transcript or agent-provided script voiceover clips to the timeline.",
  screenslick_clear_voiceover:
    "Clear generated voiceover audio and timeline voiceover clips before replacing narration.",
  screenslick_preview_voiceover:
    "Preview or stop the current generated ScreenSlick voiceover.",
  screenslick_toggle_voiceover:
    "Enable or disable the current generated ScreenSlick voiceover track.",
  screenslick_cleanup_timeline:
    "Clear selected editor timeline layers such as voiceover, music, text, effects, captions, background, and camera overlay without deleting source video clips.",
  screenslick_apply_commands:
    "Apply a batch of validated creative edit commands to the editor timeline. Call screenslick_get_capabilities first to learn the valid command shapes and effect fields.",
  screenslick_capture_frame:
    "Capture a Snap-style preview frame from the current editor. The local bridge saves large frame data to .tmp/agent-frames and returns filePath metadata.",
  screenslick_export_video:
    "Export the current editor project as an MP4 data URL.",
};

export const editorMethods: Partial<Record<ToolName, string>> = {
  screenslick_get_project: "get_project",
  screenslick_get_capabilities: "get_capabilities",
  screenslick_list_voices: "get_capabilities",
  screenslick_list_music: "list_music",
  screenslick_list_sound_effects: "list_sound_effects",
  screenslick_list_effects: "list_effects",
  screenslick_remove_silences: "remove_silences",
  screenslick_generate_transcript: "generate_transcript",
  screenslick_generate_script: "generate_script",
  screenslick_generate_voiceover: "generate_voiceover",
  screenslick_add_transcript_voiceover_to_timeline:
    "add_transcript_voiceover_to_timeline",
  screenslick_clear_voiceover: "clear_voiceover",
  screenslick_preview_voiceover: "preview_voiceover",
  screenslick_toggle_voiceover: "toggle_voiceover",
  screenslick_cleanup_timeline: "cleanup_timeline",
  screenslick_apply_commands: "apply_commands",
  screenslick_capture_frame: "capture_frame",
  screenslick_export_video: "export_video",
};
