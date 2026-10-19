import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { debugLog } from "../log.js";
import { atomicWrite, projectDir, StudioError } from "./projects.js";
import { VOICE_KEY_ENV_VARS } from "./voice.js";
import { DETACH_FOR_GROUP_KILL, killTree, resolveCommand, spawnCommand } from "./proc.js";
import type { WorkspacePaths } from "./workspace.js";

export interface ClaudeInfo {
  found: boolean;
  path: string | null;
  version: string | null;
  error?: string;
}

export async function findClaude(): Promise<ClaudeInfo> {
  const override = process.env.SCREENSLICK_STUDIO_CLAUDE;
  const path = override || resolveCommand("claude");
  if (!path) {
    return {
      found: false,
      path: null,
      version: null,
      error: "Claude Code (`claude`) is not on PATH. Install it from https://claude.com/claude-code and log in once.",
    };
  }
  try {
    const result = /\.(cmd|bat)$/i.test(path)
      ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${path}" --version`], {
          encoding: "utf8",
          timeout: 15_000,
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawnSync(path, ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    const version = (result.stdout || "").trim().split(/\s+/)[0] || null;
    return { found: result.status === 0, path, version, error: result.status === 0 ? undefined : (result.stderr || "").slice(0, 400) };
  } catch (error) {
    return { found: false, path, version: null, error: (error as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Chat history model (persisted to projects/<slug>/.studio/chat.json)

export type ChatPart =
  | { type: "text"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      summary: string;
      file?: string;
      status: "running" | "done" | "error";
      error?: string;
      /** Pictures Claude looked at in this step (project-relative, served by /studio/files). */
      images?: string[];
    };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  at: number;
  text?: string;
  parts?: ChatPart[];
  /** user messages: "queued" while waiting for the running turn; assistant: the turn state. */
  status?: "running" | "done" | "error" | "cancelled" | "queued";
  error?: string;
  costUsd?: number;
  durationMs?: number;
  attachments?: string[];
  /** Project files the user pointed at with this message (assets panel, drag and drop). */
  references?: ChatReference[];
}

export interface ChatReference {
  path: string;
  kind: string;
}

interface ChatFile {
  version: 1;
  sessionId: string | null;
  messages: ChatMessage[];
}

const MAX_MESSAGES = 400;

interface Turn {
  /** Project the turn belongs to; changes when Claude creates a project mid-turn. */
  slug: string;
  message: ChatMessage;
  child: ChildProcess;
  cancelled: boolean;
  streamedMessageIds: Set<string>;
  currentStreamMessageId: string | null;
  stderr: string;
  gotResult: boolean;
  retriedWithoutResume: boolean;
}

export interface ChatEngineDeps {
  paths: WorkspacePaths;
  allowBash: boolean;
  emit(event: string, data: unknown): void;
  getClaude(): Promise<ClaudeInfo>;
  getPageContext(): Record<string, unknown> | null;
  /** Extra folders Claude may read and edit (claude --add-dir), e.g. the app's repo. */
  addDirs: string[];
}

/**
 * A Claude Code permission path for a folder and everything in it: `//` anchors at the filesystem
 * root, and Windows paths are matched in POSIX form (C:\\code\\app → //c/code/app/**).
 */
export function absoluteRule(dir: string) {
  let path = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const drive = /^([A-Za-z]):(\/|$)/.exec(path);
  if (drive) path = `/${drive[1].toLowerCase()}${path.slice(2)}`;
  return `/${path.startsWith("/") ? path : `/${path}`}/**`;
}

const BASE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Skill",
  "mcp__screenslick",
];

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;
/** A frame the bridge saved for Claude (see persistAgentFrameResult). */
const SAVED_FRAME = /[\\/]screenslick-frame-[\w-]+\.(png|jpe?g|webp)$/i;

/** Every saved-frame `filePath` in a tool result (text blocks hold JSON, sometimes JSON in JSON). */
function collectFramePaths(value: unknown, out: Set<string>, depth: number) {
  if (depth > 12 || out.size >= 24) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        collectFramePaths(JSON.parse(trimmed), out, depth + 1);
      } catch {}
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFramePaths(item, out, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "filePath" && typeof item === "string" && SAVED_FRAME.test(item)) out.add(item);
    else collectFramePaths(item, out, depth + 1);
  }
}
const MAX_CHAT_FRAMES = 400;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** A message sent while Claude was busy. Its context is captured when it was sent. */
interface QueuedMessage {
  slug: string;
  messageId: string;
  text: string;
  contextText: string;
}

export class ChatEngine {
  private readonly turns = new Map<string, Turn>();
  /** One Claude at a time: messages wait here and run in order when the current turn ends. */
  private readonly queue: QueuedMessage[] = [];

  constructor(private readonly deps: ChatEngineDeps) {}

  private chatPath(slug: string) {
    return join(projectDir(this.deps.paths, slug), ".studio", "chat.json");
  }

  private load(slug: string): ChatFile {
    try {
      const raw = JSON.parse(readFileSync(this.chatPath(slug), "utf8")) as ChatFile;
      if (raw && Array.isArray(raw.messages)) return { version: 1, sessionId: raw.sessionId ?? null, messages: raw.messages };
    } catch {}
    return { version: 1, sessionId: null, messages: [] };
  }

  private save(slug: string, file: ChatFile) {
    const path = this.chatPath(slug);
    mkdirSync(join(path, ".."), { recursive: true });
    const trimmed = { ...file, messages: file.messages.slice(-MAX_MESSAGES) };
    atomicWrite(path, `${JSON.stringify(trimmed, null, 2)}\n`);
  }

  private upsertMessage(slug: string, message: ChatMessage, sessionId?: string | null) {
    const file = this.load(slug);
    const index = file.messages.findIndex((m) => m.id === message.id);
    if (index >= 0) file.messages[index] = message;
    else file.messages.push(message);
    if (sessionId !== undefined) file.sessionId = sessionId;
    this.save(slug, file);
  }

  history(slug: string) {
    const file = this.load(slug);
    // Queued messages from a previous helper run are gone from memory: show them as not sent.
    let stale = false;
    for (const message of file.messages) {
      if (message.status === "queued" && !this.queue.some((q) => q.messageId === message.id)) {
        message.status = "cancelled";
        stale = true;
      }
    }
    if (stale) this.save(slug, file);
    return {
      sessionId: file.sessionId,
      messages: file.messages,
      running: this.turns.has(slug) ? this.turns.get(slug)?.message.id : null,
    };
  }

  reset(slug: string) {
    this.dropQueued(slug);
    this.cancel(slug);
    this.save(slug, { version: 1, sessionId: null, messages: [] });
    this.deps.emit("studio.chat", { slug, kind: "reset" });
    return { ok: true };
  }

  cancel(slug: string) {
    const turn = this.turns.get(slug);
    if (!turn) return { ok: true, cancelled: false };
    turn.cancelled = true;
    killTree(turn.child);
    return { ok: true, cancelled: true };
  }

  /** The running turn (there is at most one). */
  runningSlug(): string | null {
    return [...this.turns.keys()][0] ?? null;
  }

  /**
   * Claude created a new project from a chat in another one: the conversation moves with
   * it, so the new project's chat shows the work in progress and later messages resume
   * the same Claude session there.
   */
  moveRunningTurn(to: string) {
    const from = this.runningSlug();
    if (!from || from === to) return false;
    const turn = this.turns.get(from)!;
    const source = this.load(from);
    const target = this.load(to);
    const moving = source.messages.filter((m) => !target.messages.some((t) => t.id === m.id));
    // The whole conversation goes along when the new chat is empty; otherwise just this turn.
    const userIndex = source.messages.findIndex((m) => m.id === turn.message.id) - 1;
    const turnMessages = source.messages.slice(Math.max(0, userIndex));
    target.messages = target.messages.length === 0 ? moving : [...target.messages, ...turnMessages];
    target.sessionId = source.sessionId;
    this.save(to, target);
    // Leave a pointer in the old chat instead of the moved turn.
    source.messages = source.messages.filter((m) => !turnMessages.some((t) => t.id === m.id));
    source.messages.push({
      id: randomUUID(),
      role: "assistant",
      at: Date.now(),
      status: "done",
      parts: [{ type: "text", text: `Claude created the project **${to}** and moved this conversation there.` }],
    });
    this.save(from, source);
    this.turns.delete(from);
    turn.slug = to;
    this.turns.set(to, turn);
    // Messages queued in the old chat follow the conversation.
    const followers = this.queue.filter((q) => q.slug === from);
    if (followers.length) {
      const src = this.load(from);
      const dst = this.load(to);
      for (const item of followers) {
        const message = src.messages.find((m) => m.id === item.messageId);
        if (message && !dst.messages.some((m) => m.id === message.id)) dst.messages.push(message);
        src.messages = src.messages.filter((m) => m.id !== item.messageId);
        item.slug = to;
      }
      this.save(from, src);
      this.save(to, dst);
    }
    debugLog(`chat moved from ${from} to ${to}`);
    this.deps.emit("studio.chat", { slug: from, kind: "reload" });
    this.deps.emit("studio.chat", { slug: to, kind: "reload" });
    return true;
  }

  cancelAll() {
    for (const slug of [...this.turns.keys()]) this.cancel(slug);
  }

  private buildContext(slug: string, context: Record<string, unknown>) {
    const page = { ...(this.deps.getPageContext() ?? {}), ...context };
    const dir = projectDir(this.deps.paths, slug);
    const lines = [
      `<studio-context>`,
      `You are working inside Motion Studio (ScreenSlick). The user watches the studio page: chat, live preview, timeline. Follow the screenslick-video-studio skill.`,
      `Active project: ${slug} (folder: ${dir})`,
    ];
    if (this.deps.addDirs.length) {
      lines.push(
        `Other folders you can read (e.g. the app's source repo; never change files there, not even with shell commands): ${this.deps.addDirs.join(", ")}`,
      );
    }
    if (typeof page.variant === "string") lines.push(`Variant on screen: ${page.variant}`);
    if (typeof page.playheadFrame === "number") {
      const fps = typeof page.fps === "number" ? page.fps : 30;
      lines.push(`Playhead: frame ${page.playheadFrame} (${(page.playheadFrame / fps).toFixed(2)} s)`);
    }
    if (Array.isArray(page.selectedClipIds) && page.selectedClipIds.length > 0) {
      lines.push(`Selected clips: ${page.selectedClipIds.join(", ")}`);
    }
    const attachments = Array.isArray(context.attachments) ? context.attachments.filter((a): a is string => typeof a === "string") : [];
    for (const attachment of attachments) {
      lines.push(`Attached image (open it with Read): ${join(dir, attachment)}`);
    }
    const references = (Array.isArray(context.references) ? context.references : [])
      .map((value) => asRecord(value))
      .filter((ref) => typeof ref.path === "string" && !String(ref.path).includes(".."))
      .slice(0, 12)
      .map((ref) => ({ path: String(ref.path), kind: typeof ref.kind === "string" ? ref.kind : "other" }));
    if (references.length) {
      lines.push(`The user is pointing at these project files (paths relative to the project folder):`);
      for (const ref of references) {
        const hint = ref.kind === "image" ? " (an image: open it with Read to see it)" : ref.kind === "audio" ? " (audio: use the listen/media tools)" : "";
        lines.push(`- ${ref.path} [${ref.kind}]${hint}`);
      }
      lines.push(`"Here", "now" or "at the playhead" means the playhead frame above.`);
    }
    lines.push(`</studio-context>`);
    return { text: lines.join("\n"), attachments, references };
  }

  async send(slug: string, text: string, context: Record<string, unknown>) {
    const trimmed = text.trim();
    if (!trimmed) throw new StudioError("Type a message first.", "empty");
    const claude = await this.deps.getClaude();
    if (!claude.found || !claude.path) {
      throw new StudioError(claude.error ?? "Claude Code was not found.", "no_claude");
    }

    // The context (playhead, selection, pointed-at files) is taken now, when the user sent it.
    const { text: contextText, attachments, references } = this.buildContext(slug, context);
    const busy = this.turns.size > 0 || this.queue.length > 0;
    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: "user",
      at: Date.now(),
      text: trimmed,
      attachments: attachments.length ? attachments : undefined,
      references: references.length ? references : undefined,
      ...(busy ? { status: "queued" as const } : {}),
    };
    this.upsertMessage(slug, userMessage);
    this.deps.emit("studio.chat", { slug, kind: "user", message: userMessage });

    if (busy) {
      // One Claude at a time: two runs writing the same workspace overwrite each other.
      this.queue.push({ slug, messageId: userMessage.id, text: trimmed, contextText });
      debugLog(`chat ${slug}: queued (${this.queue.length} waiting)`);
      return { queued: true, position: this.queue.length, userMessageId: userMessage.id };
    }
    const turnId = this.startTurn(slug, claude.path, contextText, trimmed);
    return { turnId, userMessageId: userMessage.id };
  }

  private startTurn(slug: string, claudePath: string, contextText: string, text: string) {
    const assistant: ChatMessage = {
      id: randomUUID(),
      role: "assistant",
      at: Date.now(),
      parts: [],
      status: "running",
    };
    this.upsertMessage(slug, assistant);
    this.deps.emit("studio.chat", { slug, kind: "start", message: assistant });
    this.startProcess(slug, claudePath, `${contextText}\n\n${text}`, assistant, this.load(slug).sessionId, false);
    return assistant.id;
  }

  /** Start the next queued message once nothing is running. */
  private async drain() {
    if (this.turns.size > 0) return;
    const next = this.queue.shift();
    if (!next) return;
    const file = this.load(next.slug);
    const message = file.messages.find((m) => m.id === next.messageId);
    if (message) {
      // It moves down to where Claude's answer will start, so each answer follows its message.
      delete message.status;
      message.at = Date.now();
      file.messages = [...file.messages.filter((m) => m.id !== message.id), message];
      this.save(next.slug, file);
      this.deps.emit("studio.chat", { slug: next.slug, kind: "dequeue", message });
    }
    const claude = await this.deps.getClaude();
    if (!claude.found || !claude.path || this.turns.size > 0) {
      this.queue.unshift(next);
      return;
    }
    debugLog(`chat ${next.slug}: starting queued message (${this.queue.length} still waiting)`);
    this.startTurn(next.slug, claude.path, next.contextText, next.text);
  }

  /** The waiting messages, in order (for the page). */
  queued() {
    return this.queue.map((q, index) => ({ slug: q.slug, messageId: q.messageId, position: index + 1 }));
  }

  /** Edit a message that hasn't started yet. */
  editQueued(slug: string, messageId: string, text: string) {
    const item = this.queue.find((q) => q.slug === slug && q.messageId === messageId);
    const trimmed = text.trim();
    if (!item) throw new StudioError("That message already started or was removed.", "not_queued");
    if (!trimmed) throw new StudioError("Type a message first.", "empty");
    item.text = trimmed;
    const file = this.load(slug);
    const message = file.messages.find((m) => m.id === messageId);
    if (message) {
      message.text = trimmed;
      this.save(slug, file);
      this.deps.emit("studio.chat", { slug, kind: "update", message });
    }
    return { ok: true };
  }

  /** Take a message out of the queue (it never reaches Claude). */
  removeQueued(slug: string, messageId: string) {
    const index = this.queue.findIndex((q) => q.slug === slug && q.messageId === messageId);
    if (index < 0) return { ok: true, removed: false };
    this.queue.splice(index, 1);
    const file = this.load(slug);
    file.messages = file.messages.filter((m) => m.id !== messageId);
    this.save(slug, file);
    this.deps.emit("studio.chat", { slug, kind: "remove", messageId });
    return { ok: true, removed: true };
  }

  /** "Stop and send this now": move it to the front and stop the running turn. */
  sendQueuedNow(slug: string, messageId: string) {
    const index = this.queue.findIndex((q) => q.slug === slug && q.messageId === messageId);
    if (index < 0) throw new StudioError("That message already started or was removed.", "not_queued");
    const [item] = this.queue.splice(index, 1);
    this.queue.unshift(item);
    const running = this.runningSlug();
    if (running) this.cancel(running);
    else void this.drain();
    return { ok: true };
  }

  private dropQueued(slug: string) {
    for (const item of this.queue.filter((q) => q.slug === slug)) this.removeQueued(slug, item.messageId);
  }

  private startProcess(
    slug: string,
    claudePath: string,
    prompt: string,
    assistant: ChatMessage,
    sessionId: string | null,
    isRetry: boolean,
  ) {
    const tools = this.deps.allowBash ? [...BASE_TOOLS, "Bash"] : BASE_TOOLS;
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      tools.join(","),
      "--mcp-config",
      this.deps.paths.mcpConfig,
    ];
    for (const dir of this.deps.addDirs) args.push("--add-dir", dir);
    // Extra folders are for reading (e.g. the user's app repo): block Claude's file-edit tools there.
    if (this.deps.addDirs.length) {
      args.push("--disallowedTools", ...this.deps.addDirs.map((dir) => `Edit(${absoluteRule(dir)})`));
    }
    if (sessionId) args.push("--resume", sessionId);

    const child = spawnCommand(claudePath, args, {
      cwd: this.deps.paths.root,
      env: {
        // Voice-provider keys stay in the helper: Claude (and the tools it runs) never get them.
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !VOICE_KEY_ENV_VARS.includes(name))),
        SCREENSLICK_STUDIO_WORKSPACE: this.deps.paths.root,
        SCREENSLICK_STUDIO_PROJECT: slug,
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: DETACH_FOR_GROUP_KILL,
    });

    const turn: Turn = {
      slug,
      message: assistant,
      child,
      cancelled: false,
      streamedMessageIds: new Set(),
      currentStreamMessageId: null,
      stderr: "",
      gotResult: false,
      retriedWithoutResume: isRetry,
    };
    this.turns.set(slug, turn);

    child.stdin?.on("error", () => undefined);
    child.stdin?.end(prompt);

    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.handleLine(turn, line);
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      turn.stderr = (turn.stderr + chunk).slice(-4000);
    });
    child.on("error", (error) => {
      turn.stderr = `${turn.stderr}\n${error.message}`.slice(-4000);
    });
    child.on("close", (code) => {
      if (buffer.trim()) this.handleLine(turn, buffer.trim());
      const slug = turn.slug; // may have moved to a new project mid-turn
      this.turns.delete(slug);
      const noSession = /no conversation found|session.*not found/i.test(turn.stderr);
      if (!turn.cancelled && !turn.gotResult && noSession && !turn.retriedWithoutResume) {
        // The saved session is gone (e.g. cleared); start a fresh one.
        debugLog(`chat ${slug}: resume failed, starting a new session`);
        const file = this.load(slug);
        file.sessionId = null;
        this.save(slug, file);
        this.startProcess(slug, claudePath, prompt, assistant, null, true);
        return;
      }
      if (turn.cancelled) {
        assistant.status = "cancelled";
      } else if (!turn.gotResult) {
        assistant.status = "error";
        assistant.error =
          turn.stderr.trim().split(/\r?\n/).slice(-6).join("\n") || `Claude Code exited with code ${code}.`;
      }
      this.finishRunningTools(assistant, assistant.status === "done" ? "done" : "error");
      this.upsertMessage(slug, assistant);
      this.deps.emit("studio.chat", { slug, kind: "done", message: assistant });
      void this.drain().catch((error) => debugLog(`chat queue: ${error instanceof Error ? error.message : String(error)}`));
    });
  }

  private finishRunningTools(message: ChatMessage, status: "done" | "error") {
    for (const part of message.parts ?? []) {
      if (part.type === "tool" && part.status === "running") part.status = status;
    }
  }

  private relativeFile(slug: string, file: unknown) {
    if (typeof file !== "string") return undefined;
    const dir = projectDir(this.deps.paths, slug);
    const rel = relative(dir, file);
    if (!rel.startsWith("..") && !rel.includes(`..${sep}`)) return rel.split(sep).join("/");
    const fromRoot = relative(this.deps.paths.root, file);
    return fromRoot.startsWith("..") ? file : fromRoot.split(sep).join("/");
  }

  /**
   * The pictures a step showed Claude, so the chat can show them too: frames the studio captured
   * (copied out of the bridge's scratch folder, which it prunes) and images Claude read from the project.
   */
  private imagesFor(slug: string, part: Extract<ChatPart, { type: "tool" }>, content: unknown): string[] {
    try {
      if (part.name === "Read") {
        return part.file && IMAGE_FILE.test(part.file) && !isAbsolute(part.file) && !part.file.startsWith("..") ? [part.file] : [];
      }
      if (!part.name.startsWith("mcp__screenslick__")) return [];
      const found = new Set<string>();
      collectFramePaths(content, found, 0);
      if (found.size === 0) return [];
      const dir = join(projectDir(this.deps.paths, slug), ".studio", "attachments", "claude-frames");
      mkdirSync(dir, { recursive: true });
      const out: string[] = [];
      for (const source of [...found].slice(0, 24)) {
        if (!existsSync(source)) continue;
        const name = basename(source);
        copyFileSync(source, join(dir, name));
        out.push(`.studio/attachments/claude-frames/${name}`);
      }
      this.pruneFrames(dir);
      return out;
    } catch (error) {
      debugLog(`chat images ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private pruneFrames(dir: string) {
    const files = readdirSync(dir)
      .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of files.slice(MAX_CHAT_FRAMES)) rmSync(join(dir, old.name), { force: true });
  }

  private toolSummary(slug: string, name: string, input: Record<string, unknown>) {
    const file = this.relativeFile(slug, input.file_path ?? input.path ?? input.notebook_path);
    switch (name) {
      case "Write":
        return { summary: `Wrote ${file ?? "a file"}`, file };
      case "Edit":
      case "MultiEdit":
        return { summary: `Edited ${file ?? "a file"}`, file };
      case "Read":
        return { summary: `Read ${file ?? "a file"}`, file };
      case "Glob":
      case "Grep":
        return { summary: `${name} ${String(input.pattern ?? "").slice(0, 60)}` };
      case "Bash":
        return { summary: `Ran ${String(input.description ?? input.command ?? "").slice(0, 80)}` };
      case "WebSearch":
        return { summary: `Searched “${String(input.query ?? "").slice(0, 60)}”` };
      case "WebFetch":
        return { summary: `Fetched ${String(input.url ?? "").slice(0, 80)}` };
      case "TodoWrite":
        return { summary: "Updated the plan" };
      case "Skill":
        return { summary: `Loaded skill ${String(input.skill ?? input.name ?? "")}` };
      default:
        if (name.startsWith("mcp__screenslick__")) {
          return { summary: name.replace("mcp__screenslick__screenslick_", "").replace(/_/g, " ") };
        }
        return { summary: name };
    }
  }

  private appendText(turn: Turn, text: string) {
    const parts = (turn.message.parts ??= []);
    const last = parts[parts.length - 1];
    if (last && last.type === "text") last.text += text;
    else parts.push({ type: "text", text });
  }

  private handleLine(turn: Turn, line: string) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const { slug } = turn;
    switch (event.type) {
      case "system": {
        if (event.subtype === "init" && typeof event.session_id === "string") {
          const file = this.load(slug);
          if (file.sessionId !== event.session_id) {
            file.sessionId = event.session_id;
            this.save(slug, file);
          }
        }
        return;
      }
      case "stream_event": {
        const inner = asRecord(event.event);
        if (inner.type === "message_start") {
          const id = asRecord(inner.message).id;
          if (typeof id === "string") {
            turn.currentStreamMessageId = id;
            turn.streamedMessageIds.add(id);
          }
          // Separate consecutive assistant messages with a paragraph break.
          const parts = turn.message.parts ?? [];
          const last = parts[parts.length - 1];
          if (last && last.type === "text" && last.text && !last.text.endsWith("\n\n")) {
            last.text += "\n\n";
          }
        } else if (inner.type === "content_block_delta") {
          const delta = asRecord(inner.delta);
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            this.appendText(turn, delta.text);
            this.deps.emit("studio.chat", { slug, kind: "text", messageId: turn.message.id, text: delta.text });
          }
        }
        return;
      }
      case "assistant": {
        const message = asRecord(event.message);
        const id = typeof message.id === "string" ? message.id : null;
        const content = Array.isArray(message.content) ? message.content : [];
        for (const blockRaw of content) {
          const block = asRecord(blockRaw);
          if (block.type === "text" && typeof block.text === "string" && !(id && turn.streamedMessageIds.has(id))) {
            this.appendText(turn, block.text);
            this.deps.emit("studio.chat", { slug, kind: "text", messageId: turn.message.id, text: block.text });
          }
          if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
            const parts = (turn.message.parts ??= []);
            if (parts.some((part) => part.type === "tool" && part.id === block.id)) continue;
            const { summary, file } = this.toolSummary(slug, block.name, asRecord(block.input));
            const part: ChatPart = { type: "tool", id: block.id, name: block.name, summary, file, status: "running" };
            parts.push(part);
            this.deps.emit("studio.chat", { slug, kind: "tool", messageId: turn.message.id, part });
          }
        }
        this.upsertMessage(slug, turn.message);
        return;
      }
      case "user": {
        const message = asRecord(event.message);
        const content = Array.isArray(message.content) ? message.content : [];
        for (const blockRaw of content) {
          const block = asRecord(blockRaw);
          if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
          const part = turn.message.parts?.find(
            (candidate) => candidate.type === "tool" && candidate.id === block.tool_use_id,
          );
          if (!part || part.type !== "tool") continue;
          part.status = block.is_error ? "error" : "done";
          if (!block.is_error) {
            const images = this.imagesFor(slug, part, block.content);
            if (images.length > 0) part.images = images;
          }
          if (block.is_error) {
            const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
            part.error = text.slice(0, 400);
          }
          this.deps.emit("studio.chat", { slug, kind: "tool_result", messageId: turn.message.id, part });
          if (FILE_TOOLS.has(part.name) && part.status === "done") {
            this.deps.emit("studio.chat", { slug, kind: "file", messageId: turn.message.id, file: part.file });
          }
        }
        return;
      }
      case "result": {
        turn.gotResult = true;
        const isError = Boolean(event.is_error) || (typeof event.subtype === "string" && event.subtype !== "success");
        turn.message.status = isError ? "error" : "done";
        if (isError) {
          turn.message.error =
            typeof event.result === "string" && event.result
              ? event.result.slice(0, 1200)
              : `Claude stopped (${String(event.subtype)}).`;
        }
        if (typeof event.total_cost_usd === "number") turn.message.costUsd = event.total_cost_usd;
        if (typeof event.duration_ms === "number") turn.message.durationMs = event.duration_ms;
        if (typeof event.session_id === "string") {
          const file = this.load(slug);
          file.sessionId = event.session_id;
          this.save(slug, file);
        }
        // If nothing was streamed (very short answers), fall back to the final text.
        const hasText = (turn.message.parts ?? []).some((part) => part.type === "text" && part.text.trim());
        if (!hasText && !isError && typeof event.result === "string" && event.result.trim()) {
          this.appendText(turn, event.result);
        }
        return;
      }
      default:
        return;
    }
  }
}
