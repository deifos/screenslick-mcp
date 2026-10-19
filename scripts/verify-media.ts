import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertEditorSupports,
  buildImportVoiceoverPayload,
  downloadSourceFile,
  findCompanionPackageDir,
  type EditorCall,
} from "../src/media.js";

const root = mkdtempSync(join(tmpdir(), "screenslick-mcp-media-"));

// --- Audio import payloads ---------------------------------------------------
const lineOne = join(root, "line-1.wav");
const lineTwo = join(root, "line-2.mp3");
writeFileSync(lineOne, Buffer.from("RIFF-fake-wave-bytes"));
writeFileSync(lineTwo, Buffer.from("ID3-fake-mp3-bytes"));

const payload = await buildImportVoiceoverPayload({
  clips: [
    { file: lineOne, startMs: 1234.4, text: "  First line.  " },
    { file: lineTwo, startMs: 5000 },
  ],
  replace: true,
});
assert.equal(payload.clips.length, 2);
assert.deepEqual(
  Buffer.from(payload.clips[0].audioBase64, "base64"),
  readFileSync(lineOne),
);
assert.equal(payload.clips[0].mimeType, "audio/wav");
assert.equal(payload.clips[0].startMs, 1234);
assert.equal(payload.clips[0].text, "First line.");
assert.equal(payload.clips[1].mimeType, "audio/mpeg");
assert.equal("text" in payload.clips[1], false);
assert.equal(payload.replace, true);
assert.equal("captions" in payload, false);

await assert.rejects(
  buildImportVoiceoverPayload({ clips: [{ file: "line.wav", startMs: 0 }] }),
  /absolute path/,
);
await assert.rejects(
  buildImportVoiceoverPayload({
    clips: [{ file: join(root, "notes.txt"), startMs: 0 }],
  }),
  /unsupported audio type/,
);
await assert.rejects(
  buildImportVoiceoverPayload({
    clips: [{ file: join(root, "missing.wav"), startMs: 0 }],
  }),
  /was not found/,
);
await assert.rejects(
  buildImportVoiceoverPayload({ clips: [{ file: lineOne, startMs: -1 }] }),
  /startMs/,
);
await assert.rejects(buildImportVoiceoverPayload({ clips: [] }), /at least one/);

// --- Chunked source download -------------------------------------------------
const source = randomBytes(5 * 1024 * 1024 + 321);
let calls = 0;
const fakeEditor = (bytes: Buffer, assetId = "asset-1"): EditorCall =>
  async (method, params) => {
    calls += 1;
    assert.equal(method, "get_asset_file");
    const input = params as { assetId?: string; offset: number; length: number };
    const chunk = bytes.subarray(input.offset, input.offset + input.length);
    return {
      assetId,
      filename: "My Demo (final).mp4",
      mimeType: "video/mp4",
      size: bytes.length,
      offset: input.offset,
      length: chunk.length,
      done: input.offset + chunk.length >= bytes.length,
      companionPackageId: "pkg-123",
      dataBase64: chunk.toString("base64"),
    };
  };

const assetsDir = join(root, "assets");
const first = await downloadSourceFile(fakeEditor(source), {}, {
  assetsDir,
  chunkBytes: 1024 * 1024,
});
assert.equal(first.cached, false);
assert.equal(first.size, source.length);
assert.equal(first.assetId, "asset-1");
assert.equal(first.companionPackageId, "pkg-123");
assert.ok(first.filePath.endsWith("asset-1-My-Demo-final.mp4"), first.filePath);
assert.deepEqual(readFileSync(first.filePath), source);
// One probe plus six 1 MB chunks.
assert.equal(calls, 7);
assert.deepEqual(
  readdirSync(assetsDir).filter((name) => name.endsWith(".part")),
  [],
);

calls = 0;
const second = await downloadSourceFile(fakeEditor(source), {}, {
  assetsDir,
  chunkBytes: 1024 * 1024,
});
assert.equal(second.cached, true);
assert.equal(calls, 1, "a cached download only probes the asset");

// The asset changing mid-download fails cleanly and leaves no partial file.
let changeCalls = 0;
const changing: EditorCall = async (method, params) => {
  changeCalls += 1;
  const result = (await fakeEditor(randomBytes(3 * 1024 * 1024), "asset-2")(
    method,
    params,
  )) as Record<string, unknown>;
  return changeCalls > 2 ? { ...result, size: 1 } : result;
};
await assert.rejects(
  downloadSourceFile(changing, {}, { assetsDir, chunkBytes: 1024 * 1024 }),
  /changed during the download/,
);
assert.deepEqual(
  readdirSync(assetsDir).filter((name) => name.startsWith("asset-2")),
  [],
);

// --- Editor support check ----------------------------------------------------
assert.throws(
  () => assertEditorSupports({ connected: false }, "capture_frames", "tool"),
  /No active ScreenSlick editor/,
);
assert.throws(
  () =>
    assertEditorSupports(
      { connected: true, session: { agentProtocolVersion: 1 } },
      "capture_frames",
      "screenslick_capture_frames",
    ),
  /Reload the editor tab/,
);
assert.doesNotThrow(() =>
  assertEditorSupports(
    { connected: true, session: { agentMethods: ["capture_frames"] } },
    "capture_frames",
    "screenslick_capture_frames",
  ),
);

// --- Companion package folder ------------------------------------------------
const recordings = join(root, "recordings");
mkdirSync(join(recordings, "pkg-123"), { recursive: true });
writeFileSync(join(recordings, "pkg-123", "metadata.json"), "{}");
process.env.SCREENSLICK_COMPANION_RECORDINGS_DIR = recordings;
assert.equal(findCompanionPackageDir("pkg-123"), join(recordings, "pkg-123"));
assert.equal(findCompanionPackageDir("pkg-missing"), undefined);
assert.equal(findCompanionPackageDir("../escape"), undefined);
assert.ok(existsSync(first.filePath));

console.log("Media checks passed: audio import, chunked download, support check.");
