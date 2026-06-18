# Security

ScreenSlick MCP is a local stdio MCP server. It starts a localhost-only bridge so
the ScreenSlick browser editor can connect to the MCP process.

## Trust boundary

- The bridge binds to `127.0.0.1`.
- Non-local HTTP and WebSocket requests are rejected.
- `SCREEN_SLICK_AGENT_HOST` must remain `127.0.0.1`.
- The server does not process media files directly.
- Editor mutations go through ScreenSlick's existing editor command layer.

## User consent

Agents should ask before using premium/Gemini voice generation because it can
consume ScreenSlick credits.

Agents should also ask before destructive broad edits, such as deleting many
clips or removing large timeline ranges, unless the user explicitly requested
that action.

## Reporting issues

Open a GitHub issue with:

- MCP client name and version
- Operating system
- Node.js version
- ScreenSlick URL/build
- Relevant `.tmp/screenslick-agent-mcp.log` lines, with private data removed
