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
      .enum([
        "natural",
        "tutorial",
        "cheerful",
        "calm",
        "energetic",
        "dramatic",
      ])
      .optional(),
    direction: z.string().optional(),
  })
  .strict();

const normalizedCropRegionSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .strict();

const onScreenCaptionOcrReadingSchema = z
  .object({
    text: z.string(),
    time: z.number().optional(),
    timeMs: z.number().optional(),
    sourceTime: z.number().optional(),
    confidence: z.number().optional(),
    sampleIndex: z.number().optional(),
  })
  .strict();

const onScreenCaptionMergeOptionsSchema = z
  .object({
    minConfidence: z.number().optional(),
    mergeGapMs: z.number().optional(),
    minDurationMs: z.number().optional(),
    defaultDurationMs: z.number().optional(),
  })
  .strict();

export const passthroughToolSchemas = {
  screenslick_bridge_status: emptySchema,
  screenslick_health_check: z
    .object({
      includeProject: z.boolean().optional(),
    })
    .strict(),
  screenslick_get_project: emptySchema,
  screenslick_analyze_timeline: emptySchema,
  screenslick_review_director_draft: z
    .object({
      prompt: z.string().optional(),
      stage: z.enum(["preflight", "post_edit", "final"]).optional(),
      targetFormat: z
        .enum(["landscape", "portrait", "square", "shorts", "auto"])
        .optional(),
    })
    .strict(),
  screenslick_validate_voiceover_timing: z
    .object({
      maxGapMs: z.number().optional(),
      minGapMs: z.number().optional(),
      allowOverlapMs: z.number().optional(),
    })
    .strict(),
  screenslick_find_clip_candidates: z
    .object({
      targetDurationSeconds: z.number().optional(),
      maxCandidates: z.number().optional(),
      format: z.enum(["shorts", "landscape", "square", "auto"]).optional(),
      goal: z.string().optional(),
    })
    .strict(),
  screenslick_analyze_video_segments: z
    .object({
      windowSeconds: z.number().optional(),
      stepSeconds: z.number().optional(),
      maxSegments: z.number().optional(),
    })
    .strict(),
  screenslick_create_clip_collection: z
    .object({
      candidates: z
        .array(
          z
            .object({
              startMs: z.number(),
              endMs: z.number(),
              title: z.string().optional(),
              reason: z.string().optional(),
            })
            .strict(),
        )
        .optional(),
      maxClips: z.number().optional(),
      label: z.string().optional(),
    })
    .strict(),
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
  screenslick_director_plan: z
    .object({
      prompt: z.string(),
      audience: z.string().optional(),
      format: z
        .enum(["landscape", "portrait", "square", "shorts", "auto"])
        .optional(),
      tone: z.string().optional(),
      targetDurationSeconds: z.number().optional(),
      includePremiumVoiceover: z.boolean().optional(),
      includeCaptions: z.boolean().optional(),
      includeMusic: z.boolean().optional(),
      allowSilenceRemoval: z.boolean().optional(),
      needsOnScreenCaptionOcr: z.boolean().optional(),
    })
    .strict(),
  screenslick_create_demo_video: z
    .object({
      prompt: z.string(),
      title: z.string().optional(),
      outroText: z.string().optional(),
      format: z
        .enum(["landscape", "portrait", "square", "shorts", "auto"])
        .optional(),
      dryRun: z.boolean().optional(),
      allowSilenceRemoval: z.boolean().optional(),
      silenceMode: z
        .enum(["aggressive", "default", "conservative", "long-pauses"])
        .optional(),
      includeCaptions: z.boolean().optional(),
      transcriptLanguage: z.string().optional(),
      transcriptModelSize: z.enum(["tiny", "base", "small"]).optional(),
      includeVoiceover: z.boolean().optional(),
      includePremiumVoiceover: z.boolean().optional(),
      voiceoverScript: z.string().optional(),
      voiceoverProvider: z.enum(["local", "gemini"]).optional(),
      voiceoverVoice: z.string().optional(),
      voiceoverSpeed: z.number().optional(),
      voiceoverStyle: z
        .enum([
          "natural",
          "tutorial",
          "cheerful",
          "calm",
          "energetic",
          "dramatic",
        ])
        .optional(),
      voiceoverDirection: z.string().optional(),
      premiumConfirmed: z.boolean().optional(),
      includeMusic: z.boolean().optional(),
      includeIntroOutro: z.boolean().optional(),
      includeBackground: z.boolean().optional(),
      includeCameraLayout: z.boolean().optional(),
      includeMotion: z.boolean().optional(),
      includeReview: z.boolean().optional(),
      musicTrackId: z.string().optional(),
      backgroundId: z.string().optional(),
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
  screenslick_replace_voiceover_clips: z
    .object({
      clips: z.array(scriptClipSchema),
      enable: z.boolean().optional(),
    })
    .strict(),
  screenslick_update_voiceover_clip: z
    .object({
      id: z.string(),
      text: z.string().optional(),
      regenerate: z.boolean().optional(),
    })
    .strict(),
  screenslick_move_voiceover_clip: z
    .object({
      id: z.string(),
      videoTimeMs: z.number().optional(),
      startMs: z.number().optional(),
    })
    .strict(),
  screenslick_delete_voiceover_clip: z
    .object({
      id: z.string(),
    })
    .strict(),
  screenslick_regenerate_voiceover_clip: z
    .object({
      id: z.string(),
      text: z.string().optional(),
    })
    .strict(),
  screenslick_extract_on_screen_captions: z
    .object({
      startTime: z.number().optional(),
      endTime: z.number().optional(),
      intervalMs: z.number().optional(),
      maxSamples: z.number().optional(),
      cropRegion: normalizedCropRegionSchema.optional(),
      includeFullFrame: z.boolean().optional(),
    })
    .strict(),
  screenslick_merge_on_screen_caption_ocr: z
    .object({
      readings: z.array(onScreenCaptionOcrReadingSchema),
      options: onScreenCaptionMergeOptionsSchema.optional(),
    })
    .strict(),
  screenslick_create_voiceover_from_on_screen_captions: z
    .object({
      readings: z.array(onScreenCaptionOcrReadingSchema),
      options: onScreenCaptionMergeOptionsSchema.optional(),
      provider: z.enum(["local", "gemini"]).optional(),
      voice: z.string().optional(),
      speed: z.number().optional(),
      style: z
        .enum([
          "natural",
          "tutorial",
          "cheerful",
          "calm",
          "energetic",
          "dramatic",
        ])
        .optional(),
      direction: z.string().optional(),
      enable: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      premiumConfirmed: z.boolean().optional(),
    })
    .strict(),
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
  screenslick_health_check:
    "Run a ScreenSlick MCP health check: server version, bridge configuration, editor connection, loaded project, and suggested recovery steps.",
  screenslick_get_project: "Inspect the current ScreenSlick editor project.",
  screenslick_analyze_timeline:
    "Return a compact agent-friendly summary of the current timeline, layers, voiceover/caption/music state, and likely issues.",
  screenslick_review_director_draft:
    "Review the current project with ScreenSlick director taste rules: intro/outro placement, caption/narration readiness, music/SFX fit, visual polish, and final QA next steps. Does not mutate the editor.",
  screenslick_validate_voiceover_timing:
    "Inspect timeline voiceover clips for overlaps, long gaps, duplicates, missing audio durations, and disabled playback.",
  screenslick_find_clip_candidates:
    "Find promising short-form or demo clip ranges from the current timeline using narration/subtitle density and timeline structure.",
  screenslick_analyze_video_segments:
    "Return scored timeline windows that summarize narration/subtitle density, coverage, and likely edit opportunities.",
  screenslick_create_clip_collection:
    "Normalize selected candidate ranges into a reviewable clip collection for agents to use before slicing/exporting.",
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
  screenslick_director_plan:
    "Create a planning-first Director Mode edit plan from the current ScreenSlick project and a broad creative prompt. Does not mutate the editor.",
  screenslick_create_demo_video:
    "Create or dry-run a safe Director Mode first-draft demo edit with editor-native silence removal, local captions, local or confirmed-premium voiceover, intro/outro text, camera layout polish, canvas styling, optional music, subtle motion, and automatic director review.",
  screenslick_generate_voiceover:
    "Generate a full voiceover track using ScreenSlick's native voiceover flow.",
  screenslick_add_transcript_voiceover_to_timeline:
    "Add transcript or agent-provided script voiceover clips to the timeline.",
  screenslick_clear_voiceover:
    "Clear generated voiceover audio and timeline voiceover clips before replacing narration.",
  screenslick_replace_voiceover_clips:
    "Replace all timeline voiceover clips with a supplied timed clip list. Use after cleanup or when rebuilding narration from extracted on-screen captions.",
  screenslick_update_voiceover_clip:
    "Update a single timeline voiceover clip's text, optionally regenerating its audio.",
  screenslick_move_voiceover_clip:
    "Move one timeline voiceover clip to a new time in milliseconds. The editor may snap it to avoid overlaps.",
  screenslick_delete_voiceover_clip:
    "Delete one timeline voiceover clip by id.",
  screenslick_regenerate_voiceover_clip:
    "Regenerate one timeline voiceover clip with its saved voice, provider, speed, and expression settings.",
  screenslick_extract_on_screen_captions:
    "Sample timestamped preview frames, cropped to the likely on-screen caption area by default, so a vision/OCR-capable agent can extract baked-in caption text and rebuild timed narration.",
  screenslick_merge_on_screen_caption_ocr:
    "Merge OCR/vision readings from sampled baked-in captions into deduped timed text clips without changing the editor.",
  screenslick_create_voiceover_from_on_screen_captions:
    "Merge OCR/vision readings from baked-in captions, then replace timeline voiceover clips with generated narration. Use dryRun=true first for review.",
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
  screenslick_replace_voiceover_clips: "replace_voiceover_clips",
  screenslick_update_voiceover_clip: "update_voiceover_clip",
  screenslick_move_voiceover_clip: "move_voiceover_clip",
  screenslick_delete_voiceover_clip: "delete_voiceover_clip",
  screenslick_regenerate_voiceover_clip: "regenerate_voiceover_clip",
  screenslick_extract_on_screen_captions: "extract_on_screen_captions",
  screenslick_preview_voiceover: "preview_voiceover",
  screenslick_toggle_voiceover: "toggle_voiceover",
  screenslick_cleanup_timeline: "cleanup_timeline",
  screenslick_apply_commands: "apply_commands",
  screenslick_capture_frame: "capture_frame",
  screenslick_export_video: "export_video",
};
