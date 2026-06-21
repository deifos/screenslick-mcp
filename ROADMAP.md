# ScreenSlick MCP Director Mode Roadmap

## End Goal

Users should be able to give broad creative prompts such as:

> Create a cool demo video with explosive music and a high-end voiceover with expressions.

The agent should turn the current ScreenSlick project into a polished review draft: paced, captioned, narrated, styled, scored, and ready to export.

## Definition Of Ready

Director Mode is ready when an MCP client can reliably:

- Inspect the current editor/project state.
- Understand creative intent, audience, format, tone, and duration constraints.
- Produce a concise edit plan before making broad timeline changes.
- Ask for confirmation before using premium voiceover credits.
- Generate or improve a voiceover script.
- Add expressive premium voiceover or a local fallback.
- Pick suitable music and duck it under narration.
- Add captions/transcripts.
- Remove silences or choose strong segments.
- Add intro/outro text, text animations, SFX, zooms, backgrounds, padding, camera layouts, and clip motion.
- Detect duplicate/missing/misaligned audio or caption clips.
- Leave the timeline clean, persistent, and reviewable.

## Phase 1: Reliability And Discoverability

Build the MCP surface agents need before they edit:

- `screenslick_health_check`
- `screenslick_analyze_timeline`
- deterministic timeout and partial-result behavior
- idempotent tools where possible
- version compatibility checks between the MCP package and editor bridge
- clearer errors with recovery suggestions

Ready when agents can diagnose connection/version/project problems and summarize the current timeline without dumping raw project JSON.

`screenslick_health_check` now reports the MCP package version plus the editor
agent protocol/app version from the browser hello handshake. It fails with a
recovery suggestion when the connected editor is missing or mismatches the
expected protocol version.

## Phase 2: Voiceover Control

Add precise voiceover clip tools:

- `screenslick_update_voiceover_clip`
- `screenslick_move_voiceover_clip`
- `screenslick_delete_voiceover_clip`
- `screenslick_replace_voiceover_clips`
- `screenslick_regenerate_voiceover_clip`
- `screenslick_validate_voiceover_timing`

Core clip CRUD/regeneration tools are implemented. Timing validation remains
as `screenslick_validate_voiceover_timing`.

Ready when one late or incorrect line can be fixed without rebuilding the whole narration track.

## Phase 3: Caption And Video Understanding

Add tools for videos that already contain baked-in captions or need segment mining:

- `screenslick_extract_on_screen_captions`
- `screenslick_analyze_video_segments`
- `screenslick_find_clip_candidates`
- `screenslick_create_clip_collection`

Frame sampling for baked-in captions is implemented as
`screenslick_extract_on_screen_captions`. It returns timestamped crop/frame
files for OCR-capable agents; automatic OCR and dedupe remain follow-ups.
Agent-side OCR merge and narration creation are implemented as
`screenslick_merge_on_screen_caption_ocr` and
`screenslick_create_voiceover_from_on_screen_captions`.
Segment intelligence is implemented with `screenslick_analyze_video_segments`,
`screenslick_find_clip_candidates`, and `screenslick_create_clip_collection`.

Ready when agents can sample a range, extract visible caption text, dedupe repeated captions, return timed text segments, and optionally create voiceover clips from them.

## Phase 4: Director Planning

Add planning-first tools:

- `screenslick_director_plan`
- `screenslick_create_demo_video`

`screenslick_director_plan` is implemented as a non-mutating planning tool. It
inspects the current project when available, infers likely workflow needs from
the broad prompt, and returns ordered steps plus premium-consent requirements.

The plan should include creative structure, timeline edits, narration approach, music choice, captions, visual styling, and any consent needed for premium features.

Ready when agents can explain their intended edit before mutating the timeline.

## Phase 5: Director Execution

Let the high-level director tool execute safe, editor-native steps:

- inspect project
- ask for premium voiceover approval when needed
- remove silence or select strong clips
- generate transcript/captions
- write voiceover script
- add voiceover clips or full track
- add music with appropriate volume
- apply canvas/style/zoom/text/SFX commands
- validate timeline issues
- summarize changes

`screenslick_create_demo_video` is implemented as a safe first-draft execution
tool. It defaults to dry-run, validates a concrete command batch through the
editor, and can apply editor-native silence removal, local caption generation,
local or confirmed-premium voiceover clips, intro/outro text, canvas styling,
camera layout polish when a camera layer exists, optional music, and subtle
clip motion. Premium voiceover still requires `premiumConfirmed=true` because
it consumes credits. It returns Director Mode review checkpoints for preflight
state, the generated command draft, and the post-edit timeline when edits are
applied.

Ready when a broad prompt creates a coherent first draft without step-by-step user handholding.

## Phase 6: Agent Taste Layer

Keep the ScreenSlick skill and MCP capability descriptions aligned with editing taste:

- `screenslick_review_director_draft`
- intro at the beginning, CTA/outro near the end
- intro/outro card text and voiceover inset inside the card duration
- terminal CTA voiceover leaves tail room before the final frame
- type/scramble text gets typing/click sounds
- slide/zoom gets swoosh/whoosh
- music ducks under speech
- premium voiceover requires confirmation
- captions must remain readable
- avoid stacking unrelated text
- inspect and validate after editing

Ready when Codex, Claude Code, Cursor, and other MCP clients make similar good choices from the same prompt.

`screenslick_review_director_draft` is implemented as a non-mutating taste and
QA review tool. It inspects the live timeline and returns findings for
structure, narration, captions, music/SFX, visual emphasis, and final
verification so agents can catch common bad edits before calling a draft done.
