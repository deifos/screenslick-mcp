import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { AGENT_ASSETS_DIR } from "./config.js";
import { debugLog } from "./log.js";

type JsonObject = Record<string, unknown>;
export type EditorCall = (
  method: string,
  params: unknown,
  options?: { timeoutMs?: number },
) => Promise<unknown>;

const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  webm: "audio/webm",
  flac: "audio/flac",
};

export const MAX_IMPORT_AUDIO_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_AUDIO_TOTAL_BYTES = 100 * 1024 * 1024;
export const ASSET_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_KEPT_ASSET_FILES = 5;
const STALE_PARTIAL_MS = 60 * 60 * 1000;

export interface ImportAudioClipArg {
  file: string;
  startMs: number;
  text?: string;
}

/**
 * Read the agent's local audio files into the editor's import payload. The
 * browser editor can't read the agent's disk, so the bytes travel inline.
 */
export async function buildImportVoiceoverPayload(args: unknown) {
  const input = (args ?? {}) as {
    clips?: ImportAudioClipArg[];
    replace?: boolean;
    captions?: boolean;
    enable?: boolean;
  };
  if (!Array.isArray(input.clips) || input.clips.length === 0) {
    throw new Error("Provide at least one clip with a file and startMs.");
  }

  let totalBytes = 0;
  const clips = [];
  for (const [index, clip] of input.clips.entries()) {
    const label = `Clip ${index + 1}`;
    const file = typeof clip.file === "string" ? clip.file.trim() : "";
    if (!file || !isAbsolute(file)) {
      throw new Error(`${label}: use an absolute path to the audio file.`);
    }
    const extension = extname(file).slice(1).toLowerCase();
    const mimeType = AUDIO_MIME_BY_EXTENSION[extension];
    if (!mimeType) {
      throw new Error(
        `${label}: unsupported audio type ".${extension}". Use ${Object.keys(
          AUDIO_MIME_BY_EXTENSION,
        ).join(", ")}.`,
      );
    }
    if (
      typeof clip.startMs !== "number" ||
      !Number.isFinite(clip.startMs) ||
      clip.startMs < 0
    ) {
      throw new Error(`${label}: startMs must be a number of 0 or more.`);
    }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      throw new Error(`${label}: "${file}" was not found.`);
    }
    if (info.size === 0) throw new Error(`${label}: "${file}" is empty.`);
    if (info.size > MAX_IMPORT_AUDIO_FILE_BYTES) {
      throw new Error(`${label}: "${file}" is larger than 50 MB.`);
    }
    totalBytes += info.size;
    if (totalBytes > MAX_IMPORT_AUDIO_TOTAL_BYTES) {
      throw new Error(
        "These files add up to more than 100 MB. Import them in smaller batches.",
      );
    }
    const bytes = await readFile(file);
    clips.push({
      audioBase64: bytes.toString("base64"),
      mimeType,
      startMs: Math.round(clip.startMs),
      ...(typeof clip.text === "string" && clip.text.trim()
        ? { text: clip.text.trim() }
        : {}),
    });
  }

  return {
    clips,
    ...(typeof input.replace === "boolean" ? { replace: input.replace } : {}),
    ...(typeof input.captions === "boolean"
      ? { captions: input.captions }
      : {}),
    ...(typeof input.enable === "boolean" ? { enable: input.enable } : {}),
  };
}

interface AssetChunk {
  assetId: string;
  filename: string;
  mimeType: string;
  size: number;
  offset: number;
  length: number;
  done: boolean;
  companionPackageId?: string;
  dataBase64: string;
}

function asAssetChunk(value: unknown): AssetChunk {
  const chunk = (value ?? {}) as Partial<AssetChunk>;
  if (
    typeof chunk.assetId !== "string" ||
    typeof chunk.size !== "number" ||
    typeof chunk.offset !== "number" ||
    typeof chunk.dataBase64 !== "string"
  ) {
    throw new Error("The editor returned an invalid source file chunk.");
  }
  return {
    assetId: chunk.assetId,
    filename: typeof chunk.filename === "string" ? chunk.filename : "source",
    mimeType:
      typeof chunk.mimeType === "string" ? chunk.mimeType : "video/mp4",
    size: chunk.size,
    offset: chunk.offset,
    length: typeof chunk.length === "number" ? chunk.length : 0,
    done: chunk.done === true,
    companionPackageId:
      typeof chunk.companionPackageId === "string"
        ? chunk.companionPackageId
        : undefined,
    dataBase64: chunk.dataBase64,
  };
}

function safeFilePart(value: string) {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "source"
  );
}

function resolveAssetsDir(preferred: string) {
  for (const candidate of [
    preferred,
    join(tmpdir(), "screenslick-agent-assets"),
  ]) {
    try {
      mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch (error) {
      debugLog(
        `agent assets dir unavailable ${candidate}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return tmpdir();
}

/** Keep the newest downloads; drop abandoned partial files. */
function pruneAssetsDir(directory: string, keep: string) {
  try {
    const now = Date.now();
    const files = readdirSync(directory)
      .map((name) => {
        const path = join(directory, name);
        return { name, path, mtime: statSync(path).mtimeMs };
      })
      .filter((entry) => entry.path !== keep);
    for (const entry of files) {
      if (entry.name.endsWith(".part") && now - entry.mtime > STALE_PARTIAL_MS) {
        rmSync(entry.path, { force: true });
      }
    }
    const complete = files
      .filter((entry) => !entry.name.endsWith(".part"))
      .sort((left, right) => right.mtime - left.mtime);
    for (const entry of complete.slice(MAX_KEPT_ASSET_FILES - 1)) {
      rmSync(entry.path, { force: true });
    }
  } catch (error) {
    debugLog(
      `agent assets prune failed ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Default Companion package folder for this OS, if it exists. */
export function findCompanionPackageDir(packageId: string | undefined) {
  if (!packageId || !/^[a-zA-Z0-9-]+$/.test(packageId)) return undefined;
  const roots = [
    process.env.SCREENSLICK_COMPANION_RECORDINGS_DIR,
    process.platform === "darwin"
      ? join(homedir(), "Movies", "ScreenSlick Recordings")
      : join(
          process.env.USERPROFILE ?? homedir(),
          "Videos",
          "ScreenSlick Recordings",
        ),
  ];
  for (const root of roots) {
    if (!root) continue;
    const directory = join(root, packageId);
    if (existsSync(join(directory, "metadata.json"))) return directory;
  }
  return undefined;
}

/**
 * Stream an editor asset to a local file in fixed-size chunks, so even long
 * recordings never travel as one oversized bridge message.
 */
export async function downloadSourceFile(
  call: EditorCall,
  args: unknown,
  options: { assetsDir?: string; chunkBytes?: number } = {},
) {
  const input = (args ?? {}) as { assetId?: unknown };
  const requestedAssetId =
    typeof input.assetId === "string" && input.assetId
      ? input.assetId
      : undefined;
  const chunkBytes = options.chunkBytes ?? ASSET_CHUNK_BYTES;
  const directory = resolveAssetsDir(options.assetsDir ?? AGENT_ASSETS_DIR);

  // A tiny first read resolves the asset and its size before any download.
  const probe = asAssetChunk(
    await call("get_asset_file", {
      ...(requestedAssetId ? { assetId: requestedAssetId } : {}),
      offset: 0,
      length: 1,
    }),
  );
  const extension = extname(probe.filename) || ".mp4";
  const filePath = join(
    directory,
    `${safeFilePart(probe.assetId)}-${safeFilePart(
      probe.filename.slice(0, probe.filename.length - extname(probe.filename).length),
    )}${extension}`,
  );
  const companionPackageDir = findCompanionPackageDir(probe.companionPackageId);
  const result = {
    filePath,
    assetId: probe.assetId,
    filename: probe.filename,
    mimeType: probe.mimeType,
    size: probe.size,
    ...(probe.companionPackageId
      ? { companionPackageId: probe.companionPackageId }
      : {}),
    ...(companionPackageDir ? { companionPackageDir } : {}),
  };

  const existing = await stat(filePath).catch(() => null);
  if (existing?.isFile() && existing.size === probe.size) {
    return { ...result, cached: true };
  }

  const partialPath = `${filePath}.part`;
  const handle = await open(partialPath, "w");
  let written = 0;
  try {
    while (written < probe.size) {
      const chunk = asAssetChunk(
        await call("get_asset_file", {
          assetId: probe.assetId,
          offset: written,
          length: chunkBytes,
        }),
      );
      if (chunk.assetId !== probe.assetId || chunk.size !== probe.size) {
        throw new Error("The source video changed during the download.");
      }
      if (chunk.offset !== written) {
        throw new Error("The editor returned an out-of-order chunk.");
      }
      const bytes = Buffer.from(chunk.dataBase64, "base64");
      if (bytes.length === 0) {
        throw new Error("The editor returned an empty chunk.");
      }
      await handle.write(bytes, 0, bytes.length, written);
      written += bytes.length;
    }
  } catch (error) {
    await handle.close();
    await rm(partialPath, { force: true });
    throw error;
  }
  await handle.close();
  if (written !== probe.size) {
    await rm(partialPath, { force: true });
    throw new Error(
      `Downloaded ${written} bytes but the source is ${probe.size} bytes.`,
    );
  }
  await rename(partialPath, filePath);
  pruneAssetsDir(directory, filePath);
  return { ...result, cached: false };
}

/**
 * Fail fast with a clear message when the open editor predates a method,
 * instead of letting the call wait for the bridge timeout.
 */
export function assertEditorSupports(
  status: unknown,
  method: string,
  toolName: string,
) {
  const bridge = (status ?? {}) as JsonObject;
  if (bridge.connected !== true) {
    throw new Error(
      "No active ScreenSlick editor session. Open the editor and enable Agent.",
    );
  }
  const session = (bridge.session ?? {}) as JsonObject;
  const methods = session.agentMethods;
  if (!Array.isArray(methods) || !methods.includes(method)) {
    throw new Error(
      `The open ScreenSlick editor does not support ${toolName} yet. Reload the editor tab to get the latest version, then try again.`,
    );
  }
}
