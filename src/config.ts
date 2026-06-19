import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 32117;
export const WS_PATH = "/screenslick-agent";
export const PACKAGE_VERSION = readPackageVersion();

// Persisted capture/export frames live under the package root by default (next
// to the log), NOT process.cwd(), which is unpredictable when an MCP client
// launches us. Overridable for sandboxed installs where the package dir is
// read-only.
export const AGENT_FRAMES_DIR =
  process.env.SCREEN_SLICK_AGENT_FRAMES_DIR ??
  join(packageRoot, ".tmp", "agent-frames");

function readPackageVersion() {
  try {
    const packageJson = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof packageJson.version === "string"
      ? packageJson.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function getConfig() {
  const port = Number(process.env.SCREEN_SLICK_AGENT_PORT ?? DEFAULT_PORT);
  const host = process.env.SCREEN_SLICK_AGENT_HOST ?? DEFAULT_HOST;
  const logPath =
    process.env.SCREEN_SLICK_AGENT_LOG ??
    join(packageRoot, ".tmp", "screenslick-agent-mcp.log");

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(
      `Invalid SCREEN_SLICK_AGENT_PORT "${String(
        process.env.SCREEN_SLICK_AGENT_PORT,
      )}".`,
    );
  }

  if (host !== DEFAULT_HOST) {
    throw new Error(
      "SCREEN_SLICK_AGENT_HOST must be 127.0.0.1. The ScreenSlick bridge is intentionally localhost-only.",
    );
  }

  return {
    host,
    port,
    logPath,
    bridgeBaseUrl: `http://${host}:${port}`,
    websocketUrl: `ws://${host}:${port}${WS_PATH}`,
  };
}
