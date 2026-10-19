/**
 * End-to-end check of the new tools through the built MCP server and the real
 * WebSocket bridge, with a scripted editor on the other end. Run `npm run
 * build` first. Uses its own port and temp folders, so it never touches a
 * running ScreenSlick session.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = mkdtempSync(join(tmpdir(), "screenslick-mcp-e2e-"));
const port = 33000 + Math.floor(Math.random() * 2000);
const source = randomBytes(9 * 1024 * 1024 + 77);
const onePixelPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: {
    ...process.env,
    SCREEN_SLICK_AGENT_PORT: String(port),
    SCREEN_SLICK_AGENT_FRAMES_DIR: join(root, "frames"),
    SCREEN_SLICK_AGENT_ASSETS_DIR: join(root, "assets"),
    SCREEN_SLICK_AGENT_LOG: join(root, "mcp.log"),
  } as Record<string, string>,
});
const client = new Client({ name: "verify-bridge-tools", version: "1.0.0" });
await client.connect(transport);

async function callTool(name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  const text = result.content.map((item) => item.text).join("\n");
  if (result.isError) throw new Error(text);
  return JSON.parse(text) as Record<string, unknown>;
}

const tools = (await client.listTools()).tools.map((tool) => tool.name);
for (const name of [
  "screenslick_capture_frames",
  "screenslick_get_source_file",
  "screenslick_import_voiceover_audio",
]) {
  assert.ok(tools.includes(name), `${name} should be registered`);
}

// Start the bridge, then attach a scripted editor.
await callTool("screenslick_bridge_status", {});
const received: Array<{ method: string; params: Record<string, unknown> }> = [];

function connectEditor(agentMethods?: string[]) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/screenslick-agent`);
    socket.onerror = () => reject(new Error("editor socket failed"));
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          app: "screenslick",
          protocolVersion: 1,
          session: {
            hasVideo: true,
            timelineDuration: 30,
            appVersion: "test",
            agentProtocolVersion: 1,
            ...(agentMethods ? { agentMethods } : {}),
          },
        }),
      );
      // Let the bridge register the hello before tools run.
      setTimeout(() => resolve(socket), 150);
    };
    socket.onmessage = (event) => {
      const request = JSON.parse(String(event.data)) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      received.push({ method: request.method, params: request.params });
      let result: unknown;
      if (request.method === "capture_frames") {
        const times = request.params.times as number[];
        result = {
          count: times.length,
          frames: times.map((time, index) => ({
            index,
            time,
            mimeType: "image/png",
            dataUrl: onePixelPng,
          })),
        };
      } else if (request.method === "get_asset_file") {
        const offset = Number(request.params.offset);
        const chunk = source.subarray(
          offset,
          offset + Number(request.params.length),
        );
        result = {
          assetId: "asset-e2e",
          filename: "demo.mp4",
          mimeType: "video/mp4",
          size: source.length,
          offset,
          length: chunk.length,
          done: offset + chunk.length >= source.length,
          dataBase64: chunk.toString("base64"),
        };
      } else if (request.method === "import_voiceover_audio") {
        const clips = request.params.clips as unknown[];
        result = { imported: clips.length };
      }
      socket.send(JSON.stringify({ id: request.id, result }));
    };
  });
}

const editor = await connectEditor([
  "get_project",
  "capture_frames",
  "get_asset_file",
  "import_voiceover_audio",
]);

// capture_frames: every frame lands on disk, no inline image data returns.
const frames = await callTool("screenslick_capture_frames", {
  times: [1, 2.5, 4],
});
const frameList = frames.frames as Array<Record<string, unknown>>;
assert.equal(frameList.length, 3);
for (const frame of frameList) {
  assert.equal(frame.dataUrl, undefined);
  assert.ok(existsSync(String(frame.filePath)), "frame file should exist");
}

// get_source_file: byte-identical download over many chunks, then cached.
const download = await callTool("screenslick_get_source_file", {});
assert.equal(download.cached, false);
assert.deepEqual(readFileSync(String(download.filePath)), source);
const assetCalls = received.filter((item) => item.method === "get_asset_file");
assert.equal(assetCalls.length, 1 + Math.ceil(source.length / (8 * 1024 * 1024)));
const again = await callTool("screenslick_get_source_file", {});
assert.equal(again.cached, true);

// import_voiceover_audio: the editor receives the exact file bytes.
const take = join(root, "take-1.wav");
writeFileSync(take, randomBytes(4096));
const imported = await callTool("screenslick_import_voiceover_audio", {
  clips: [{ file: take, startMs: 2500, text: "Hello there." }],
  replace: true,
});
assert.equal(imported.imported, 1);
const importCall = received.find(
  (item) => item.method === "import_voiceover_audio",
);
const sentClip = (importCall?.params.clips as Array<Record<string, unknown>>)[0];
assert.deepEqual(
  Buffer.from(String(sentClip.audioBase64), "base64"),
  readFileSync(take),
);
assert.equal(sentClip.startMs, 2500);
assert.equal(sentClip.text, "Hello there.");
assert.equal(importCall?.params.replace, true);

// An editor that predates these methods fails fast with a clear message.
editor.close();
const oldEditor = await connectEditor();
const started = Date.now();
await assert.rejects(
  callTool("screenslick_capture_frames", { times: [1] }),
  /Reload the editor tab/,
);
assert.ok(Date.now() - started < 5000, "should not wait for a timeout");
oldEditor.close();

await client.close();
console.log("Bridge tool checks passed: frames, source download, audio import, old editors.");
