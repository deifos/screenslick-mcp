# ScreenSlick MCP Server

Local MCP server for controlling the ScreenSlick browser editor from Codex,
Claude Code, Claude Desktop, Cursor, and other MCP clients.

The server runs locally over stdio and opens a localhost bridge at:

```text
ws://127.0.0.1:32117/screenslick-agent
```

Open ScreenSlick, enter the editor, click **Agent**, then ask your MCP client to
call `screenslick_bridge_status`.

## Motion Studio (`npx -y screenslick-mcp studio`)

The same package ships the local half of **Motion Studio** (ScreenSlick → Motion Studio, `/studio`):
a coding agent (Claude Code or Codex) builds Remotion videos on your computer while you watch the live
preview and edit every layer on the timeline in the browser.

```bash
npx -y screenslick-mcp studio              # workspace in ~/ScreenSlick Studio
npx -y screenslick-mcp studio --dir D:\videos --no-bash
npx -y screenslick-mcp studio --add-dir path/to/your-app   # let the agent read your app's code (remembered)
npx -y screenslick-mcp studio --agent codex   # start the chat with Codex (switch any time in the chat)
```

It needs Claude Code (`claude`) or Codex (`codex`) installed and logged in. With both, the first one found
is the default and the chat header switches between them. The command:

- creates or refreshes the workspace: `projects/<slug>/` (project.json, layers.json, scenes/*.tsx, assets/,
  renders/), the `screenslick-video-studio` skill (in `.claude/skills/` and `.agents/skills/`), `CLAUDE.md` and
  `AGENTS.md`, and the shared runtime in
  `.screenslick/` (managed files are rewritten on every start; projects are never touched);
- owns the bridge on `127.0.0.1:32117`. If a ScreenSlick MCP server (the editor tools in a Claude session)
  already holds the port, the helper asks it to hand the port over (`POST /handoff`); that server then
  forwards its calls to the helper, and the editor page reconnects by itself. Servers older than 0.16
  can't hand over: restart that Claude session once;
- bundles each open project with esbuild and hot-reloads the page when files change;
- serves project files to the page (range requests) and saves uploads and exports into the project;
- runs the agent headless for the chat panel (`claude -p` stream-json or `codex exec --json`, resumed per
  project; switching agents passes a recap of the chat to the new one), with the `screenslick_studio_*`
  MCP tools: status, create/open project, capture frames, contact sheet, media info, transcribe, analyze
  audio, listen (measure, rank, tags, realness, critique), voice-overs, music (Lyria and the ScreenSlick
  library), export, focus. Folders added with `--add-dir` are readable; Claude's edit tools are blocked
  there (`--disallowedTools Edit(...)`) and Codex's sandbox only writes inside the workspace;
- keeps voice/music provider keys in `~/.screenslick/studio-keys.json` (mode 600, outside the workspace)
  and strips them from the agent's environment;
- renders locally with Remotion as a fallback (`npm install` in the workspace on first use).

Only these web origins can use it: `https://screenslick.com`, `https://www.screenslick.com` and
`http://localhost:3005` (add more with `--origin <url>` or `SCREENSLICK_STUDIO_ORIGINS`). Requests from any
other website are refused. The agent may run shell commands in the workspace unless you pass `--no-bash` (Codex always has a sandboxed
shell; `--no-bash` turns off its network access instead).

Each agent is one adapter in `src/studio/agents/` (how to start the CLI for a turn, how to read its output).
To add one, write an adapter next to `claude.ts` / `codex.ts` and list it in `agents/index.ts`.

Update the bundled skill from the ScreenSlick repo with `npm run sync:skill`.

The current browser app connects on port 32117. Keep that default for the Studio
page. A custom `--port` is passed to the workspace MCP configuration, but does
not change the browser's connection address.

Before release, run `npm run build`, `npm run verify:media`,
`npm run verify:bridge-tools`, and `npm run verify:studio-release`. The Studio
checks use a temporary workspace and a separate port.

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
- `screenslick_capture_frames`
- `screenslick_get_source_file`
- `screenslick_import_voiceover_audio`
- `screenslick_export_video`

Voiceover tools are intentionally editable-first. Agent-created narration should use timeline voiceover clips so the user can see the clips in the sidebar, edit text, move them, delete them, and regenerate audio. `screenslick_generate_voiceover` defaults to that editable workflow; only pass `mode: "full-track"` or `editable: false` when the user explicitly wants one flattened generated track.

Agents that make narration with their own TTS can keep it editable: `screenslick_import_voiceover_audio` takes one audio file per line (absolute path, `startMs`, and the spoken text) and adds them as timeline voiceover clips with captions. They move, delete, and export like other clips; to change a line, import a new take.

`screenslick_capture_frames` samples up to 60 frames per call (explicit times, or a range with `fps`) and saves each one to a file. `screenslick_get_source_file` saves the loaded source video to a local file for ffmpeg or other analysis. These three tools need an editor build that supports them; an older editor tab gets a clear "reload the editor" error.

For intro/outro/intermission cards, keep card layers inset instead of flush with the hold edges. Text should usually start a few tenths of a second after the card begins and end before the card ends. Card voiceover should start after the text entrance and leave at least 500ms before a terminal card or final timeline end, especially with premium voices where generated audio can run longer than the requested target.

## Environment variables

| Variable                        | Default                                  | Purpose                                  |
| ------------------------------- | ---------------------------------------- | ---------------------------------------- |
| `SCREEN_SLICK_AGENT_PORT`       | `32117`                                  | Local bridge port                        |
| `SCREEN_SLICK_AGENT_HOST`       | `127.0.0.1`                              | Must remain localhost                    |
| `SCREEN_SLICK_AGENT_LOG`        | package `.tmp/screenslick-agent-mcp.log` | Debug log path                           |
| `SCREEN_SLICK_AGENT_FRAMES_DIR` | package `.tmp/agent-frames`              | Captured frame files                     |
| `SCREEN_SLICK_AGENT_ASSETS_DIR` | system temp `screenslick-agent-assets`   | Downloaded source videos (newest 5 kept) |

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

Checks (no ScreenSlick session needed; they use their own port and temp folders):

```bash
npm run verify:media
npm run verify:bridge-tools
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
- Guides agents to inset intro/outro card text and voiceover inside the card
  duration so terminal CTA audio does not clip on the final frame.
- Treats premium voice generation as a consent boundary: agents should ask
  before using premium/Gemini voices because they can consume credits.
