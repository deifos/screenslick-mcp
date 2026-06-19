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
      "args": ["-y", "screenslick-mcp"]
    }
  }
}
```

If your client uses form fields:

| Field     | Value                   |
| --------- | ----------------------- |
| Name      | `screenslick`           |
| Transport | `stdio`                 |
| Command   | `npx`                   |
| Arguments | `-y`, `screenslick-mcp` |

## Claude Code

Project-scoped `.mcp.json`:

```json
{
  "mcpServers": {
    "screenslick": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "screenslick-mcp"]
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
args = ["-y", "screenslick-mcp"]
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
      "args": ["-y", "screenslick-mcp"]
    }
  }
}
```

## Available tools

- `screenslick_bridge_status`
- `screenslick_health_check`
- `screenslick_get_project`
- `screenslick_analyze_timeline`
- `screenslick_validate_voiceover_timing`
- `screenslick_analyze_video_segments`
- `screenslick_find_clip_candidates`
- `screenslick_create_clip_collection`
- `screenslick_get_capabilities`
- `screenslick_list_voices`
- `screenslick_list_music`
- `screenslick_list_sound_effects`
- `screenslick_list_effects`
- `screenslick_remove_silences`
- `screenslick_generate_transcript`
- `screenslick_generate_script`
- `screenslick_director_plan`
- `screenslick_create_demo_video`
- `screenslick_review_director_draft`
- `screenslick_generate_voiceover`
- `screenslick_add_transcript_voiceover_to_timeline`
- `screenslick_clear_voiceover`
- `screenslick_replace_voiceover_clips`
- `screenslick_update_voiceover_clip`
- `screenslick_move_voiceover_clip`
- `screenslick_delete_voiceover_clip`
- `screenslick_regenerate_voiceover_clip`
- `screenslick_extract_on_screen_captions`
- `screenslick_merge_on_screen_caption_ocr`
- `screenslick_create_voiceover_from_on_screen_captions`
- `screenslick_preview_voiceover`
- `screenslick_toggle_voiceover`
- `screenslick_cleanup_timeline`
- `screenslick_apply_commands`
- `screenslick_capture_frame`
- `screenslick_export_video`

Voiceover tools are intentionally editable-first. Agent-created narration should use timeline voiceover clips so the user can see the clips in the sidebar, edit text, move them, delete them, and regenerate audio. `screenslick_generate_voiceover` defaults to that editable workflow; only pass `mode: "full-track"` or `editable: false` when the user explicitly wants one flattened generated track.

## Environment variables

| Variable                  | Default                                  | Purpose               |
| ------------------------- | ---------------------------------------- | --------------------- |
| `SCREEN_SLICK_AGENT_PORT` | `32117`                                  | Local bridge port     |
| `SCREEN_SLICK_AGENT_HOST` | `127.0.0.1`                              | Must remain localhost |
| `SCREEN_SLICK_AGENT_LOG`  | package `.tmp/screenslick-agent-mcp.log` | Debug log path        |

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

See [ROADMAP.md](./ROADMAP.md) for the Director Mode plan: reliability,
timeline intelligence, voiceover clip control, on-screen caption extraction,
and high-level demo-video creation tools.

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
- Health checks include editor bridge compatibility information so stale editor
  sessions can be diagnosed with a refresh/reconnect instead of mysterious tool
  failures.
- Provides cleanup tools so agents can clear generated layers before rebuilding
  a pass while preserving the source video clips.
- Orchestrates editor-native silence removal, local caption generation, and
  local or confirmed-premium voiceover as part of high-level demo drafts while
  preserving dry-run safety.
- Applies camera layout polish when the current project has a camera layer,
  using side-by-side or portrait-overlay layouts based on the target format.
- Runs Director Mode reviews around high-level demo drafts so agents can catch
  structure, narration, caption, music, SFX, and visual-polish issues before
  calling an edit done.
- Treats premium voice generation as a consent boundary: agents should ask
  before using premium/Gemini voices because they can consume credits.
