import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { setBridgeExtension, startOwnedBridge } from "../src/bridge.js";
import { StudioHost, DEFAULT_ALLOWED_ORIGINS } from "../src/studio/host.js";
import { projectDir, safeJoin } from "../src/studio/projects.js";
import { scaffoldWorkspace, studioMcpServer } from "../src/studio/workspace.js";
import { buildProjectBundle } from "../src/studio/bundler.js";
import { ChatEngine } from "../src/studio/chat.js";

const root = mkdtempSync(join(tmpdir(), "screenslick-studio-review-"));
const port = 37000 + Math.floor(Math.random() * 2000);
process.env.SCREEN_SLICK_AGENT_PORT = String(port);
const { paths } = scaffoldWorkspace(join(root, "workspace"));
const config = JSON.parse(readFileSync(paths.mcpConfig, "utf8"));
assert.equal(config.mcpServers.screenslick.env.SCREEN_SLICK_AGENT_PORT, String(port));
const host = new StudioHost({ paths, port, allowedOrigins: DEFAULT_ALLOWED_ORIGINS, allowBash: false });
setBridgeExtension(host);
const server = await startOwnedBridge();
const base = `http://127.0.0.1:${port}`;
const origin = "https://screenslick.com";
try {
  const forbidden = await fetch(`${base}/studio/ping`, { headers: { Origin: "https://example.invalid" } });
  assert.equal(forbidden.status, 403);
  const rebound = await new Promise<number>((resolve, reject) => {
    const req = request(`${base}/status`, { headers: { Host: `example.invalid:${port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(rebound, 403, "Reject non-local Host headers even without Origin");
  const imported = await fetch(`${base}/studio/import`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Release test", width: 640, height: 360, fps: 30, durationInFrames: 60,
      words: [{ text: "Test", from: 0, to: 20 }], extension: "mp4" }),
  });
  assert.equal(imported.status, 200);
  const { slug, videoPath } = await imported.json() as { slug: string; videoPath: string };
  const dir = projectDir(paths, slug);
  writeFileSync(join(dir, ".studio", "chat.json"), '{"private":true}');
  for (const path of [".studio/chat.json", ".studio%5Cchat.json", ".%2F.studio%2Fchat.json"]) {
    const response = await fetch(`${base}/studio/files/${slug}/${path}`, { headers: { Origin: origin } });
    assert.equal(response.status, 403, `Private path must be blocked: ${path}`);
  }
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "private.txt"), "secret");
  symlinkSync(outside, join(dir, "assets", "escape"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => safeJoin(dir, "assets/escape/private.txt"), /escapes/);
  assert.throws(() => safeJoin(dir, "assets/escape/new.txt"), /escapes/);
  const escaped = await fetch(`${base}/studio/files/${slug}/assets/escape/private.txt`, { headers: { Origin: origin } });
  assert.equal(escaped.status, 400);
  symlinkSync(join(dir, ".studio"), join(dir, "assets", "internal"), process.platform === "win32" ? "junction" : "dir");
  const internal = await fetch(`${base}/studio/files/${slug}/assets/internal/chat.json`, { headers: { Origin: origin } });
  assert.equal(internal.status, 403, "A link must not bypass private file checks");
  const internalUpload = await fetch(`${base}/studio/upload/${slug}/assets/internal/chat.json`, {
    method: "PUT", body: "replace", headers: { Origin: origin },
  });
  assert.equal(internalUpload.status, 403);
  const upload = async (body: string) => {
    const response = await fetch(`${base}/studio/upload/${slug}/${videoPath}`, {
      method: "PUT", body, headers: { Origin: origin, "Content-Type": "video/mp4" },
    });
    assert.equal(response.status, 200);
    return (await response.json() as { path: string }).path;
  };
  const contents = ["first", "second", "third"];
  const saved = await Promise.all(contents.map(upload));
  assert.equal(new Set(saved).size, contents.length, "Concurrent uploads must not overwrite each other");
  saved.forEach((file, i) => assert.equal(readFileSync(join(dir, file), "utf8"), contents[i]));
  const range = await fetch(`${base}/studio/files/${slug}/${saved[0]}`, { headers: { Origin: origin, Range: "bytes=1-3" } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "irs");
  const bundle = await buildProjectBundle(paths, "welcome", undefined);
  assert.equal(bundle.ok, true, JSON.stringify(bundle.errors));
  assert.ok(bundle.code?.includes("StudioComposition"));
  // Use Node as a deliberately invalid Claude executable. This exercises
  // process failure and concurrent requests without invoking an AI service.
  // A second message sent while the first runs is queued (never a second Claude), then runs after it.
  let finished = 0;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  let maxRunning = 0;
  let inFlight = 0;
  const chat = new ChatEngine({
    paths, allowBash: false, addDirs: [], getPageContext: () => null,
    getAgents: async () => [
      { id: "claude", name: "Claude", product: "Claude Code", found: true, path: process.execPath, version: "test", installUrl: "", loginCommand: "claude" },
    ],
    defaultAgent: async () => "claude",
    mcp: studioMcpServer(paths),
    emit: (_event, data) => {
      const kind = (data as { kind?: string }).kind;
      if (kind === "start") maxRunning = Math.max(maxRunning, ++inFlight);
      if (kind === "done") {
        inFlight -= 1;
        if (++finished === 2) finish();
      }
    },
  });
  const turns = await Promise.all([chat.send(slug, "test", {}), chat.send(slug, "test", {})]);
  assert.equal(turns.filter((turn) => "queued" in turn && turn.queued).length, 1, "The second message is queued");
  await done;
  assert.equal(maxRunning, 1);
  assert.equal(chat.runningSlug(), null);
  assert.equal(chat.queued().length, 0);
  console.log("Studio release checks passed: import/upload, ranges, bundle, private paths, junctions, Host/Origin checks, custom-port MCP config, chat queue (one agent at a time).");
  console.log(`Test workspace: ${root}`);
} finally {
  host.stop();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  setBridgeExtension(null);
}
