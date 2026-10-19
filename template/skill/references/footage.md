# Footage sent from the editor

"Send to Motion Studio" in the ScreenSlick editor renders the user's edit and opens it here as a new
project sized to the video:

- **Footage** track: one video clip `footage` with `src: "assets/footage.<ext>"`, `fit: "contain"`,
  covering the whole project. Its audio is the user's voice and the editor mix.
- **Captions** track (when the edit had subtitles): one captions clip with the editor's words, timed in
  frames. Restyle it with `style`; don't retype the words.
- `notes.md` says what came over.

The user finishes the video here: cuts, color, motion graphics, sound, then exports from the studio.

## Remove silences / tighten pacing

1. `screenslick_studio_transcribe` on `assets/footage.<ext>` for word timings (or
   `screenslick_studio_analyze_audio` for per-frame energy when there is no speech).
2. Find gaps longer than ~0.6 s between words (keep ~0.15 s of air before and after each word; never cut
   inside a word). Keep breaths that land on a beat or a reveal.
3. Replace the single footage clip with one clip per kept range, back to back on the Footage track:
   each clip has `src` of the footage, `trimStart` = range start (frames in the file), `from` = where it
   lands on the timeline, `duration` = range length. Give them ids `footage-1`, `footage-2`, …
4. Move every caption word with its range (subtract the time removed before it), drop words in removed
   ranges, and set the project `durationInFrames` to the new end.
5. Tell the user how much you cut ("removed 14 pauses, 0:52 → 0:41"), then check the cut points with
   `screenslick_studio_capture_frames` and `screenslick_studio_listen_critique`.

Cuts "by transcript" ("remove the part where I say …") work the same way: find the words, cut their range.

## Color

Use the `grade` field on each footage clip (copy it to every piece after a cut). Small moves: contrast
1.05–1.15, saturation 1.05–1.2 for punch, warmth 0.1–0.25 for warmer skin, 0.8–0.9 saturation for a
muted look. Check with `screenslick_studio_capture_frames` before and after.

## Motion graphics over footage

Add tracks above Footage (text, scenes, images) and keep the footage readable: lower thirds and callouts
at the edges, punch-in zooms by animating the footage `box`, never covering the speaker's face for long.
