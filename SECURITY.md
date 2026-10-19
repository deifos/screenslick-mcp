# Security

ScreenSlick MCP is a local stdio MCP server. It starts a localhost-only bridge so
the ScreenSlick browser editor can connect to the MCP process.

## Trust boundary

- The bridge binds to `127.0.0.1`.
- Non-local HTTP and WebSocket requests are rejected.
- `SCREEN_SLICK_AGENT_HOST` must remain `127.0.0.1`.
- The Studio helper reads and writes project media, serves browser previews,
  and can render video with Remotion on this computer.
- HTTP and WebSocket requests must use a local Host header. Studio also checks
  browser origins against its allowlist.
- Project file routes reject paths that escape through symbolic links or junctions.
- Private Studio chat files are not served through the project file routes.
- Editor mutations go through ScreenSlick's existing editor command layer.

## User consent

Studio runs Claude Code with file editing tools and, by default, shell tools.
The workspace is not an operating-system sandbox. `--no-bash` removes the shell
tool from the allowlist; `--add-dir` grants Claude access to read and edit the
specified folder. Use only folders you intend Claude to access.

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
