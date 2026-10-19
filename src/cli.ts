#!/usr/bin/env node
// `npx -y screenslick-mcp`         → the MCP server for the ScreenSlick editor (stdio).
// `npx -y screenslick-mcp studio`  → the Motion Studio helper (same package, one install).
if (process.argv[2] === "studio") {
  process.argv.splice(2, 1);
  await import("./studio/cli.js");
} else {
  await import("./index.js");
}
