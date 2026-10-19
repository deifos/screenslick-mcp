#!/usr/bin/env node
// `npx -y screenslick-mcp studio` — the local half of Motion Studio.
import { BridgeTakeoverError, setBridgeExtension, startOwnedBridge } from "../bridge.js";
import { getConfig, PACKAGE_VERSION } from "../config.js";
import { debugLog } from "../log.js";
import { DEFAULT_ALLOWED_ORIGINS, StudioHost } from "./host.js";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultWorkspaceDir, scaffoldWorkspace, type WorkspacePaths } from "./workspace.js";

interface CliOptions {
  dir: string;
  allowBash: boolean;
  origins: string[];
  addDirs: string[];
  removeDirs: string[];
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dir: process.env.SCREENSLICK_STUDIO_DIR || defaultWorkspaceDir(),
    allowBash: true,
    origins: [],
    addDirs: [],
    removeDirs: [],
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--dir") options.dir = next();
    else if (arg.startsWith("--dir=")) options.dir = arg.slice(6);
    else if (arg === "--port") process.env.SCREEN_SLICK_AGENT_PORT = next();
    else if (arg.startsWith("--port=")) process.env.SCREEN_SLICK_AGENT_PORT = arg.slice(7);
    else if (arg === "--origin") options.origins.push(next());
    else if (arg.startsWith("--origin=")) options.origins.push(arg.slice(9));
    else if (arg === "--no-bash") options.allowBash = false;
    else if (arg === "--add-dir") options.addDirs.push(next());
    else if (arg.startsWith("--add-dir=")) options.addDirs.push(arg.slice(10));
    else if (arg === "--remove-dir") options.removeDirs.push(next());
    else if (arg.startsWith("--remove-dir=")) options.removeDirs.push(arg.slice(13));
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  const fromEnv = (process.env.SCREENSLICK_STUDIO_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  options.origins = [...options.origins, ...fromEnv].map((origin) => origin.replace(/\/+$/, ""));
  return options;
}

const HELP = `Motion Studio (screenslick-mcp ${PACKAGE_VERSION})

Runs the local side of Motion Studio: the bridge on 127.0.0.1:32117,
your video workspace, live bundles for the preview, and Claude Code for chat.

Usage: npx -y screenslick-mcp studio [options]

  --dir <path>      Workspace folder (default: ~/ScreenSlick Studio)
  --port <n>        Bridge port (default 32117)
  --origin <url>    Also allow this web origin (repeatable)
  --add-dir <path>  Let Claude read another folder, e.g. your app's repo (its edit tools are blocked there;
                    remembered for the next runs)
  --remove-dir <p>  Forget a folder added with --add-dir
  --no-bash         Don't let Claude run shell commands
  -h, --help        Show this help
`;

/** Folders Claude may read besides the workspace, kept in .screenslick/settings.json. */
function resolveReadFolders(paths: WorkspacePaths, add: string[], remove: string[]) {
  const file = join(paths.internal, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {}
  const saved = Array.isArray(settings.readFolders) ? settings.readFolders.filter((d): d is string => typeof d === "string") : [];
  const removed = new Set(remove.map((d) => resolve(d).toLowerCase()));
  const folders: string[] = [];
  for (const dir of [...saved, ...add.map((d) => resolve(d))]) {
    if (removed.has(dir.toLowerCase()) || folders.some((f) => f.toLowerCase() === dir.toLowerCase())) continue;
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      process.stderr.write(`  Skipping ${dir}: not a folder.\n`);
      continue;
    }
    folders.push(dir);
  }
  if (add.length || remove.length) {
    writeFileSync(file, `${JSON.stringify({ ...settings, readFolders: folders }, null, 2)}\n`);
  }
  return folders;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.version) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }

  const { paths, created } = scaffoldWorkspace(options.dir);
  const readFolders = resolveReadFolders(paths, options.addDirs, options.removeDirs);
  const { port } = getConfig();
  const host = new StudioHost({
    paths,
    port,
    allowBash: options.allowBash,
    addDirs: readFolders,
    allowedOrigins: [...DEFAULT_ALLOWED_ORIGINS, ...options.origins],
  });
  setBridgeExtension(host);

  try {
    await startOwnedBridge();
  } catch (error) {
    const reason = error instanceof BridgeTakeoverError ? error.reason : (error as NodeJS.ErrnoException).code;
    const messages: Record<string, string> = {
      studio_running: `Motion Studio is already running (port ${port}). Use that window, or close it first.\n`,
      old_mcp:
        `Port ${port} is used by an older ScreenSlick MCP server inside a Claude session.\n` +
        `Restart that Claude session (it picks up the new version) or close it, then start Motion Studio again.\n`,
      unknown_owner: `Port ${port} is used by another program. Close it and start Motion Studio again (the ScreenSlick page always uses this port).\n`,
      EADDRINUSE: `Port ${port} is still busy. Wait a moment and start Motion Studio again.\n`,
    };
    const message = typeof reason === "string" ? messages[reason] : undefined;
    if (message) {
      process.stderr.write(message);
      process.exit(1);
    }
    throw error;
  }
  host.start();
  const claude = await host.getClaude();

  const lines = [
    "",
    `  Motion Studio ${PACKAGE_VERSION}`,
    "",
    `  Workspace   ${paths.root}${created ? "  (new)" : ""}`,
    `  Bridge      http://127.0.0.1:${port}`,
    `  Claude Code ${claude.found ? `found (${claude.version ?? "unknown version"})` : "NOT FOUND — install from https://claude.com/claude-code and log in"}`,
    `  Shell tools ${options.allowBash ? "allowed for Claude" : "off (--no-bash)"}`,
    `  Extra folders ${readFolders.length ? readFolders.join(", ") : "none configured (add a folder with --add-dir <path>)"}`,
    "",
    "  Open https://screenslick.com/studio in Chrome.",
    "  Keep this window open while you work. Ctrl+C to stop.",
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);

  const shutdown = () => {
    host.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  debugLog(`studio fatal ${error instanceof Error ? error.stack : String(error)}`);
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
