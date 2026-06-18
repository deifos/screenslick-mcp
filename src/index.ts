#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { callEditor, ensureBridge, getBridgeStatus } from "./bridge.js";
import { debugLog } from "./log.js";
import {
  editorMethods,
  passthroughToolSchemas,
  toolDescriptions,
  type ToolName,
} from "./toolSchemas.js";

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

  const editorMethod = editorMethods[name];
  if (!editorMethod) {
    throw new Error(`Unknown ScreenSlick tool "${name}".`);
  }

  const result = await callEditor(editorMethod, args);
  if (name === "screenslick_list_voices") {
    return textContent(selectVoiceInfo(result));
  }
  return textContent(result);
}

async function main() {
  const server = new McpServer({
    name: "screenslick",
    version: "0.1.0",
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
