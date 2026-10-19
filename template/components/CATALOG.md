# ScreenSlick component library

Generated from each component's meta.json. Use a component as a scene-track clip:
`{ "component": "<id>", "props": { … } }` (props left out get their defaults).

## Prompt Box (`prompt-box`) · AI & Product

An AI chat input that types a request character by character, then presses send.

Use when: Showing what a user asks an AI feature ("make a launch video…") right before the result appears; demos of chat, search or command bars.

Good length: 120 frames at 30 fps · layer: overlay

| prop | type | default | notes |
|---|---|---|---|
| text | text | `"Make a 20 second launch video for my app"` |  |
| placeholder | text | `"Describe your video…"` |  |
| label | text | `""` | Optional small line above the box. |
| theme | select | `"dark"` | dark / light |
| accent | color | `"#34d399"` |  |
| speed | number | `28` | 6–80 chars/s |
| delay | number | `12` | 0–90 frames |

Examples:
- Dark: `{}`
- Light search: `{"theme":"light","text":"Find every clip where I mention pricing","placeholder":"Search your recordings","accent":"#6366f1"}`
- With label: `{"label":"Motion Studio","text":"Add a whoosh on every scene change and match the volume"}`

## Stat Counter (`stat-counter`) · Charts & Stats

A big number that counts up to its value with a label, optionally inside a progress ring.

Use when: Social proof and results: users, time saved, a percentage, revenue, a speed-up. One number per clip; put two side by side with two clips and boxes.

Good length: 90 frames at 30 fps · layer: overlay

| prop | type | default | notes |
|---|---|---|---|
| value | number | `12000` | 0–100000000 |
| prefix | text | `""` | e.g. $ or + |
| suffix | text | `"+"` | e.g. %, x, k. With % the ring fills to the value. |
| decimals | number | `0` | 0–2 |
| label | text | `"videos made this month"` |  |
| accent | color | `"#34d399"` |  |
| textColor | color | `"#ffffff"` |  |
| background | color | `"transparent"` |  |
| ring | boolean | `false` |  |
| countFrames | number | `45` | 10–120 frames |

Examples:
- Users: `{}`
- Percent ring: `{"value":87,"suffix":"%","label":"less time editing","ring":true,"accent":"#60a5fa"}`
- Revenue: `{"value":2.4,"decimals":1,"prefix":"$","suffix":"M","label":"saved in production costs","background":"#0b0d10","accent":"#f59e0b"}`

## Lower Third (`lower-third`) · Overlays

A name and role card with an accent bar that slides in near the bottom of the frame.

Use when: Introducing a speaker, a customer quote's author, a product or feature name over footage. Keep it on screen 3–5 seconds.

Good length: 120 frames at 30 fps · layer: overlay

| prop | type | default | notes |
|---|---|---|---|
| name | text | `"Vlad Palacio"` |  |
| title | text | `"Founder, ScreenSlick"` | Leave empty for a name-only card. |
| accent | color | `"#34d399"` |  |
| textColor | color | `"#ffffff"` |  |
| panel | color | `"rgba(12,14,18,0.82)"` |  |
| position | select | `"bottom-left"` | bottom-left / bottom-right / top-left / top-right |
| font | select | `"sans"` | sans / display / serif / mono |

Examples:
- Speaker: `{}`
- Light card: `{"panel":"#ffffff","textColor":"#0b0d10","accent":"#f43f5e","name":"Maya Chen","title":"Head of Design"}`
- Feature tag: `{"name":"Snaps workspace","title":"Screenshots on the canvas","position":"bottom-right","accent":"#60a5fa"}`

## Slide & Zoom Message (`slide-zoom-message`) · Text & Titles

A message slides in from the side with motion blur, the camera pushes in on its first words, travels along the line, then pulls back to show it all.

Use when: Introducing a message or claim with energy: the hook of a promo, a feature name, a bold statement before a reveal. Works best with one or two short lines; give it 3–5 seconds.

Good length: 120 frames at 30 fps · layer: overlay

| prop | type | default | notes |
|---|---|---|---|
| lines | lines | `["Your demos, *finally* sharp."]` | One or two short lines. *Starred* words use the accent color. |
| enterFrom | select | `"left"` | left / right |
| pan | select | `"left"` | left / right · Where the push-in starts; the camera then travels to the other side. |
| zoom | number | `2.2` | 1.2–4 x |
| color | color | `"#ffffff"` |  |
| accent | color | `"#34d399"` |  |
| background | color | `"transparent"` |  |
| size | number | `9` | 4–18 % of frame |
| weight | select | `"800"` | 600 / 800 / 900 |
| font | select | `"sans"` | sans / display / serif / mono |
| motionBlur | boolean | `true` |  |

Examples:
- Hook: `{}`
- From the right: `{"lines":["Record. Edit. *Ship.*"],"enterFrom":"right","pan":"right","accent":"#f43f5e"}`
- On a color: `{"lines":["Meet *Motion Studio*"],"background":"#111827","accent":"#60a5fa","zoom":2.8}`

## Text Reveal (`text-reveal`) · Text & Titles

A headline whose words rise into place one by one, with an optional kicker line and accent words.

Use when: Opening titles, section headers, a feature name before its demo, a promise or tagline. Mark words with *stars* to color them with the accent.

Good length: 90 frames at 30 fps · layer: overlay

| prop | type | default | notes |
|---|---|---|---|
| kicker | text | `"New in ScreenSlick"` | Small line above the headline (leave empty for none). |
| lines | lines | `["Make videos","with *Claude*"]` | One line per row. *Starred* words use the accent color. |
| color | color | `"#ffffff"` |  |
| accent | color | `"#34d399"` |  |
| background | color | `"transparent"` | "transparent" to sit over other layers. |
| size | number | `11` | 4–22 % of frame |
| weight | select | `"800"` | 500 / 700 / 800 / 900 |
| font | select | `"sans"` | sans / display / serif / mono |
| align | select | `"center"` | left / center / right |
| stagger | number | `4` | 1–12 frames |
| blur | boolean | `true` |  |

Examples:
- Launch title: `{"kicker":"New in ScreenSlick","lines":["Make videos","with *Claude*"]}`
- Editorial: `{"kicker":"","lines":["Sharper recordings.","*Clearer* zooms."],"font":"serif","weight":"500","accent":"#f59e0b"}`
- Left, on brand color: `{"kicker":"Chapter 02","lines":["Simpler","editor *controls*"],"align":"left","background":"#111827","accent":"#60a5fa"}`

## Light Leak (`light-leak`) · Transitions

A warm film light leak that blooms over the frame and retracts, covering a cut at its midpoint.

Use when: Soft, cinematic transitions between scenes or clips, reveals, the drop of a song, a dreamy or nostalgic look. Put it on a track above both clips and center it on the cut (from = cut frame − half its length).

Good length: 40 frames at 30 fps · layer: overlay

| prop | type | default | notes |
|---|---|---|---|
| seed | number | `3` | 0–40 · Different numbers give different leak shapes. |
| hueShift | number | `0` | 0–360 ° · 0 warm amber, 120 green, 240 blue. |
| strength | number | `1` | 0.2–1 |
| flash | boolean | `false` | A brief soft white flash at the midpoint. |

Examples:
- Warm: `{}`
- Cool blue: `{"seed":11,"hueShift":210}`
- Bloom: `{"seed":7,"hueShift":330,"flash":true}`

