// Copies from the ScreenSlick repo into this package:
//  - the Motion Studio skill (skills/screenslick-video-studio → template/skill)
//  - the motion component library (motion/components → template/components) plus a catalog
//    (catalog.json for the helper's checks, CATALOG.md for Claude to read).
// Both are written into every workspace when the studio starts.
// Usage: npm run sync:skill [-- <path to screenslick repo>]
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = resolve(process.argv[2] ?? join(root, "..", "screenslick"));

const skillSource = join(repo, "skills", "screenslick-video-studio");
const skillTarget = join(root, "template", "skill");
if (!existsSync(join(skillSource, "SKILL.md"))) {
  console.error(`No skill at ${skillSource}`);
  process.exit(1);
}
rmSync(skillTarget, { recursive: true, force: true });
cpSync(skillSource, skillTarget, { recursive: true });
console.log(`Synced ${skillSource} → ${skillTarget}`);

const componentsSource = join(repo, "motion", "components");
const componentsTarget = join(root, "template", "components");
if (existsSync(join(componentsSource, "index.ts"))) {
  rmSync(componentsTarget, { recursive: true, force: true });
  cpSync(componentsSource, componentsTarget, { recursive: true });
  const metas = readdirSync(componentsSource, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(componentsSource, entry.name, "meta.json")))
    .map((entry) => JSON.parse(readFileSync(join(componentsSource, entry.name, "meta.json"), "utf8")))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  writeFileSync(join(componentsTarget, "catalog.json"), `${JSON.stringify(metas, null, 2)}\n`);
  const lines = [
    "# ScreenSlick component library",
    "",
    "Generated from each component's meta.json. Use a component as a scene-track clip:",
    '`{ "component": "<id>", "props": { … } }` (props left out get their defaults).',
    "",
  ];
  for (const meta of metas) {
    lines.push(`## ${meta.name} (\`${meta.id}\`) · ${meta.category}`, "", meta.description, "", `Use when: ${meta.useWhen}`, "");
    lines.push(`Good length: ${meta.durationInFrames} frames at 30 fps · layer: ${meta.layer}`, "", "| prop | type | default | notes |", "|---|---|---|---|");
    for (const [key, spec] of Object.entries(meta.props)) {
      const extra = [
        spec.type === "number" ? `${spec.min}–${spec.max}${spec.unit ? ` ${spec.unit}` : ""}` : "",
        spec.type === "select" ? spec.options.map((o) => o.value).join(" / ") : "",
        spec.help ?? "",
      ]
        .filter(Boolean)
        .join(" · ");
      lines.push(`| ${key} | ${spec.type} | \`${JSON.stringify(spec.default)}\` | ${extra.replace(/\|/g, "\\|")} |`);
    }
    lines.push("", "Examples:", ...meta.examples.map((ex) => `- ${ex.name}: \`${JSON.stringify(ex.props)}\``), "");
  }
  writeFileSync(join(componentsTarget, "CATALOG.md"), `${lines.join("\n")}\n`);
  console.log(`Synced ${metas.length} components → ${componentsTarget}`);
} else {
  console.log(`No component library at ${componentsSource} (skipped)`);
}
