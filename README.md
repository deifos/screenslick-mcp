# ScreenSlick MCP Server

Local MCP server for controlling the ScreenSlick browser editor from Codex,
Claude Code, Claude Desktop, Cursor, and other MCP clients.

The server runs locally over stdio and opens a localhost bridge at:

```text
ws://127.0.0.1:32117/screenslick-agent
```

Open ScreenSlick, enter the editor, click **Agent**, then ask your MCP client to
call `screenslick_bridge_status`.

## Install

No ScreenSlick source checkout is required. Use the npm package from your MCP
client:

```json
{
  "mcpServers": {
    "screenslick": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@screenslick/mcp"]
    }
  }
}
```

If your client uses form fields:

| Field | Value |
| --- | --- |
| Name | `screenslick` |
| Transport | `stdio` |
| Command | `npx` |
| Arguments | `-y`, `@screenslick/mcp` |

## Claude Code

Project-scoped `.mcp.json`:

```json
{
  "mcpServers": {
    "screenslick": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@screenslick/mcp"]
    }
  }
}
```

Restart Claude Code, approve the MCP server, then run `/mcp` to confirm the
`screenslick` server is connected.

## Codex CLI

Add a stdio server entry to your Codex config:

```toml
[mcp_servers.screenslick]
command = "npx"
args = ["-y", "@screenslick/mcp"]
startup_timeout_sec = 10
tool_timeout_sec = 120
```

## Cursor

Create `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "screenslick": {
      "command": "npx",
      "args": ["-y", "@screenslick/mcp"]
    }
  }
}
```

## Available tools

- `screenslick_bridge_status`
- `screenslick_get_project`
- `screenslick_get_capabilities`
- `screenslick_list_voices`
- `screenslick_list_music`
- `screenslick_list_sound_effects`
- `screenslick_list_effects`
- `screenslick_remove_silences`
- `screenslick_generate_transcript`
- `screenslick_generate_script`
- `screenslick_generate_voiceover`
- `screenslick_add_transcript_voiceover_to_timeline`
- `screenslick_preview_voiceover`
- `screenslick_toggle_voiceover`
- `screenslick_apply_commands`
- `screenslick_capture_frame`
- `screenslick_export_video`

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `SCREEN_SLICK_AGENT_PORT` | `32117` | Local bridge port |
| `SCREEN_SLICK_AGENT_HOST` | `127.0.0.1` | Must remain localhost |
| `SCREEN_SLICK_AGENT_LOG` | package `.tmp/screenslick-agent-mcp.log` | Debug log path |

The bridge is intentionally localhost-only. Remote hosts are rejected.

## Verify

1. Start ScreenSlick and open the editor.
2. Click **Agent** in the editor.
3. Ask the MCP client to call:

   ```text
   screenslick_bridge_status
   ```

Healthy response:

```json
{
  "ok": true,
  "connected": true,
  "port": 32117,
  "path": "/screenslick-agent",
  "session": {
    "hasVideo": true,
    "timelineDuration": 62.63
  }
}
```

## Development

```bash
npm install
npm run build
npm run dev
```

Use development mode from this repo:

For live source changes:

```json
{
  "mcpServers": {
    "screenslick": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "cwd": "/path/to/screenslick-mcp"
    }
  }
}
```

For testing the built package:

```json
{
  "mcpServers": {
    "screenslick": {
      "type": "stdio",
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/screenslick-mcp"
    }
  }
}
```

## Best-practice notes

- Uses the official MCP TypeScript SDK over stdio.
- Keeps editor bridge traffic on `127.0.0.1`.
- Does not require the ScreenSlick source repo on the user's machine.
- Uses structured input schemas for every tool.
- Routes editor actions through ScreenSlick's native editor APIs instead of
  processing video files directly.
- Treats premium voice generation as a consent boundary: agents should ask
  before using premium/Gemini voices because they can consume credits.
