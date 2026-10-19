// The ScreenSlick component library as the helper sees it: a copy shipped in template/components
// (synced from the ScreenSlick repo's motion/components with `npm run sync:skill`). The studio page
// renders the components; the helper uses the catalog to check layers.json and to tell Claude.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentCatalogEntry } from "./schema.js";
import { TEMPLATE_DIR } from "./workspace.js";

let cached: ComponentCatalogEntry[] | null | undefined;

export function componentCatalog(): ComponentCatalogEntry[] | null {
  if (cached !== undefined) return cached;
  const file = join(TEMPLATE_DIR, "components", "catalog.json");
  try {
    cached = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ComponentCatalogEntry[]) : null;
  } catch {
    cached = null;
  }
  return cached;
}
