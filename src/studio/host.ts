import { existsSync, mkdirSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, sep } from "node:path";
import { getEditorSession, sendToEditor, type BridgeExtension } from "../bridge.js";
import { PACKAGE_VERSION } from "../config.js";
import { generateMusic, musicOptions, type GenerateMusicInput } from "./music.js";
import { debugLog } from "../log.js";
import { buildProjectBundle, buildRenderEntrySource, type BundleState } from "./bundler.js";
import { ChatEngine, findClaude, type ClaudeInfo } from "./chat.js";
import { handleStudioHttp } from "./http.js";
import {
  assertSlug,
  createProject,
  listAssets,
  listLibrary,
  listProjects,
  projectDir,
  readProjectState,
  StudioError,
  writeLayers,
  writeProjectFile,
  type CreateProjectInput,
} from "./projects.js";
import { cancelLocalRender, runLocalRender } from "./render.js";
import { openFile, projectFile, revealFile } from "./reveal.js";
import {
  generateVoice,
  listVoices,
  removeKey,
  saveKey,
  setDefaultProvider,
  voiceOptions,
  voiceSettings,
  type GenerateVoiceInput,
  type VoiceProviderId,
} from "./voice.js";
import type { WorkspacePaths } from "./workspace.js";

export const DEFAULT_ALLOWED_ORIGINS = [
  "https://screenslick.com",
  "https://www.screenslick.com",
  "http://localhost:3005",
  "http://127.0.0.1:3005",
];

export interface StudioHostOptions {
  paths: WorkspacePaths;
  port: number;
  allowedOrigins: string[];
  allowBash: boolean;
  /** Extra folders Claude may read (the app's repo, a media folder). */
  addDirs?: string[];
}

interface PageSession {
  workspace?: string;
  activeProject?: string | null;
  [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export class StudioHost implements BridgeExtension {
  readonly paths: WorkspacePaths;
  private readonly options: StudioHostOptions;
  private readonly bundles = new Map<string, BundleState>();
  private readonly building = new Map<string, Promise<BundleState>>();
  private readonly rebuildQueued = new Set<string>();
  private readonly watched = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private watcher: FSWatcher | null = null;
  private libraryWatcher: FSWatcher | null = null;
  private claude: ClaudeInfo | null = null;
  private pageSession: PageSession | null = null;
  readonly chat: ChatEngine;

  constructor(options: StudioHostOptions) {
    this.options = options;
    this.paths = options.paths;
    this.chat = new ChatEngine({
      paths: this.paths,
      allowBash: options.allowBash,
      emit: (event, data) => this.emit(event, data),
      getClaude: () => this.getClaude(),
      getPageContext: () => this.pageSession,
      addDirs: options.addDirs ?? [],
    });
  }

  // ---------------------------------------------------------------------------
  // BridgeExtension

  isOriginAllowed(origin: string | undefined) {
    if (!origin) return true; // local tools (curl, MCP server) send no Origin
    return this.options.allowedOrigins.includes(origin.replace(/\/+$/, ""));
  }

  handleHttp(request: IncomingMessage, response: ServerResponse) {
    return handleStudioHttp(request, response, {
      paths: this.paths,
      getBundle: (slug) => this.bundles.get(slug) ?? null,
      ensureBundle: async (slug) => {
        if (!this.bundles.has(slug)) await this.rebuild(slug);
      },
      onUploaded: (slug, rel) => this.emit("studio.assets", { slug, path: rel }),
      importFootage: (input) => this.importFootage(input),
    });
  }

  /**
   * "Send to Motion Studio" from the editor: a project sized to the footage, with the
   * video on its own track and the editor's subtitles as an editable captions clip.
   * The page uploads the video to the returned path right after.
   */
  importFootage(input: Record<string, unknown>) {
    const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback);
    const width = Math.round(num(input.width, 1920) / 2) * 2;
    const height = Math.round(num(input.height, 1080) / 2) * 2;
    const fps = Math.round(num(input.fps, 30));
    const durationInFrames = Math.max(1, Math.round(num(input.durationInFrames, fps * 10)));
    const vertical = height > width;
    const variant = vertical ? "mobile" : "wide";
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : "Footage from the editor";
    const { slug } = createProject(this.paths, {
      name,
      fps,
      durationInFrames,
      variants: { [variant]: { width, height } },
      defaultVariant: variant,
      background: "#000000",
    });
    const ext = typeof input.extension === "string" && /^[a-z0-9]{2,4}$/.test(input.extension) ? input.extension : "mp4";
    const videoPath = `assets/footage.${ext}`;
    const words = (Array.isArray(input.words) ? input.words : [])
      .map((w) => asRecord(w))
      .filter((w) => typeof w.text === "string" && typeof w.from === "number" && typeof w.to === "number")
      .map((w) => ({
        text: String(w.text),
        from: Math.max(0, Math.round(Number(w.from))),
        to: Math.max(Math.round(Number(w.from)) + 1, Math.round(Number(w.to))),
      }))
      .filter((w) => w.from < durationInFrames);
    const tracks: unknown[] = [];
    if (words.length) {
      tracks.push({
        id: "captions",
        name: "Captions",
        kind: "captions",
        clips: [{ id: "captions", name: "Subtitles from the editor", from: 0, duration: durationInFrames, words }],
      });
    }
    tracks.push({
      id: "footage",
      name: "Footage",
      kind: "video",
      clips: [{ id: "footage", name: "Footage", from: 0, duration: durationInFrames, src: videoPath, fit: "contain" }],
    });
    const dir = projectDir(this.paths, slug);
    writeFileSync(join(dir, "layers.json"), `${JSON.stringify({ version: 1, tracks, markers: [] }, null, 2)}\n`);
    writeFileSync(
      join(dir, "notes.md"),
      `# ${name}\n\nFootage sent from the ScreenSlick editor (the edit as it was exported: ${width}×${height}, ${(durationInFrames / fps).toFixed(1)} s).\n` +
        `- Video: ${videoPath} on the Footage track${words.length ? `\n- Subtitles: ${words.length} words on the Captions track (word timings in frames)` : ""}\n`,
    );
    this.emit("studio.projects", { projects: listProjects(this.paths) });
    debugLog(`import: created ${slug} (${width}x${height}, ${durationInFrames}f, ${words.length} words)`);
    return { slug, videoPath };
  }

  onEditorChange(connected: boolean, session: unknown) {
    const record = asRecord(session);
    this.pageSession = connected && record.workspace === "studio" ? (record as PageSession) : null;
    if (this.pageSession?.activeProject && typeof this.pageSession.activeProject === "string") {
      this.watchProject(this.pageSession.activeProject);
    }
  }

  async handlePageRequest(method: string, params: unknown): Promise<unknown> {
    const p = asRecord(params);
    switch (method) {
      case "studio.info":
        return this.info();
      case "studio.projects.list":
        return listProjects(this.paths);
      case "studio.projects.create": {
        const created = createProject(this.paths, p as unknown as CreateProjectInput);
        this.emit("studio.projects", { projects: listProjects(this.paths) });
        return created;
      }
      case "studio.project.open":
        return this.openProject(assertSlug(p.slug));
      case "studio.session":
        // The page tells us which project is active, the playhead and the selection.
        this.pageSession = { ...(this.pageSession ?? {}), ...p, workspace: "studio" };
        if (typeof p.activeProject === "string") this.watchProject(p.activeProject);
        return { ok: true };
      case "studio.layers.write": {
        const slug = assertSlug(p.slug);
        const result = writeLayers(this.paths, slug, p.layers, typeof p.baseHash === "string" ? p.baseHash : null);
        return result;
      }
      case "studio.project.write": {
        const slug = assertSlug(p.slug);
        return writeProjectFile(this.paths, slug, p.project);
      }
      case "studio.assets.list":
        return {
          assets: listAssets(this.paths, assertSlug(p.slug)),
          library: listLibrary(this.paths),
        };
      case "studio.chat.send":
        return this.chat.send(assertSlug(p.slug), String(p.text ?? ""), asRecord(p.context));
      case "studio.chat.cancel":
        return this.chat.cancel(assertSlug(p.slug));
      case "studio.chat.queue.edit":
        return this.chat.editQueued(assertSlug(p.slug), String(p.messageId ?? ""), String(p.text ?? ""));
      case "studio.chat.queue.remove":
        return this.chat.removeQueued(assertSlug(p.slug), String(p.messageId ?? ""));
      case "studio.chat.queue.now":
        return this.chat.sendQueuedNow(assertSlug(p.slug), String(p.messageId ?? ""));
      case "studio.chat.reset":
        return this.chat.reset(assertSlug(p.slug));
      case "studio.chat.history":
        return this.chat.history(assertSlug(p.slug));
      case "studio.render.cancel":
        return { cancelled: cancelLocalRender() };
      case "studio.file.reveal":
        revealFile(projectFile(this.paths, assertSlug(p.slug), String(p.path ?? "")));
        return { ok: true };
      case "studio.file.open":
        openFile(projectFile(this.paths, assertSlug(p.slug), String(p.path ?? "")));
        return { ok: true };
      case "studio.render.local":
        return this.renderLocal(assertSlug(p.slug), String(p.variant ?? ""), p);
      // Voice providers: the page sends a key once; it never comes back.
      case "studio.voice.settings":
        return voiceSettings();
      case "studio.voice.saveKey":
        return saveKey(p.provider, p.key, Boolean(p.makeDefault));
      case "studio.voice.removeKey":
        return removeKey(p.provider);
      case "studio.voice.setDefault":
        return setDefaultProvider(p.provider);
      case "studio.voice.voices":
        return { voices: await listVoices(String(p.provider) as VoiceProviderId) };
      case "studio.voice.generate": {
        const slug = assertSlug(p.slug);
        const result = await generateVoice(this.paths, slug, p as unknown as GenerateVoiceInput);
        this.emit("studio.assets", { slug });
        return result;
      }
      default:
        throw new StudioError(`Unknown studio method "${method}".`, "unknown_method");
    }
  }

  /** MCP tool calls the helper answers itself (files, not pixels). */
  handleLocalCall(method: string, params: unknown): Promise<unknown> | undefined {
    const p = asRecord(params);
    switch (method) {
      case "studio.local.workspace":
        return Promise.resolve(this.workspaceSummary());
      case "studio.local.create_project":
        return (async () => {
          const created = createProject(this.paths, p as unknown as CreateProjectInput);
          // The chat that asked for it follows the new project.
          this.chat.moveRunningTurn(created.slug);
          this.emit("studio.projects", { projects: listProjects(this.paths) });
          this.emit("studio.open", { slug: created.slug });
          this.watchProject(created.slug);
          return { ...created, dir: projectDir(this.paths, created.slug) };
        })();
      case "studio.local.voice_options":
        return (async () => {
          const options = voiceOptions();
          if (p.provider === "elevenlabs") {
            const voices = await listVoices("elevenlabs");
            return { ...options, elevenlabsVoices: voices.map((v) => ({ id: v.id, name: v.name, description: v.description })) };
          }
          return options;
        })();
      case "studio.local.music_options":
        return Promise.resolve(musicOptions());
      case "studio.local.generate_music":
        return (async () => {
          const slug = assertSlug(p.slug ?? this.pageSession?.activeProject);
          const result = await generateMusic(this.paths, slug, p as unknown as GenerateMusicInput);
          this.emit("studio.assets", { slug });
          return result;
        })();
      case "studio.local.generate_voice":
        return (async () => {
          const slug = assertSlug(p.slug ?? this.pageSession?.activeProject);
          const result = await generateVoice(this.paths, slug, p as unknown as GenerateVoiceInput);
          this.emit("studio.assets", { slug });
          return result;
        })();
      case "studio.local.project_state":
        return (async () => {
          const slug = assertSlug(p.slug);
          this.watchProject(slug);
          await this.rebuild(slug);
          return this.projectStatus(slug);
        })();
      default:
        return undefined;
    }
  }

  // ---------------------------------------------------------------------------

  start() {
    try {
      this.watcher = watch(this.paths.projects, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        this.onProjectFileChange(String(filename));
      });
      this.watcher.on("error", (error) => debugLog(`studio watcher error ${error.message}`));
    } catch (error) {
      debugLog(`studio watcher failed ${(error as Error).message}`);
    }
    try {
      this.libraryWatcher = watch(this.paths.library, { recursive: true }, () => {
        this.debounce("library", () => this.emit("studio.library", {}), 200);
      });
    } catch {}
    void this.getClaude();
  }

  stop() {
    this.watcher?.close();
    this.libraryWatcher?.close();
    this.chat.cancelAll();
  }

  emit(event: string, data: unknown) {
    sendToEditor({ type: "studio.event", event, data });
  }

  async getClaude() {
    if (!this.claude) this.claude = await findClaude();
    return this.claude;
  }

  private debounce(key: string, run: () => void, ms: number) {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        run();
      }, ms),
    );
  }

  private onProjectFileChange(filename: string) {
    const parts = filename.split(/[\\/]/);
    const slug = parts[0];
    const rest = parts.slice(1).join("/");
    if (!slug || !rest) {
      this.debounce("projects", () => this.emit("studio.projects", { projects: listProjects(this.paths) }), 150);
      return;
    }
    if (rest.startsWith(".studio/") || rest.endsWith(".tmp")) return;
    if (rest === "project.json" || rest === "layers.json") {
      this.debounce(`${slug}:project`, () => {
        this.emitProject(slug);
        // Validation of layers depends on scenes; the bundle doesn't change.
      }, 60);
      if (rest === "project.json") {
        this.debounce("projects", () => this.emit("studio.projects", { projects: listProjects(this.paths) }), 150);
      }
      return;
    }
    if (rest.startsWith("assets/") || rest.startsWith("renders/")) {
      this.debounce(`${slug}:assets`, () => this.emit("studio.assets", { slug }), 150);
      return;
    }
    if (/\.(tsx?|jsx?|json|svg|txt)$/.test(rest) && this.watched.has(slug)) {
      this.debounce(`${slug}:bundle`, () => {
        void this.rebuild(slug).then(() => this.emitProject(slug));
      }, 80);
    }
  }

  private emitProject(slug: string) {
    try {
      const state = readProjectState(this.paths, slug);
      this.emit("studio.project", {
        slug,
        project: state.projectRaw,
        layers: state.layersRaw,
        layersHash: state.layersHash,
        projectHash: state.projectHash,
        issues: state.issues,
        scenes: state.scenes,
        projectValid: state.project !== null,
        layersValid: state.layers !== null,
      });
    } catch (error) {
      debugLog(`emitProject ${slug} failed ${(error as Error).message}`);
    }
  }

  watchProject(slug: string) {
    try {
      assertSlug(slug);
    } catch {
      return;
    }
    if (this.watched.has(slug)) return;
    this.watched.add(slug);
    void this.rebuild(slug);
  }

  async rebuild(slug: string): Promise<BundleState> {
    const inFlight = this.building.get(slug);
    if (inFlight) {
      this.rebuildQueued.add(slug);
      return inFlight;
    }
    const promise = (async () => {
      let state = await buildProjectBundle(this.paths, slug, this.bundles.get(slug));
      this.bundles.set(slug, state);
      while (this.rebuildQueued.has(slug)) {
        this.rebuildQueued.delete(slug);
        state = await buildProjectBundle(this.paths, slug, state);
        this.bundles.set(slug, state);
      }
      this.emit("studio.bundle", this.bundleSummary(state));
      return state;
    })();
    this.building.set(slug, promise);
    try {
      return await promise;
    } finally {
      this.building.delete(slug);
    }
  }

  private bundleSummary(state: BundleState) {
    return {
      slug: state.slug,
      revision: state.revision,
      ok: state.ok,
      hasCode: Boolean(state.code),
      errors: state.errors,
      warnings: state.warnings,
      scenes: state.scenes,
      builtAt: state.builtAt,
      durationMs: state.durationMs,
    };
  }

  private async openProject(slug: string) {
    this.watchProject(slug);
    const bundle = await this.rebuild(slug);
    const state = readProjectState(this.paths, slug);
    return {
      slug,
      project: state.projectRaw,
      layers: state.layersRaw,
      layersHash: state.layersHash,
      projectHash: state.projectHash,
      issues: state.issues,
      scenes: state.scenes,
      projectValid: state.project !== null,
      layersValid: state.layers !== null,
      bundle: this.bundleSummary(bundle),
      assets: listAssets(this.paths, slug),
      chat: this.chat.history(slug),
      dir: state.dir,
    };
  }

  projectStatus(slug: string) {
    const state = readProjectState(this.paths, slug);
    const bundle = this.bundles.get(slug);
    return {
      slug,
      dir: state.dir,
      projectValid: state.project !== null,
      layersValid: state.layers !== null,
      issues: state.issues,
      scenes: state.scenes,
      bundle: bundle ? this.bundleSummary(bundle) : null,
      durationInFrames: state.project?.durationInFrames ?? null,
      fps: state.project?.fps ?? null,
      variants: state.project?.variants ?? null,
      tracks:
        state.layers?.tracks.map((track) => ({
          id: track.id,
          name: track.name,
          kind: track.kind,
          clips: track.clips.length,
        })) ?? null,
    };
  }

  private workspaceSummary() {
    const session = getEditorSession();
    return {
      version: PACKAGE_VERSION,
      workspace: this.paths.root,
      projectsDir: this.paths.projects,
      libraryDir: this.paths.library,
      projects: listProjects(this.paths),
      page: this.pageSession ?? (session ? { workspace: asRecord(session).workspace } : null),
    };
  }

  private async info() {
    const claude = await this.getClaude();
    return {
      version: PACKAGE_VERSION,
      workspace: this.paths.root,
      claude,
      allowBash: this.options.allowBash,
      projects: listProjects(this.paths),
      bridgePort: this.options.port,
    };
  }

  private async renderLocal(slug: string, variant: string, params: Record<string, unknown>) {
    const state = readProjectState(this.paths, slug);
    if (!state.project) throw new StudioError("project.json is invalid; fix it before rendering.");
    const chosen = variant || state.project.defaultVariant;
    if (!state.project.variants[chosen]) throw new StudioError(`Unknown variant "${chosen}".`);
    const entryPath = join(this.paths.render, `${slug}.render.tsx`);
    mkdirSync(this.paths.render, { recursive: true });
    writeFileSync(entryPath, buildRenderEntrySource(this.paths, slug, state.scenes));
    const masterGain = typeof params.masterGain === "number" ? params.masterGain : 1;
    return runLocalRender({
      paths: this.paths,
      slug,
      variant: chosen,
      entryPath,
      port: this.options.port,
      masterGain,
      project: state.project,
      layers: state.layersRaw,
      onProgress: (data) => this.emit("studio.render", { slug, variant: chosen, ...data }),
    });
  }
}

export function ensureProjectsDir(paths: WorkspacePaths) {
  if (!existsSync(paths.projects)) mkdirSync(paths.projects, { recursive: true });
}

export const PATH_SEP = sep;
