#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  callEditor,
  ensureBridge,
  getBridgeStatus,
  persistAgentFrameResult,
} from "./bridge.js";
import { getConfig, PACKAGE_VERSION } from "./config.js";
import { debugLog } from "./log.js";
import {
  editorMethods,
  passthroughToolSchemas,
  toolDescriptions,
  type ToolName,
} from "./toolSchemas.js";

const EXPECTED_EDITOR_AGENT_PROTOCOL_VERSION = 1;

// get_project is a lightweight snapshot read. Bound it well under the 120s
// editor-call ceiling so a dead/unresponsive editor fails fast instead of
// stacking multiple full-length timeouts across a single director tool call.
const PROJECT_READ_TIMEOUT_MS = 20_000;

function getProject() {
  return callEditor("get_project", {}, { timeoutMs: PROJECT_READ_TIMEOUT_MS });
}

function textContent(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getPath(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

function normalizeText(value: unknown) {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").toLowerCase()
    : "";
}

function normalizeCaptionText(value: unknown) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function getNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getReadingTimeMs(reading: Record<string, unknown>) {
  const explicitMs = getNumber(reading.timeMs);
  if (explicitMs !== null) return Math.max(0, Math.round(explicitMs));

  const seconds = getNumber(reading.time);
  if (seconds !== null) return Math.max(0, Math.round(seconds * 1000));

  const sourceSeconds = getNumber(reading.sourceTime);
  if (sourceSeconds !== null) {
    return Math.max(0, Math.round(sourceSeconds * 1000));
  }

  return null;
}

function getMergeOptions(args: unknown) {
  const options = asRecord(asRecord(args)?.options) ?? {};
  return {
    minConfidence: getNumber(options.minConfidence) ?? 0,
    mergeGapMs: getNumber(options.mergeGapMs) ?? 1500,
    minDurationMs: getNumber(options.minDurationMs) ?? 900,
    defaultDurationMs: getNumber(options.defaultDurationMs) ?? 1800,
  };
}

function mergeOnScreenCaptionOcr(args: unknown) {
  const readingsInput = asArray(asRecord(args)?.readings);
  const options = getMergeOptions(args);
  const discarded: Array<{ reason: string; reading: unknown }> = [];

  const readings = readingsInput
    .map((reading, index) => {
      const record = asRecord(reading);
      if (!record) {
        discarded.push({ reason: "not_an_object", reading });
        return null;
      }
      const text = normalizeCaptionText(record.text);
      if (!text) {
        discarded.push({ reason: "empty_text", reading });
        return null;
      }
      const confidence = getNumber(record.confidence);
      if (confidence !== null && confidence < options.minConfidence) {
        discarded.push({ reason: "low_confidence", reading });
        return null;
      }
      const timeMs = getReadingTimeMs(record);
      if (timeMs === null) {
        discarded.push({ reason: "missing_time", reading });
        return null;
      }
      return {
        text,
        normalizedText: normalizeText(text),
        timeMs,
        confidence,
        sampleIndex: getNumber(record.sampleIndex) ?? index,
      };
    })
    .filter(
      (
        reading,
      ): reading is {
        text: string;
        normalizedText: string;
        timeMs: number;
        confidence: number | null;
        sampleIndex: number;
      } => Boolean(reading),
    )
    .sort((a, b) => a.timeMs - b.timeMs || a.sampleIndex - b.sampleIndex);

  const clips: Array<{
    text: string;
    startMs: number;
    endMs: number;
    targetDurationMs: number;
    confidence: number | null;
    sourceFrameTimesMs: number[];
    sampleIndexes: number[];
  }> = [];

  for (const reading of readings) {
    const previous = clips.at(-1);
    if (
      previous &&
      normalizeText(previous.text) === reading.normalizedText &&
      reading.timeMs - previous.endMs <= options.mergeGapMs
    ) {
      previous.endMs = Math.max(previous.endMs, reading.timeMs);
      previous.targetDurationMs = Math.max(
        options.minDurationMs,
        previous.endMs - previous.startMs,
      );
      previous.sourceFrameTimesMs.push(reading.timeMs);
      previous.sampleIndexes.push(reading.sampleIndex);
      previous.confidence =
        previous.confidence === null || reading.confidence === null
          ? (previous.confidence ?? reading.confidence)
          : Math.max(previous.confidence, reading.confidence);
      continue;
    }

    clips.push({
      text: reading.text,
      startMs: reading.timeMs,
      endMs: reading.timeMs + options.defaultDurationMs,
      targetDurationMs: options.defaultDurationMs,
      confidence: reading.confidence,
      sourceFrameTimesMs: [reading.timeMs],
      sampleIndexes: [reading.sampleIndex],
    });
  }

  for (let index = 0; index < clips.length; index += 1) {
    const current = clips[index];
    const next = clips[index + 1];
    if (next) {
      current.endMs = Math.max(
        current.startMs + options.minDurationMs,
        Math.min(current.endMs, next.startMs),
      );
    } else {
      current.endMs = Math.max(
        current.endMs,
        current.startMs + options.minDurationMs,
      );
    }
    current.targetDurationMs = Math.max(
      options.minDurationMs,
      current.endMs - current.startMs,
    );
  }

  return {
    clips,
    discarded,
    options,
    summary: {
      readings: readingsInput.length,
      usableReadings: readings.length,
      clips: clips.length,
      discarded: discarded.length,
    },
  };
}

function summarizeVoiceoverIssues(clips: unknown[], voiceoverStatus: unknown) {
  const issues: string[] = [];
  const status = asRecord(voiceoverStatus);
  if (clips.length > 0 && status?.enabled === false) {
    issues.push("Voiceover clips exist but voiceover playback is disabled.");
  }

  const seen = new Map<string, number>();
  for (const clip of clips) {
    const text = normalizeText(asRecord(clip)?.text);
    if (!text) continue;
    seen.set(text, (seen.get(text) ?? 0) + 1);
  }
  const duplicateCount = [...seen.values()].filter((count) => count > 1).length;
  if (duplicateCount > 0) {
    issues.push(`${duplicateCount} duplicated voiceover line(s) detected.`);
  }

  const sorted = clips
    .map((clip) => {
      const record = asRecord(clip);
      return {
        text: typeof record?.text === "string" ? record.text : "",
        startMs:
          typeof record?.videoTimeMs === "number" ? record.videoTimeMs : null,
        durationMs:
          typeof record?.durationMs === "number" ? record.durationMs : null,
      };
    })
    .filter(
      (
        clip,
      ): clip is {
        text: string;
        startMs: number;
        durationMs: number | null;
      } => clip.startMs !== null,
    )
    .sort((a, b) => a.startMs - b.startMs);

  const gaps = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const previousEnd = previous.startMs + (previous.durationMs ?? 0);
    const gapMs = current.startMs - previousEnd;
    if (gapMs > 10_000) {
      gaps.push({
        fromMs: previousEnd,
        toMs: current.startMs,
        gapMs,
        before: previous.text,
        after: current.text,
      });
    }
  }
  if (gaps.length > 0) {
    issues.push(`${gaps.length} large voiceover gap(s) over 10 seconds.`);
  }

  return { issues, gaps: gaps.slice(0, 8) };
}

function getDurationMsFromProject(project: unknown) {
  const seconds =
    getNumber(getPath(project, ["timelineDuration"])) ??
    getNumber(getPath(project, ["preset", "videoDuration"]));
  return seconds === null ? 0 : Math.max(0, Math.round(seconds * 1000));
}

function getVoiceoverClipItems(project: unknown) {
  return asArray(getPath(project, ["preset", "voiceover", "clips"]))
    .map((clip) => {
      const record = asRecord(clip) ?? {};
      const startMs = getNumber(record.videoTimeMs);
      const durationMs = getNumber(record.durationMs);
      return {
        id: typeof record.id === "string" ? record.id : "",
        text: typeof record.text === "string" ? record.text : "",
        voice: typeof record.voice === "string" ? record.voice : null,
        provider: typeof record.provider === "string" ? record.provider : null,
        speed: getNumber(record.speed),
        startMs,
        durationMs,
        endMs:
          startMs === null
            ? null
            : startMs +
              Math.max(0, durationMs ?? estimateSpeechDurationMs(record.text)),
      };
    })
    .filter(
      (
        clip,
      ): clip is {
        id: string;
        text: string;
        voice: string | null;
        provider: string | null;
        speed: number | null;
        startMs: number;
        durationMs: number | null;
        endMs: number;
      } => clip.startMs !== null && clip.endMs !== null,
    )
    .sort((a, b) => a.startMs - b.startMs);
}

function getSubtitleItems(project: unknown) {
  return asArray(getPath(project, ["preset", "subtitles", "segments"]))
    .map((segment) => {
      const record = asRecord(segment) ?? {};
      const start = getNumber(record.start);
      const end = getNumber(record.end);
      return {
        text:
          typeof record.message === "string"
            ? record.message
            : typeof record.text === "string"
              ? record.text
              : "",
        startMs: start,
        endMs: end,
      };
    })
    .filter(
      (
        item,
      ): item is {
        text: string;
        startMs: number;
        endMs: number;
      } => item.startMs !== null && item.endMs !== null,
    )
    .sort((a, b) => a.startMs - b.startMs);
}

function estimateSpeechDurationMs(text: unknown) {
  const wordCount =
    typeof text === "string" && text.trim()
      ? text.trim().split(/\s+/).length
      : 4;
  return Math.max(900, Math.round((wordCount / 2.7) * 1000));
}

function validateVoiceoverTiming(project: unknown, args: unknown) {
  const input = asRecord(args) ?? {};
  const maxGapMs = getNumber(input.maxGapMs) ?? 10_000;
  const minGapMs = getNumber(input.minGapMs) ?? 0;
  const allowOverlapMs = getNumber(input.allowOverlapMs) ?? 150;
  const clips = getVoiceoverClipItems(project);
  const status = asRecord(getPath(project, ["voiceover"])) ?? {};
  const issues: Array<{
    severity: "info" | "warning" | "error";
    type: string;
    message: string;
    clipIds?: string[];
    startMs?: number;
    endMs?: number;
  }> = [];

  if (clips.length > 0 && status.enabled === false) {
    issues.push({
      severity: "error",
      type: "voiceover-disabled",
      message: "Voiceover clips exist but voiceover playback is disabled.",
    });
  }

  const seenText = new Map<string, string>();
  for (const clip of clips) {
    if (!clip.durationMs || clip.durationMs <= 0) {
      issues.push({
        severity: "warning",
        type: "missing-duration",
        message: "Voiceover clip is missing a generated audio duration.",
        clipIds: [clip.id],
        startMs: clip.startMs,
      });
    }
    const key = normalizeText(clip.text);
    if (key && seenText.has(key)) {
      issues.push({
        severity: "warning",
        type: "duplicate-text",
        message: "Two voiceover clips use the same text.",
        clipIds: [seenText.get(key)!, clip.id],
        startMs: clip.startMs,
      });
    } else if (key) {
      seenText.set(key, clip.id);
    }
  }

  const gaps = [];
  const overlaps = [];
  for (let index = 1; index < clips.length; index += 1) {
    const previous = clips[index - 1];
    const current = clips[index];
    const gapMs = current.startMs - previous.endMs;
    if (gapMs < -allowOverlapMs) {
      const overlapMs = Math.abs(gapMs);
      overlaps.push({ previous, current, overlapMs });
      issues.push({
        severity: "error",
        type: "overlap",
        message: `Voiceover clips overlap by ${overlapMs}ms.`,
        clipIds: [previous.id, current.id],
        startMs: current.startMs,
        endMs: previous.endMs,
      });
    } else if (gapMs > maxGapMs) {
      gaps.push({ previous, current, gapMs });
      issues.push({
        severity: "warning",
        type: "long-gap",
        message: `Voiceover gap is ${gapMs}ms.`,
        clipIds: [previous.id, current.id],
        startMs: previous.endMs,
        endMs: current.startMs,
      });
    } else if (gapMs < minGapMs) {
      issues.push({
        severity: "info",
        type: "tight-gap",
        message: `Voiceover gap is tighter than ${minGapMs}ms.`,
        clipIds: [previous.id, current.id],
        startMs: previous.endMs,
        endMs: current.startMs,
      });
    }
  }

  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    clipCount: clips.length,
    enabled: status.enabled,
    thresholds: { maxGapMs, minGapMs, allowOverlapMs },
    issues,
    summary: {
      errors: issues.filter((issue) => issue.severity === "error").length,
      warnings: issues.filter((issue) => issue.severity === "warning").length,
      info: issues.filter((issue) => issue.severity === "info").length,
      longGaps: gaps.length,
      overlaps: overlaps.length,
    },
  };
}

function getNarrativeItems(project: unknown) {
  const voiceover = getVoiceoverClipItems(project).map((clip) => ({
    source: "voiceover" as const,
    text: clip.text,
    startMs: clip.startMs,
    endMs: clip.endMs,
  }));
  if (voiceover.length > 0) return voiceover;
  return getSubtitleItems(project).map((subtitle) => ({
    source: "subtitle" as const,
    text: subtitle.text,
    startMs: subtitle.startMs,
    endMs: subtitle.endMs,
  }));
}

function scoreSegmentWindow(
  items: Array<{ text: string; startMs: number; endMs: number }>,
  startMs: number,
  endMs: number,
) {
  const overlapping = items.filter(
    (item) => item.endMs > startMs && item.startMs < endMs,
  );
  const words = overlapping.reduce(
    (total, item) =>
      total + item.text.trim().split(/\s+/).filter(Boolean).length,
    0,
  );
  const coverageMs = overlapping.reduce(
    (total, item) =>
      total +
      Math.max(
        0,
        Math.min(endMs, item.endMs) - Math.max(startMs, item.startMs),
      ),
    0,
  );
  const durationMs = Math.max(1, endMs - startMs);
  const density = words / (durationMs / 1000);
  const coverage = Math.min(1, coverageMs / durationMs);
  return {
    score:
      Math.round((density * 8 + coverage * 40 + overlapping.length * 2) * 10) /
      10,
    words,
    coverage,
    itemCount: overlapping.length,
    previewText: overlapping
      .slice(0, 3)
      .map((item) => item.text)
      .join(" ")
      .slice(0, 220),
  };
}

function analyzeVideoSegments(project: unknown, args: unknown) {
  const input = asRecord(args) ?? {};
  const durationMs = getDurationMsFromProject(project);
  const windowMs = Math.max(
    5_000,
    Math.round((getNumber(input.windowSeconds) ?? 30) * 1000),
  );
  const stepMs = Math.max(
    2_000,
    Math.round((getNumber(input.stepSeconds) ?? 10) * 1000),
  );
  const maxSegments = Math.max(
    1,
    Math.min(50, Math.round(getNumber(input.maxSegments) ?? 20)),
  );
  const items = getNarrativeItems(project);
  const segments = [];

  if (durationMs <= 0) {
    return {
      durationMs,
      source: "none",
      segments: [],
      message: "No timeline duration available.",
    };
  }

  for (let startMs = 0; startMs < durationMs; startMs += stepMs) {
    const endMs = Math.min(durationMs, startMs + windowMs);
    if (endMs - startMs < Math.min(5_000, windowMs)) break;
    const score = scoreSegmentWindow(items, startMs, endMs);
    segments.push({
      startMs,
      endMs,
      durationMs: endMs - startMs,
      ...score,
      reason:
        score.itemCount > 0
          ? "Narration/subtitle density suggests this range can stand alone."
          : "Low text density; use only if visuals are strong.",
    });
  }

  return {
    durationMs,
    source:
      getVoiceoverClipItems(project).length > 0 ? "voiceover" : "subtitles",
    windowMs,
    stepMs,
    segments: segments.sort((a, b) => b.score - a.score).slice(0, maxSegments),
  };
}

function findClipCandidates(project: unknown, args: unknown) {
  const input = asRecord(args) ?? {};
  const targetDurationSeconds = Math.max(
    8,
    Math.min(90, getNumber(input.targetDurationSeconds) ?? 35),
  );
  const maxCandidates = Math.max(
    1,
    Math.min(12, Math.round(getNumber(input.maxCandidates) ?? 5)),
  );
  const analysis = analyzeVideoSegments(project, {
    windowSeconds: targetDurationSeconds,
    stepSeconds: Math.max(5, targetDurationSeconds / 3),
    maxSegments: maxCandidates * 3,
  });
  const segments = asArray(asRecord(analysis)?.segments);
  const selected: unknown[] = [];

  for (const segment of segments) {
    const record = asRecord(segment) ?? {};
    const startMs = getNumber(record.startMs);
    const endMs = getNumber(record.endMs);
    if (startMs === null || endMs === null) continue;
    const overlapsExisting = selected.some((candidate) => {
      const existing = asRecord(candidate) ?? {};
      const existingStart = getNumber(existing.startMs) ?? 0;
      const existingEnd = getNumber(existing.endMs) ?? 0;
      return startMs < existingEnd && endMs > existingStart;
    });
    if (overlapsExisting) continue;
    selected.push({
      title: `Candidate ${selected.length + 1}`,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      score: record.score,
      reason: record.reason,
      previewText: record.previewText,
      suggestedFormat: input.format ?? "shorts",
    });
    if (selected.length >= maxCandidates) break;
  }

  return {
    goal:
      typeof input.goal === "string"
        ? input.goal
        : "Find strong standalone clips.",
    targetDurationSeconds,
    candidates: selected,
    sourceAnalysis: analysis,
  };
}

function createClipCollection(args: unknown) {
  const input = asRecord(args) ?? {};
  const maxClips = Math.max(
    1,
    Math.min(20, Math.round(getNumber(input.maxClips) ?? 6)),
  );
  const candidates = asArray(input.candidates)
    .map((candidate, index) => {
      const record = asRecord(candidate) ?? {};
      const startMs = getNumber(record.startMs);
      const endMs = getNumber(record.endMs);
      if (startMs === null || endMs === null || endMs <= startMs) return null;
      return {
        id: `clip_${index + 1}`,
        title:
          typeof record.title === "string" && record.title.trim()
            ? record.title.trim()
            : `Clip ${index + 1}`,
        startMs,
        endMs,
        durationMs: endMs - startMs,
        reason:
          typeof record.reason === "string"
            ? record.reason
            : "Selected by agent.",
      };
    })
    .filter(Boolean)
    .slice(0, maxClips);

  return {
    label:
      typeof input.label === "string" && input.label.trim()
        ? input.label.trim()
        : "ScreenSlick clip candidates",
    clips: candidates,
    note: "This is a review collection. Use ScreenSlick slicing/export tools after choosing which ranges to materialize.",
  };
}

function analyzeProject(project: unknown) {
  const preset = asRecord(getPath(project, ["preset"])) ?? {};
  const voiceoverClips = asArray(getPath(preset, ["voiceover", "clips"]));
  const musicClips = asArray(getPath(preset, ["music", "clips"]));
  const subtitleSegments = asArray(getPath(preset, ["subtitles", "segments"]));
  const textOverlays = asArray(getPath(preset, ["text", "overlays"]));
  const cameraOverlay = asRecord(getPath(preset, ["cameraOverlay"]));
  const timelineClips = asArray(getPath(preset, ["timelineClips"]));
  const sourceClips = asArray(getPath(project, ["clips"]));
  const assets = asArray(getPath(project, ["assets"]));
  const voiceoverStatus = getPath(project, ["voiceover"]);
  const voiceoverAnalysis = summarizeVoiceoverIssues(
    voiceoverClips,
    voiceoverStatus,
  );
  const voiceoverStatusRecord = asRecord(voiceoverStatus);
  const hiddenGeneratedVoiceover =
    voiceoverClips.length === 0 &&
    voiceoverStatusRecord?.hasGeneratedTrack === true &&
    (getNumber(voiceoverStatusRecord.timedSegmentCount) ?? 0) > 0;

  const issues = [...voiceoverAnalysis.issues];
  if (hiddenGeneratedVoiceover) {
    issues.push(
      "Generated full-track voiceover exists, but there are no editable timeline voiceover clips. Rebuild narration with timeline voiceover tools so the user can edit and regenerate it.",
    );
  }
  if (timelineClips.length === 0 && sourceClips.length === 0) {
    issues.push("No source timeline clips found.");
  }
  if (subtitleSegments.length === 0) {
    issues.push("No subtitle segments found.");
  }

  return {
    durationSeconds:
      typeof getPath(project, ["timelineDuration"]) === "number"
        ? getPath(project, ["timelineDuration"])
        : getPath(preset, ["videoDuration"]),
    hasVideo: Boolean(getPath(project, ["hasVideo"])),
    assets: assets.map((asset) => {
      const record = asRecord(asset) ?? {};
      return {
        filename: record.filename,
        duration: record.duration,
        hasAudio: record.hasAudio,
        width: record.width,
        height: record.height,
      };
    }),
    layers: {
      sourceClips: sourceClips.length || timelineClips.length,
      musicClips: musicClips.length,
      voiceoverClips: voiceoverClips.length,
      subtitleSegments: subtitleSegments.length,
      textOverlays: textOverlays.length,
      cameraOverlay: cameraOverlay ? 1 : 0,
      zoomKeyframes: asArray(getPath(preset, ["zoom", "keyframes"])).length,
      blurRegions: asArray(getPath(preset, ["blur", "regions"])).length,
      spotlightEffects: asArray(getPath(preset, ["spotlight", "effects"]))
        .length,
      clipPositionSegments: asArray(
        getPath(preset, ["clipPosition", "segments"]),
      ).length,
    },
    enabled: {
      subtitles: Boolean(getPath(preset, ["subtitles", "enabled"])),
      text: Boolean(getPath(preset, ["text", "enabled"])),
      cameraOverlay: Boolean(cameraOverlay && cameraOverlay.hidden !== true),
      zoom: Boolean(getPath(preset, ["zoom", "enabled"])),
      blur: Boolean(getPath(preset, ["blur", "enabled"])),
      spotlight: Boolean(getPath(preset, ["spotlight", "enabled"])),
      clipPosition: Boolean(getPath(preset, ["clipPosition", "enabled"])),
      voiceover: Boolean(getPath(project, ["voiceover", "enabled"])),
    },
    voiceover: {
      status: voiceoverStatus,
      mode:
        voiceoverClips.length > 0
          ? voiceoverStatusRecord?.hasGeneratedTrack === true
            ? "mixed"
            : "timeline-clips"
          : voiceoverStatusRecord?.hasGeneratedTrack === true
            ? "full-track"
            : "none",
      editable: voiceoverClips.length > 0,
      hiddenGeneratedTrack: hiddenGeneratedVoiceover,
      firstClips: voiceoverClips.slice(0, 8).map((clip) => {
        const record = asRecord(clip) ?? {};
        return {
          startMs: record.videoTimeMs,
          durationMs: record.durationMs,
          voice: record.voice,
          speed: record.speed,
          text: record.text,
        };
      }),
      largeGaps: voiceoverAnalysis.gaps,
    },
    cameraOverlay: cameraOverlay
      ? {
          layout: cameraOverlay.layout ?? null,
          hidden: cameraOverlay.hidden === true,
          opacity: cameraOverlay.opacity ?? null,
        }
      : null,
    issues,
  };
}

function getProjectTextOverlays(project: unknown) {
  return asArray(getPath(project, ["preset", "text", "overlays"]))
    .map((overlay) => {
      const record = asRecord(overlay) ?? {};
      const startSeconds =
        getNumber(record.startTime) ??
        getNumber(record.time) ??
        getNumber(record.videoTime) ??
        0;
      const durationSeconds =
        getNumber(record.duration) ??
        getNumber(record.endTime) ??
        getNumber(record.end) ??
        0;
      const updates = asRecord(record.updates) ?? record;
      return {
        id: typeof record.id === "string" ? record.id : "",
        text: typeof record.text === "string" ? record.text : "",
        startMs: Math.max(0, Math.round(startSeconds * 1000)),
        endMs: Math.max(
          0,
          Math.round((startSeconds + durationSeconds) * 1000),
        ),
        animation:
          typeof updates.animation === "string" ? updates.animation : null,
        soundEffect: asRecord(updates.soundEffect),
      };
    })
    .sort((a, b) => a.startMs - b.startMs);
}

function soundEffectMode(soundEffect: Record<string, unknown> | null, phase: string) {
  const phaseConfig = asRecord(soundEffect?.[phase]);
  return typeof phaseConfig?.effectId === "string"
    ? phaseConfig.effectId
    : typeof phaseConfig?.mode === "string"
      ? phaseConfig.mode
      : null;
}

function buildDirectorDraftReview(args: unknown, project: unknown) {
  const input = asRecord(args) ?? {};
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const stage = input.stage ?? "post_edit";
  const targetFormat = input.targetFormat ?? "auto";
  const analysis = analyzeProject(project);
  const analysisRecord = asRecord(analysis) ?? {};
  const layers = asRecord(analysisRecord.layers) ?? {};
  const enabled = asRecord(analysisRecord.enabled) ?? {};
  const durationSeconds = getNumber(analysisRecord.durationSeconds) ?? 0;
  const durationMs = Math.round(durationSeconds * 1000);
  const textOverlays = getProjectTextOverlays(project);
  const timing = validateVoiceoverTiming(project, {
    maxGapMs: 10_000,
    allowOverlapMs: 150,
  });
  const timingSummary = asRecord(timing.summary) ?? {};
  const findings: Array<{
    severity: "pass" | "info" | "warning" | "error";
    area: string;
    message: string;
    suggestion?: string;
  }> = [];

  const addFinding = (
    severity: "pass" | "info" | "warning" | "error",
    area: string,
    message: string,
    suggestion?: string,
  ) => findings.push({ severity, area, message, suggestion });

  if (!analysisRecord.hasVideo) {
    addFinding(
      "error",
      "project",
      "No loaded video was detected.",
      "Load a video in ScreenSlick before running Director Mode edits.",
    );
  } else {
    addFinding("pass", "project", "A video project is loaded.");
  }

  const introText = textOverlays.find((overlay) => overlay.startMs <= 1500);
  const outroText = textOverlays.find(
    (overlay) => durationMs > 0 && overlay.startMs >= Math.max(0, durationMs - 6000),
  );
  if (introText) {
    addFinding("pass", "structure", "Intro text appears near the beginning.");
  } else {
    addFinding(
      stage === "preflight" ? "info" : "warning",
      "structure",
      "No intro/title text was found near the beginning.",
      "Add a short title or hook in the first 1.5 seconds if the video needs orientation.",
    );
  }
  if (outroText || durationSeconds < 8) {
    addFinding(
      "pass",
      "structure",
      durationSeconds < 8
        ? "Outro is optional for very short clips."
        : "Outro/CTA text appears near the end.",
    );
  } else {
    addFinding(
      stage === "preflight" ? "info" : "warning",
      "structure",
      "No outro/CTA text was found near the end.",
      "Place exit text, launch URL, or CTA in the final 3-5 seconds rather than at the beginning.",
    );
  }

  const overlappingStartText = textOverlays.filter(
    (overlay) => overlay.startMs <= 1500,
  );
  if (overlappingStartText.length > 1 && !outroText) {
    addFinding(
      "warning",
      "structure",
      "Multiple text overlays start at the beginning, and no end CTA was detected.",
      "Avoid stacking unrelated intro and outro copy at the start; move CTA/outro copy to the end.",
    );
  }

  const mismatchedTypingSound = textOverlays.find((overlay) => {
    const animation = overlay.animation?.toLowerCase() ?? "";
    const entranceSound = soundEffectMode(overlay.soundEffect, "entrance")
      ?.toLowerCase()
      .trim();
    return (
      (animation.includes("scramble") || animation.includes("type")) &&
      entranceSound &&
      !/(type|typing|key|click|tick|clack)/.test(entranceSound)
    );
  });
  if (mismatchedTypingSound) {
    addFinding(
      "warning",
      "sound",
      "A typing/scramble text animation appears to use a non-typing entrance sound.",
      "Pair scramble/typewriter reveals with typing, click, tick, key, or clack SFX; reserve swooshes for spatial movement.",
    );
  } else if (textOverlays.length > 0) {
    addFinding("pass", "sound", "Text animation sounds look taste-compatible.");
  }

  const musicCount = getNumber(layers.musicClips) ?? 0;
  const voiceoverCount = getNumber(layers.voiceoverClips) ?? 0;
  if (musicCount > 0 && voiceoverCount > 0) {
    addFinding(
      "info",
      "sound",
      "Music and narration are both present.",
      "Keep music low or ducked under speech; for most demos, 0.10-0.20 volume is a good starting range.",
    );
  } else if (musicCount === 0 && promptIncludesAny(prompt, ["explosive", "hype", "music", "cinematic"])) {
    addFinding(
      "warning",
      "sound",
      "The prompt asks for high-energy sound, but no music clips were detected.",
      "Choose an energetic track and keep it below narration.",
    );
  }

  if (voiceoverCount > 0) {
    const errors = getNumber(timingSummary.errors) ?? 0;
    const warnings = getNumber(timingSummary.warnings) ?? 0;
    if (errors > 0 || warnings > 0) {
      addFinding(
        errors > 0 ? "error" : "warning",
        "voiceover",
        `Voiceover timing has ${errors} error(s) and ${warnings} warning(s).`,
        "Run screenslick_validate_voiceover_timing and fix overlaps, long gaps, duplicates, or missing generated durations.",
      );
    } else {
      addFinding("pass", "voiceover", "Voiceover timing passes the default review.");
    }
  } else if (promptIncludesAny(prompt, ["voice", "narration", "voiceover", "read"])) {
    addFinding(
      "warning",
      "voiceover",
      "The prompt asks for narration, but no timeline voiceover clips were detected.",
      "Use local voiceover for a free draft, or ask before premium Gemini voiceover because it consumes credits.",
    );
  }

  const subtitleSegments = getNumber(layers.subtitleSegments) ?? 0;
  if (subtitleSegments > 0 && enabled.subtitles !== false) {
    addFinding("pass", "captions", "Captions/subtitles are available.");
  } else {
    addFinding(
      stage === "preflight" ? "info" : "warning",
      "captions",
      "No enabled subtitle track was detected.",
      "Generate local transcript/subtitles unless the source already has baked-in captions.",
    );
  }

  const clipPositionSegments = getNumber(layers.clipPositionSegments) ?? 0;
  const zoomKeyframes = getNumber(layers.zoomKeyframes) ?? 0;
  const blurRegions = getNumber(layers.blurRegions) ?? 0;
  if (clipPositionSegments > 0 || zoomKeyframes > 0 || blurRegions > 0) {
    addFinding("pass", "visuals", "The timeline includes visual emphasis layers.");
  } else {
    addFinding(
      "info",
      "visuals",
      "No zoom, blur, or clip-position emphasis layers were detected.",
      "Add subtle motion, zoom, blur, spotlight, or padding/background only where it guides attention.",
    );
  }

  const blockers = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warning");
  return {
    ok: blockers.length === 0,
    stage,
    prompt: prompt || null,
    targetFormat,
    summary: {
      errors: blockers.length,
      warnings: warnings.length,
      passes: findings.filter((finding) => finding.severity === "pass").length,
      info: findings.filter((finding) => finding.severity === "info").length,
    },
    findings,
    recommendedNextTools: [
      "screenslick_analyze_timeline",
      "screenslick_validate_voiceover_timing",
      "screenslick_get_capabilities",
      "screenslick_capture_frame",
    ],
    tasteRules: [
      "Place intro/title text at the beginning and CTA/outro text near the end.",
      "Use typing/click/tick SFX for typewriter or scramble text; use swoosh/whoosh for spatial motion.",
      "Treat entrance and exit animations as separate beats with separate SFX choices.",
      "Keep captions readable and synchronized after silence removal.",
      "Duck music under narration and avoid SFX on every tiny edit.",
      "Ask before premium/Gemini voiceover because it consumes credits.",
    ],
    timeline: analysis,
  };
}

function promptIncludesAny(prompt: string, terms: string[]) {
  const normalized = prompt.toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function buildDirectorPlan(args: unknown, project: unknown) {
  const input = asRecord(args) ?? {};
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) {
    throw new Error("Provide a prompt for screenslick_director_plan.");
  }

  const analysis = analyzeProject(project);
  const analysisRecord = asRecord(analysis) ?? {};
  const durationSeconds = getNumber(analysisRecord.durationSeconds);
  const promptWantsPremium =
    input.includePremiumVoiceover === true ||
    promptIncludesAny(prompt, [
      "premium voice",
      "high end voice",
      "high-end voice",
      "expressive voice",
      "with expressions",
      "gemini",
    ]);
  const wantsShort =
    input.format === "shorts" ||
    input.format === "portrait" ||
    promptIncludesAny(prompt, ["short", "tiktok", "instagram", "reel"]);
  const needsOnScreenCaptionOcr =
    input.needsOnScreenCaptionOcr === true ||
    promptIncludesAny(prompt, [
      "no audio",
      "no voice",
      "baked-in caption",
      "on-screen text",
      "read the text",
      "visible captions",
    ]);
  const includeCaptions = input.includeCaptions !== false;
  const includeMusic = input.includeMusic !== false;
  const allowSilenceRemoval = input.allowSilenceRemoval !== false;

  const plan: Array<{
    id: string;
    title: string;
    tool?: string;
    mode?: "inspect" | "dry-run" | "apply" | "agent-vision" | "review";
    rationale: string;
    suggestedArgs?: unknown;
  }> = [
    {
      id: "inspect",
      title: "Inspect project and capabilities",
      tool: "screenslick_analyze_timeline",
      mode: "inspect",
      rationale:
        "Ground the edit in the current duration, layers, audio, captions, and existing voiceover state.",
    },
  ];

  if (allowSilenceRemoval) {
    plan.push({
      id: "tighten-pacing",
      title: "Tighten pacing with silence removal",
      tool: "screenslick_remove_silences",
      mode: "dry-run",
      rationale:
        "Broad demo edits should remove dead air before adding timeline-anchored titles, captions, and emphasis.",
      suggestedArgs: { mode: "default", dryRun: true },
    });
  }

  if (needsOnScreenCaptionOcr) {
    plan.push(
      {
        id: "sample-visible-captions",
        title: "Sample baked-in caption frames",
        tool: "screenslick_extract_on_screen_captions",
        mode: "agent-vision",
        rationale:
          "The source appears to rely on visible text rather than speech, so sample caption crops for OCR/vision.",
        suggestedArgs: {
          startTime: 0,
          endTime: durationSeconds ?? undefined,
          intervalMs: 1000,
          maxSamples: 30,
          includeFullFrame: false,
        },
      },
      {
        id: "merge-visible-captions",
        title: "Merge OCR readings into timed narration clips",
        tool: "screenslick_merge_on_screen_caption_ocr",
        mode: "review",
        rationale:
          "Review deduped caption text and timing before generating narration.",
        suggestedArgs: {
          readings: [],
          options: { minConfidence: 0.5, mergeGapMs: 1500 },
        },
      },
    );
  } else if (includeCaptions) {
    plan.push({
      id: "generate-transcript",
      title: "Generate local transcript and captions",
      tool: "screenslick_generate_transcript",
      mode: "apply",
      rationale:
        "Captions improve silent viewing and provide a text track for narration/script planning.",
      suggestedArgs: {
        language: "en",
        provider: "local",
        modelSize: "base",
        enableSubtitles: true,
      },
    });
  }

  plan.push({
    id: "voiceover-plan",
    title: promptWantsPremium
      ? "Prepare premium expressive narration"
      : "Prepare local narration fallback",
    tool: needsOnScreenCaptionOcr
      ? "screenslick_create_voiceover_from_on_screen_captions"
      : "screenslick_generate_script",
    mode: promptWantsPremium ? "review" : "apply",
    rationale: promptWantsPremium
      ? "Premium voiceover can use expression tags but consumes credits, so it needs explicit user confirmation before generation."
      : "Local narration is safe for a first draft without spending credits.",
    suggestedArgs: needsOnScreenCaptionOcr
      ? {
          readings: [],
          provider: promptWantsPremium ? "gemini" : "local",
          dryRun: true,
          premiumConfirmed: false,
        }
      : {
          mode: "script",
          brief: {
            videoType: "demo",
            audience:
              typeof input.audience === "string"
                ? input.audience
                : "potential viewers",
            tone: typeof input.tone === "string" ? input.tone : "confident",
            notes: prompt,
          },
        },
  });

  if (includeMusic) {
    plan.push({
      id: "music",
      title: "Choose low-volume music bed",
      tool: "screenslick_list_music",
      mode: "inspect",
      rationale:
        "Pick music that supports the requested tone, then add it quietly enough to leave speech intelligible.",
    });
  }

  plan.push(
    {
      id: "visual-structure",
      title: "Add intro, outro, canvas styling, and emphasis beats",
      tool: "screenslick_apply_commands",
      mode: "dry-run",
      rationale:
        "Use editor-native text, backgrounds, padding, zooms, clip-position moves, and SFX as one reviewed batch.",
      suggestedArgs: {
        dryRun: true,
        description:
          "Director Mode visual structure: intro, layout polish, emphasis beats, and outro.",
        commands: [],
      },
    },
    {
      id: "verify",
      title: "Verify timeline and capture a review frame",
      tool: "screenslick_analyze_timeline",
      mode: "review",
      rationale:
        "Confirm captions, voiceover, music, and visual layers exist without duplicated or misaligned clips.",
    },
  );

  return {
    prompt,
    intent: {
      audience: input.audience ?? "general viewers",
      tone: input.tone ?? (promptWantsPremium ? "expressive" : "confident"),
      format: input.format ?? (wantsShort ? "shorts" : "auto"),
      targetDurationSeconds:
        getNumber(input.targetDurationSeconds) ?? durationSeconds ?? null,
      wantsShort,
      needsOnScreenCaptionOcr,
      includeCaptions,
      includeMusic,
      allowSilenceRemoval,
    },
    consent: {
      premiumVoiceoverRequired: promptWantsPremium,
      mustAskUserBeforePremium: promptWantsPremium,
      reason: promptWantsPremium
        ? "Premium Gemini voiceover consumes credits."
        : null,
    },
    project: analysis,
    plan,
    executionNotes: [
      "Run dry-run steps before mutating broad timeline layers.",
      "Place intro at the beginning and CTA/outro near the end.",
      "Use typing/click SFX for typewriter or scramble text; use swoosh/whoosh for spatial movement.",
      "Duck music under narration and keep captions readable.",
      "After applying visual edits, capture a frame and re-run timeline analysis.",
    ],
  };
}

function titleCaseFromPrompt(prompt: string) {
  const cleaned = prompt
    .replace(
      /\b(create|make|build|edit|polish|cool|kick ass|kick-ass|demo|video)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  const candidate = cleaned || "Product Demo";
  return candidate
    .split(/\s+/)
    .slice(0, 5)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getDurationSecondsFromAnalysis(analysis: unknown) {
  const duration = getNumber(asRecord(analysis)?.durationSeconds);
  return duration && duration > 0 ? duration : 12;
}

function getDemoAspectRatio(format: unknown) {
  if (format === "shorts" || format === "portrait") return "9:16";
  if (format === "square") return "1:1";
  if (format === "landscape") return "16:9";
  return "16:9";
}

function buildDemoVideoCommands(args: unknown, analysis: unknown) {
  const input = asRecord(args) ?? {};
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) {
    throw new Error("Provide a prompt for screenslick_create_demo_video.");
  }

  const durationSeconds = getDurationSecondsFromAnalysis(analysis);
  const title =
    typeof input.title === "string" && input.title.trim()
      ? input.title.trim()
      : titleCaseFromPrompt(prompt);
  const outroText =
    typeof input.outroText === "string" && input.outroText.trim()
      ? input.outroText.trim()
      : "Now live";
  const includeMusic = input.includeMusic !== false;
  const includeIntroOutro = input.includeIntroOutro !== false;
  const includeBackground = input.includeBackground !== false;
  const includeCameraLayout = input.includeCameraLayout !== false;
  const includeMotion = input.includeMotion !== false;
  const format =
    typeof input.format === "string" && input.format !== "auto"
      ? input.format
      : promptIncludesAny(prompt, ["short", "tiktok", "instagram", "reel"])
        ? "shorts"
        : "landscape";
  const aspectRatio = getDemoAspectRatio(format);
  const musicTrackId =
    typeof input.musicTrackId === "string" && input.musicTrackId
      ? input.musicTrackId
      : promptIncludesAny(prompt, ["explosive", "hype", "high energy", "fast"])
        ? "afterburner-glow"
        : "demo-day-drop";
  const backgroundId =
    typeof input.backgroundId === "string" && input.backgroundId
      ? input.backgroundId
      : "vivid-swirl";

  const commands: unknown[] = [{ type: "aspectRatio.set", aspectRatio }];

  if (includeBackground) {
    commands.push({
      type: "background.set",
      background: {
        id: backgroundId,
        padding: aspectRatio === "9:16" ? 8 : 10,
        borderRadius: 18,
        shadowIntensity: 45,
        backgroundBlur: 0,
        glassBorder: 0,
        clipTilt: aspectRatio === "9:16" ? 0 : -2,
        clipTiltX: 0,
        glowStrength: 18,
      },
    });
  }

  const layers = asRecord(asRecord(analysis)?.layers) ?? {};
  const hasCameraOverlay = (getNumber(layers.cameraOverlay) ?? 0) > 0;
  if (includeCameraLayout && hasCameraOverlay) {
    commands.push({
      type: "cameraOverlay.update",
      updates: {
        layout: aspectRatio === "9:16" ? "portrait-overlay" : "side-by-side-right",
        hidden: false,
        opacity: 1,
        borderRadius: aspectRatio === "9:16" ? 22 : 18,
        borderWidth: 0,
        shadowIntensity: 42,
        background: { mode: "blur-portrait" },
      },
    });
  }

  if (includeIntroOutro) {
    commands.push({
      type: "text.add",
      text: title,
      startTime: 0,
      duration: Math.min(3.2, Math.max(2.2, durationSeconds * 0.12)),
      x: 0.08,
      y: 0.34,
      updates: {
        width: 0.84,
        height: 0.22,
        fontSize: aspectRatio === "9:16" ? 44 : 62,
        color: "#ffffff",
        shadowBlur: 18,
        shadowOpacity: 0.55,
        animation: "scramble",
        easeIn: 0.45,
        easeOut: 0.3,
        exitAnimationEnabled: true,
        soundEffect: {
          entrance: {
            mode: "custom",
            effectId: "click-type-fast-01",
            volume: 0.42,
            offsetMs: 0,
          },
          exit: { mode: "off", volume: 0, offsetMs: 0 },
        },
      },
    });

    const outroStart = Math.max(0, durationSeconds - 3.8);
    commands.push({
      type: "text.add",
      text: outroText,
      startTime: outroStart,
      duration: Math.min(3.6, Math.max(2.4, durationSeconds - outroStart)),
      x: 0.1,
      y: 0.4,
      updates: {
        width: 0.8,
        height: 0.18,
        fontSize: aspectRatio === "9:16" ? 34 : 48,
        color: "#ffffff",
        shadowBlur: 14,
        shadowOpacity: 0.5,
        animation: "slide-up",
        easeIn: 0.35,
        easeOut: 0.3,
        exitAnimationEnabled: true,
        soundEffect: {
          entrance: {
            mode: "custom",
            effectId: "swoosh-soft-01",
            volume: 0.35,
            offsetMs: 0,
          },
          exit: {
            mode: "custom",
            effectId: "whoosh-soft-01",
            volume: 0.25,
            offsetMs: 0,
          },
        },
      },
    });
  }

  if (includeMusic) {
    commands.push({
      type: "music.add",
      trackId: musicTrackId,
      videoTime: 0,
      duration: Math.min(durationSeconds, 120),
      sourceOffset: 0,
      volume: 0.16,
    });
  }

  if (includeMotion && durationSeconds > 8) {
    commands.push({
      type: "clipPosition.add",
      time: Math.min(3.5, Math.max(0, durationSeconds * 0.12)),
      updates: {
        duration: Math.min(6, Math.max(3, durationSeconds * 0.16)),
        easeIn: 0.4,
        easeOut: 0.35,
        scale: 1.04,
        endScale: 1.1,
        offsetX: 0,
        offsetY: 0,
        endOffsetX: aspectRatio === "9:16" ? 0 : -3,
        endOffsetY: 0,
        tiltY: aspectRatio === "9:16" ? 0 : -4,
        tiltX: 0,
        entrance: "slide-up",
        exit: "slide-down",
        soundEffect: {
          entrance: {
            mode: "custom",
            effectId: "swoosh-air-01",
            volume: 0.28,
            offsetMs: 0,
          },
          exit: { mode: "off", volume: 0, offsetMs: 0 },
        },
      },
    });
  }

  return {
    prompt,
    title,
    outroText,
    aspectRatio,
    musicTrackId: includeMusic ? musicTrackId : null,
    backgroundId: includeBackground ? backgroundId : null,
    cameraLayout:
      includeCameraLayout && hasCameraOverlay
        ? aspectRatio === "9:16"
          ? "portrait-overlay"
          : "side-by-side-right"
        : null,
    commands,
  };
}

function reviewDemoVideoDraftCommands(draft: unknown, args: unknown) {
  const draftRecord = asRecord(draft) ?? {};
  const input = asRecord(args) ?? {};
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const commands = asArray(draftRecord.commands);
  const findings: Array<{
    severity: "pass" | "info" | "warning" | "error";
    area: string;
    message: string;
    suggestion?: string;
  }> = [];
  const addFinding = (
    severity: "pass" | "info" | "warning" | "error",
    area: string,
    message: string,
    suggestion?: string,
  ) => findings.push({ severity, area, message, suggestion });

  const textCommands = commands
    .map((command) => asRecord(command))
    .filter((command): command is Record<string, unknown> =>
      Boolean(command && command.type === "text.add"),
    );
  const intro = textCommands.find(
    (command) => (getNumber(command.startTime) ?? 0) <= 1.5,
  );
  const outro = textCommands.find((command) => {
    const text = normalizeText(command.text);
    return (
      getNumber(command.startTime) !== null &&
      /(outro|cta|live|visit|watch|start|now)/.test(text)
    );
  });
  if (intro) {
    addFinding("pass", "structure", "Draft includes intro/title text near the beginning.");
  } else {
    addFinding(
      "warning",
      "structure",
      "Draft does not include intro/title text near the beginning.",
      "Add a short title or hook at 0s for broad demo edits.",
    );
  }
  if (outro) {
    addFinding("pass", "structure", "Draft includes CTA/outro-style text.");
  } else {
    addFinding(
      "warning",
      "structure",
      "Draft does not include obvious CTA/outro text.",
      "Add closing text near the end, not at the start.",
    );
  }

  const mismatchedTyping = textCommands.find((command) => {
    const updates = asRecord(command.updates) ?? {};
    const animation =
      typeof updates.animation === "string" ? updates.animation.toLowerCase() : "";
    const soundEffect = asRecord(updates.soundEffect);
    const entranceSound = soundEffectMode(soundEffect, "entrance")
      ?.toLowerCase()
      .trim();
    return (
      (animation.includes("scramble") || animation.includes("type")) &&
      typeof entranceSound === "string" &&
      !/(type|typing|key|click|tick|clack)/.test(entranceSound)
    );
  });
  if (mismatchedTyping) {
    addFinding(
      "warning",
      "sound",
      "Draft pairs a typing/scramble animation with a non-typing entrance sound.",
      "Use keyboard, typing, click, tick, or clack SFX for text reveal animations.",
    );
  } else if (textCommands.length > 0) {
    addFinding("pass", "sound", "Text animation SFX match the generated draft.");
  }

  const musicCommands = commands.filter(
    (command) => asRecord(command)?.type === "music.add",
  );
  if (musicCommands.length > 0) {
    const loudMusic = musicCommands.some((command) => {
      const volume = getNumber(asRecord(command)?.volume);
      return volume !== null && volume > 0.22;
    });
    addFinding(
      loudMusic ? "warning" : "pass",
      "sound",
      loudMusic
        ? "Draft music may be too loud for narration."
        : "Draft music is in a low demo-friendly volume range.",
      loudMusic ? "Keep demo music around 0.08-0.18 when narration is present." : undefined,
    );
  } else if (promptIncludesAny(prompt, ["explosive", "hype", "music", "cinematic"])) {
    addFinding(
      "warning",
      "sound",
      "Prompt asks for high-energy audio, but the draft has no music command.",
      "Add an energetic music bed at low volume.",
    );
  }

  if (commands.some((command) => asRecord(command)?.type === "background.set")) {
    addFinding("pass", "visuals", "Draft includes background/padding presentation styling.");
  } else {
    addFinding(
      "info",
      "visuals",
      "Draft does not adjust background or padding.",
      "Use background/padding to make screen recordings feel intentional.",
    );
  }

  if (
    commands.some((command) => asRecord(command)?.type === "cameraOverlay.update")
  ) {
    addFinding("pass", "visuals", "Draft includes camera layout polish.");
  }

  if (commands.some((command) => asRecord(command)?.type === "clipPosition.add")) {
    addFinding("pass", "visuals", "Draft includes a subtle clip-position motion beat.");
  } else {
    addFinding(
      "info",
      "visuals",
      "Draft does not include zoom or clip motion.",
      "Add 1-3 emphasis moments when they help guide attention.",
    );
  }

  const errors = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warning");
  return {
    ok: errors.length === 0,
    summary: {
      errors: errors.length,
      warnings: warnings.length,
      passes: findings.filter((finding) => finding.severity === "pass").length,
      info: findings.filter((finding) => finding.severity === "info").length,
    },
    findings,
  };
}

function splitVoiceoverScript(script: string) {
  return script
    .split(/\n+|(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6);
}

function buildDefaultDemoNarration(args: Record<string, unknown>, draft: unknown) {
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  const draftRecord = asRecord(draft) ?? {};
  const title =
    typeof draftRecord.title === "string" && draftRecord.title.trim()
      ? draftRecord.title.trim()
      : titleCaseFromPrompt(prompt);
  const wantsEnergy = promptIncludesAny(prompt, [
    "explosive",
    "hype",
    "high energy",
    "launch",
    "kick",
  ]);

  return wantsEnergy
    ? [
        `Here is the fast version: ${title} turns this story into a sharper, high-impact demo.`,
        "The key moments stay easy to follow while pacing, captions, motion, and sound do the heavy lifting.",
        "Watch the final beat, then export the cut when it feels ready to share.",
      ]
    : [
        `This is ${title}, cleaned up into a concise demo.`,
        "The edit keeps the important moments clear with captions, pacing, and subtle visual emphasis.",
        "Use the final review pass to tune anything that still needs a human call.",
      ];
}

function buildDemoVoiceoverClips(
  args: Record<string, unknown>,
  project: unknown,
  draft: unknown,
) {
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  const includeVoiceover =
    args.includeVoiceover === true ||
    promptIncludesAny(prompt, [
      "voice",
      "voiceover",
      "narration",
      "narrate",
      "read",
      "speaker",
      "high end",
      "high-end",
    ]);
  if (!includeVoiceover) {
    return {
      shouldRun: false,
      provider: null,
      clips: [],
      reason:
        "Voiceover was not requested. Pass includeVoiceover=true to add a local narration draft.",
    };
  }

  // Premium (Gemini) is opt-in via explicit flags ONLY. Loose prompt words like
  // "high-end" describe desired polish, not a request to spend credits, and
  // inferring premium from them used to silently drop ALL voiceover when the
  // user hadn't confirmed. A vague prompt now produces a free local draft.
  const requestedProvider =
    args.voiceoverProvider === "gemini" || args.includePremiumVoiceover === true
      ? "gemini"
      : "local";
  if (requestedProvider === "gemini" && args.premiumConfirmed !== true) {
    return {
      shouldRun: false,
      provider: "gemini",
      clips: [],
      consentRequired: true,
      reason:
        "Premium Gemini voiceover consumes credits. Ask the user for confirmation, then retry with premiumConfirmed=true or use voiceoverProvider='local'.",
    };
  }

  const script =
    typeof args.voiceoverScript === "string" && args.voiceoverScript.trim()
      ? splitVoiceoverScript(args.voiceoverScript)
      : buildDefaultDemoNarration(args, draft);
  const durationMs = Math.max(8_000, getDurationMsFromProject(project));
  const clipCount = Math.min(script.length, durationMs < 14_000 ? 2 : 3);
  const starts =
    clipCount <= 1
      ? [500]
      : clipCount === 2
        ? [500, Math.max(3_500, durationMs - 5_000)]
        : [500, Math.round(durationMs * 0.38), Math.max(6_000, durationMs - 6_000)];
  const provider = requestedProvider;
  const voice =
    typeof args.voiceoverVoice === "string" && args.voiceoverVoice.trim()
      ? args.voiceoverVoice.trim()
      : provider === "gemini"
        ? "Laomedeia"
        : "af_bella";
  const speed = Math.min(
    provider === "gemini" ? 1.08 : 1.1,
    Math.max(0.85, getNumber(args.voiceoverSpeed) ?? 1.02),
  );
  const style =
    typeof args.voiceoverStyle === "string"
      ? args.voiceoverStyle
      : promptIncludesAny(prompt, ["explosive", "hype", "launch", "high energy"])
        ? "energetic"
        : "natural";
  const direction =
    typeof args.voiceoverDirection === "string" && args.voiceoverDirection.trim()
      ? args.voiceoverDirection.trim()
      : provider === "gemini"
        ? "Confident product-demo read. Add expression sparingly and keep the pacing natural."
        : undefined;

  const clips = script.slice(0, clipCount).map((text, index) => {
    const expressiveText =
      provider === "gemini" && index === 0 && !/^\[[^\]]+\]/.test(text)
        ? `[excitedly] ${text}`
        : text;
    const targetDurationMs = Math.max(
      1800,
      Math.min(6500, estimateSpeechDurationMs(expressiveText)),
    );
    return {
      text: expressiveText,
      startMs: starts[index],
      targetDurationMs,
      provider,
      voice,
      speed,
      style,
      ...(direction ? { direction } : {}),
    };
  });

  return {
    shouldRun: clips.length > 0,
    provider,
    voice,
    speed,
    style,
    clips,
    consentRequired: false,
  };
}

async function runDemoVoiceover(
  args: Record<string, unknown>,
  project: unknown,
  draft: unknown,
  dryRun: boolean,
) {
  const plan = buildDemoVoiceoverClips(args, project, draft);
  if (!plan.shouldRun) {
    return {
      ok: !plan.consentRequired,
      dryRun,
      status: plan.consentRequired ? "consent_required" : "skipped",
      ...plan,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun,
      status: "planned",
      ...plan,
      message:
        "Voiceover clips are planned only during dry-run. Run with dryRun=false to replace timeline voiceover clips.",
    };
  }

  const editor = await callEditor("replace_voiceover_clips", {
    clips: plan.clips,
    enable: true,
  });
  return {
    ok: true,
    dryRun,
    status: "completed",
    ...plan,
    editor,
  };
}

async function runDemoNativePreparation(
  args: Record<string, unknown>,
  dryRun: boolean,
) {
  const allowSilenceRemoval = args.allowSilenceRemoval !== false;
  const includeCaptions = args.includeCaptions !== false;
  const silenceMode =
    typeof args.silenceMode === "string" ? args.silenceMode : "default";
  const results: Array<{
    step: string;
    dryRun: boolean;
    status: "skipped" | "pending" | "completed" | "failed";
    result?: unknown;
    error?: string;
  }> = [];

  if (allowSilenceRemoval) {
    try {
      results.push({
        step: "remove_silences",
        dryRun,
        status: "completed",
        result: await callEditor("remove_silences", {
          mode: silenceMode,
          dryRun,
        }),
      });
    } catch (error) {
      results.push({
        step: "remove_silences",
        dryRun,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    results.push({
      step: "remove_silences",
      dryRun,
      status: "skipped",
      result: "allowSilenceRemoval=false",
    });
  }

  if (includeCaptions) {
    if (dryRun) {
      results.push({
        step: "generate_transcript",
        dryRun,
        status: "pending",
        result:
          "Skipped during dry-run because transcript generation mutates editor state. Run with dryRun=false to generate local captions.",
      });
    } else {
      try {
        results.push({
          step: "generate_transcript",
          dryRun,
          status: "completed",
          result: await callEditor("generate_transcript", {
            language:
              typeof args.transcriptLanguage === "string"
                ? args.transcriptLanguage
                : "en",
            provider: "local",
            modelSize:
              typeof args.transcriptModelSize === "string"
                ? args.transcriptModelSize
                : "base",
            enableSubtitles: true,
          }),
        });
      } catch (error) {
        results.push({
          step: "generate_transcript",
          dryRun,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } else {
    results.push({
      step: "generate_transcript",
      dryRun,
      status: "skipped",
      result: "includeCaptions=false",
    });
  }

  return {
    ok: results.every((result) => result.status !== "failed"),
    results,
  };
}

async function healthCheck(args: unknown) {
  const includeProject = asRecord(args)?.includeProject !== false;
  const config = getConfig();
  const checks: Array<{
    name: string;
    ok: boolean;
    message: string;
    details?: unknown;
  }> = [];

  let bridgeStatus: unknown = null;
  try {
    bridgeStatus = await ensureBridge();
    const connected = Boolean(asRecord(bridgeStatus)?.connected);
    checks.push({
      name: "bridge",
      ok: true,
      message: connected
        ? "Local bridge is running and an editor is connected."
        : "Local bridge is running, but no editor is connected.",
      details: bridgeStatus,
    });
    if (connected) {
      const session = asRecord(asRecord(bridgeStatus)?.session);
      const protocolVersion = getNumber(session?.agentProtocolVersion);
      if (protocolVersion === EXPECTED_EDITOR_AGENT_PROTOCOL_VERSION) {
        checks.push({
          name: "compatibility",
          ok: true,
          message: `Editor agent protocol ${protocolVersion} is compatible with this MCP server.`,
          details: {
            expectedAgentProtocolVersion:
              EXPECTED_EDITOR_AGENT_PROTOCOL_VERSION,
            editorAgentProtocolVersion: protocolVersion,
            appVersion: session?.appVersion ?? null,
          },
        });
      } else {
        checks.push({
          name: "compatibility",
          ok: false,
          message:
            protocolVersion === null
              ? "Connected editor did not report an agent protocol version. Refresh ScreenSlick and reconnect the Agent button."
              : `Editor agent protocol ${protocolVersion} does not match expected protocol ${EXPECTED_EDITOR_AGENT_PROTOCOL_VERSION}.`,
          details: {
            expectedAgentProtocolVersion:
              EXPECTED_EDITOR_AGENT_PROTOCOL_VERSION,
            editorAgentProtocolVersion: protocolVersion,
            appVersion: session?.appVersion ?? null,
          },
        });
      }
    }
  } catch (error) {
    checks.push({
      name: "bridge",
      ok: false,
      message: error instanceof Error ? error.message : "Bridge check failed.",
    });
  }

  let projectSummary: unknown = null;
  if (includeProject && asRecord(bridgeStatus)?.connected) {
    try {
      projectSummary = analyzeProject(await getProject());
      checks.push({
        name: "project",
        ok: Boolean(asRecord(projectSummary)?.hasVideo),
        message: Boolean(asRecord(projectSummary)?.hasVideo)
          ? "Editor has a loaded video project."
          : "Editor is connected, but no video is loaded.",
      });
    } catch (error) {
      checks.push({
        name: "project",
        ok: false,
        message:
          error instanceof Error ? error.message : "Project check failed.",
      });
    }
  }

  const ok = checks.every((check) => check.ok);
  const hasCompatibilityFailure = checks.some(
    (check) => check.name === "compatibility" && !check.ok,
  );
  return {
    ok,
    server: {
      name: "screenslick",
      version: PACKAGE_VERSION,
    },
    config: {
      host: config.host,
      port: config.port,
      path: "/screenslick-agent",
      websocketUrl: config.websocketUrl,
    },
    checks,
    project: projectSummary,
    nextSteps: ok
      ? [
          "Call screenslick_analyze_timeline before broad edits.",
          "Call screenslick_get_capabilities before creative command batches.",
        ]
      : hasCompatibilityFailure
        ? [
            "Refresh the ScreenSlick editor tab or deployed app.",
            "Click the Agent button again and wait for it to show connected.",
            "Re-run screenslick_health_check before broad edits.",
          ]
        : [
          "Open ScreenSlick in the browser.",
          "Load or select a video project.",
          "Click the Agent button and wait for it to show connected.",
          ],
  };
}

function selectVoiceInfo(capabilities: unknown) {
  if (
    capabilities &&
    typeof capabilities === "object" &&
    "commands" in capabilities
  ) {
    const commands = (capabilities as { commands?: unknown }).commands;
    if (commands && typeof commands === "object" && "voiceover" in commands) {
      const voiceover = (commands as { voiceover?: unknown }).voiceover;
      if (
        voiceover &&
        typeof voiceover === "object" &&
        "voiceSelection" in voiceover
      ) {
        return (voiceover as { voiceSelection: unknown }).voiceSelection;
      }
    }
  }
  return capabilities;
}

async function callScreenSlickTool(name: ToolName, args: unknown) {
  if (name === "screenslick_bridge_status") {
    await ensureBridge();
    return textContent(getBridgeStatus());
  }

  if (name === "screenslick_health_check") {
    return textContent(await healthCheck(args));
  }

  if (name === "screenslick_analyze_timeline") {
    return textContent(analyzeProject(await getProject()));
  }

  if (name === "screenslick_review_director_draft") {
    return textContent(
      buildDirectorDraftReview(args, await getProject()),
    );
  }

  if (name === "screenslick_validate_voiceover_timing") {
    return textContent(
      validateVoiceoverTiming(await getProject(), args),
    );
  }

  if (name === "screenslick_analyze_video_segments") {
    return textContent(
      analyzeVideoSegments(await getProject(), args),
    );
  }

  if (name === "screenslick_find_clip_candidates") {
    return textContent(
      findClipCandidates(await getProject(), args),
    );
  }

  if (name === "screenslick_create_clip_collection") {
    return textContent(createClipCollection(args));
  }

  if (name === "screenslick_director_plan") {
    let project: unknown;
    try {
      project = await getProject();
    } catch (error) {
      project = {
        hasVideo: false,
        timelineDuration: null,
        preset: null,
        error:
          error instanceof Error
            ? error.message
            : "Could not inspect current project.",
      };
    }
    return textContent(buildDirectorPlan(args, project));
  }

  if (name === "screenslick_create_demo_video") {
    const input = asRecord(args) ?? {};
    const dryRun = input.dryRun !== false;
    const includeReview = input.includeReview !== false;
    const initialProject = await getProject();
    const plan = buildDirectorPlan(args, initialProject);
    const nativePreparation = await runDemoNativePreparation(input, dryRun);
    const preparedProject =
      dryRun || !nativePreparation.ok
        ? initialProject
        : await getProject();
    const preparedAnalysis = analyzeProject(preparedProject);
    const preliminaryDraft = buildDemoVideoCommands(args, preparedAnalysis);
    const voiceover = await runDemoVoiceover(
      input,
      preparedProject,
      preliminaryDraft,
      dryRun,
    );
    const project =
      dryRun || !voiceover.ok ? preparedProject : await getProject();
    const analysis = analyzeProject(project);
    const draft = buildDemoVideoCommands(args, analysis);
    const reviewTargetFormat =
      typeof input.format === "string" ? input.format : "auto";
    const preflightReview = includeReview
      ? buildDirectorDraftReview(
          { ...input, stage: "preflight", targetFormat: reviewTargetFormat },
          project,
        )
      : null;
    const draftReview = includeReview
      ? reviewDemoVideoDraftCommands(draft, args)
      : null;
    const editor = await callEditor("apply_commands", {
      commands: draft.commands,
      dryRun,
      description:
        "Director Mode first draft: intro/outro, canvas styling, music, and motion.",
    });
    const postEditProject = dryRun ? null : await getProject();
    const verification = postEditProject ? analyzeProject(postEditProject) : null;
    const postEditReview =
      includeReview && postEditProject
        ? buildDirectorDraftReview(
            { ...input, stage: "post_edit", targetFormat: reviewTargetFormat },
            postEditProject,
          )
        : null;
    return textContent({
      dryRun,
      plan,
      nativePreparation,
      voiceover,
      draft,
      review: {
        preflight: preflightReview,
        generatedDraft: draftReview,
        postEdit: postEditReview,
      },
      editor,
      verification,
      nextSteps: dryRun
        ? [
            "Review nativePreparation results; transcript generation is intentionally pending during dry-run.",
            "Review voiceover status; premium narration requires premiumConfirmed=true before generation.",
            "Review generated commands.",
            "Review the generatedDraft findings before applying.",
            "Call screenslick_create_demo_video again with dryRun=false to apply this safe visual/audio pass.",
            "Handle OCR-caption narration separately if the plan requires agent vision.",
          ]
        : [
            "Review nativePreparation results and fix any failed pacing or caption step.",
            "Review voiceover status and timing validation.",
            "Review the timeline in ScreenSlick.",
            "Review the postEdit findings and fix any warning that matters for this video.",
            "Run screenslick_capture_frame to inspect composition.",
            "Run screenslick_review_director_draft again after any manual or agent follow-up fixes.",
          ],
    });
  }

  if (name === "screenslick_merge_on_screen_caption_ocr") {
    return textContent(mergeOnScreenCaptionOcr(args));
  }

  if (name === "screenslick_create_voiceover_from_on_screen_captions") {
    const input = asRecord(args) ?? {};
    const provider = input.provider === "gemini" ? "gemini" : "local";
    if (provider === "gemini" && input.premiumConfirmed !== true) {
      throw new Error(
        "Premium Gemini voiceover consumes credits. Ask the user for confirmation, then retry with premiumConfirmed=true.",
      );
    }

    const merged = mergeOnScreenCaptionOcr(args);
    const voice = typeof input.voice === "string" ? input.voice : undefined;
    const speed = getNumber(input.speed) ?? undefined;
    const style = typeof input.style === "string" ? input.style : undefined;
    const direction =
      typeof input.direction === "string" ? input.direction : undefined;
    const clips = merged.clips.map((clip) => ({
      text: clip.text,
      startMs: clip.startMs,
      endMs: clip.endMs,
      targetDurationMs: clip.targetDurationMs,
      provider,
      ...(voice ? { voice } : {}),
      ...(speed ? { speed } : {}),
      ...(style ? { style } : {}),
      ...(direction ? { direction } : {}),
    }));

    if (input.dryRun === true) {
      return textContent({
        dryRun: true,
        provider,
        clips,
        merge: merged.summary,
        discarded: merged.discarded,
      });
    }

    const result = persistAgentFrameResult(
      await callEditor("replace_voiceover_clips", {
        clips,
        enable: input.enable ?? true,
      }),
    );
    return textContent({
      dryRun: false,
      provider,
      clipsCreated: clips.length,
      merge: merged.summary,
      editor: result,
    });
  }

  const editorMethod = editorMethods[name];
  if (!editorMethod) {
    throw new Error(`Unknown ScreenSlick tool "${name}".`);
  }

  const result = persistAgentFrameResult(await callEditor(editorMethod, args));
  if (name === "screenslick_list_voices") {
    return textContent(selectVoiceInfo(result));
  }
  return textContent(result);
}

async function main() {
  const server = new McpServer({
    name: "screenslick",
    version: PACKAGE_VERSION,
  });

  for (const [name, inputSchema] of Object.entries(passthroughToolSchemas) as [
    ToolName,
    (typeof passthroughToolSchemas)[ToolName],
  ][]) {
    server.registerTool(
      name,
      {
        description: toolDescriptions[name],
        inputSchema,
      },
      async (args: unknown) => callScreenSlickTool(name, args),
    );
  }

  void ensureBridge().catch((error) => {
    debugLog(
      `background bridge startup failed ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

process.on("SIGINT", () => {
  debugLog("mcp received SIGINT");
  process.exit(0);
});

process.on("SIGTERM", () => {
  debugLog("mcp received SIGTERM");
  process.exit(0);
});

main().catch((error) => {
  debugLog(
    `fatal startup error ${error instanceof Error ? error.message : String(error)}`,
  );
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
