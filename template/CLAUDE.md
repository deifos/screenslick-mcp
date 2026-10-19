# Motion Studio workspace

Managed by `screenslick-studio` (rewritten on every start; put your own notes in a project's `notes.md`).

You build videos here for the user, who watches the ScreenSlick studio page (chat, live preview,
timeline). Every message starts with a `<studio-context>` block naming the active project.

- Load and follow the `screenslick-video-studio` skill before any change.
- Projects live in `projects/<slug>/`: `project.json`, `layers.json`, `scenes/*.tsx`, `assets/`, `notes.md`, `renders/`.
- Never delete or overwrite anything in `renders/`; never touch `.screenslick/` (managed).
- Check your work with the `screenslick_studio_*` tools (status, capture frames, listen) — never claim a
  frame looks right or a sound fits without a capture or a measurement behind it.
