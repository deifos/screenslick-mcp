import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, PACKAGE_VERSION } from "../config.js";

export const REMOTION_VERSION = "4.0.536";
export const REACT_VERSION = "19.2.8";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const TEMPLATE_DIR = join(packageRoot, "template");
export const MCP_ENTRY = join(packageRoot, "dist", "index.js");

export interface WorkspacePaths {
  root: string;
  projects: string;
  library: string;
  internal: string;
  runtime: string;
  render: string;
  mcpConfig: string;
  skill: string;
}

export function defaultWorkspaceDir() {
  return join(homedir(), "ScreenSlick Studio");
}

export function workspacePaths(root: string): WorkspacePaths {
  const absolute = resolve(root);
  return {
    root: absolute,
    projects: join(absolute, "projects"),
    library: join(absolute, "library"),
    internal: join(absolute, ".screenslick"),
    runtime: join(absolute, ".screenslick", "runtime"),
    render: join(absolute, ".screenslick", "render"),
    mcpConfig: join(absolute, ".screenslick", "mcp.json"),
    skill: join(absolute, ".claude", "skills", "screenslick-video-studio"),
  };
}

function copyDir(from: string, to: string) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else copyFileSync(source, target);
  }
}

function writeIfChanged(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (readFileSync(path, "utf8") === contents) return;
  } catch {}
  writeFileSync(path, contents);
}

const MANAGED_DEPENDENCIES: Record<string, string> = {
  remotion: REMOTION_VERSION,
  "@remotion/media": REMOTION_VERSION,
  "@remotion/transitions": REMOTION_VERSION,
  "@remotion/shapes": REMOTION_VERSION,
  "@remotion/paths": REMOTION_VERSION,
  "@remotion/noise": REMOTION_VERSION,
  "@remotion/light-leaks": REMOTION_VERSION,
  "@remotion/cli": REMOTION_VERSION,
  react: REACT_VERSION,
  "react-dom": REACT_VERSION,
};

const MANAGED_DEV_DEPENDENCIES: Record<string, string> = {
  "@types/react": "^19.2.0",
  typescript: "^5.8.3",
};

/**
 * Managed packages that aren't installed in the workspace (or are on another pinned version).
 * A local render runs `npm install` when this isn't empty, so new library deps arrive on their own.
 */
export function missingManagedDependencies(root: string) {
  return Object.entries(MANAGED_DEPENDENCIES)
    .filter(([name, wanted]) => {
      try {
        const installed = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")) as { version?: string };
        return /^\d/.test(wanted) && installed.version !== wanted;
      } catch {
        return true;
      }
    })
    .map(([name]) => name);
}

function ensurePackageJson(root: string) {
  const path = join(root, "package.json");
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {}
  const dependencies = { ...(current.dependencies as Record<string, string> | undefined) };
  const devDependencies = { ...(current.devDependencies as Record<string, string> | undefined) };
  Object.assign(dependencies, MANAGED_DEPENDENCIES);
  Object.assign(devDependencies, MANAGED_DEV_DEPENDENCIES);
  const next = {
    name: "screenslick-studio-workspace",
    private: true,
    description: "Motion Studio workspace. Remotion versions are managed by screenslick-studio.",
    ...current,
    dependencies,
    devDependencies,
    scripts: {
      typecheck: "tsc --noEmit",
      ...(current.scripts as Record<string, string> | undefined),
    },
  };
  writeIfChanged(path, `${JSON.stringify(next, null, 2)}\n`);
}

const TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    lib: ["ES2022", "DOM", "DOM.Iterable"],
    module: "ESNext",
    moduleResolution: "Bundler",
    jsx: "react-jsx",
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    resolveJsonModule: true,
    baseUrl: ".",
    paths: {
      "screenslick-studio": [".screenslick/runtime/helpers.tsx"],
      "screenslick-studio/components": [".screenslick/components/index.ts"],
    },
  },
  include: ["projects/**/*.ts", "projects/**/*.tsx", ".screenslick/runtime/**/*.tsx", ".screenslick/runtime/**/*.ts", ".screenslick/components/**/*.tsx", ".screenslick/components/**/*.ts"],
};

export interface ScaffoldResult {
  paths: WorkspacePaths;
  created: boolean;
}

/** Create or refresh the workspace. Managed files are rewritten; projects are never touched. */
export function scaffoldWorkspace(root: string): ScaffoldResult {
  const paths = workspacePaths(root);
  const created = !existsSync(paths.root);
  for (const dir of [paths.root, paths.projects, paths.library, paths.internal, paths.render]) {
    mkdirSync(dir, { recursive: true });
  }

  copyDir(join(TEMPLATE_DIR, "runtime"), paths.runtime);
  // The component library: Claude reads it (and the catalog), local renders import it.
  if (existsSync(join(TEMPLATE_DIR, "components"))) {
    copyDir(join(TEMPLATE_DIR, "components"), join(paths.root, ".screenslick", "components"));
  }
  copyDir(join(TEMPLATE_DIR, "skill"), paths.skill);
  writeIfChanged(join(paths.root, "CLAUDE.md"), readFileSync(join(TEMPLATE_DIR, "CLAUDE.md"), "utf8"));
  writeIfChanged(join(paths.root, "tsconfig.json"), `${JSON.stringify(TSCONFIG, null, 2)}\n`);
  ensurePackageJson(paths.root);
  writeIfChanged(
    paths.mcpConfig,
    `${JSON.stringify(
      {
        mcpServers: {
          screenslick: {
            command: process.execPath,
            args: [MCP_ENTRY],
            env: {
              SCREENSLICK_STUDIO_WORKSPACE: paths.root,
              SCREEN_SLICK_AGENT_PORT: String(getConfig().port),
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeIfChanged(join(paths.internal, "VERSION"), `${PACKAGE_VERSION}\n`);
  writeIfChanged(
    join(paths.internal, "README.md"),
    "Managed by screenslick-studio. Files here are rewritten every time the studio starts.\n",
  );

  const projectEntries = readdirSync(paths.projects).filter((name) => !name.startsWith("."));
  if (projectEntries.length === 0) {
    copyDir(join(TEMPLATE_DIR, "starter"), join(paths.projects, "welcome"));
  }
  return { paths, created };
}

export function isDirectory(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
