import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { getConfig, WS_PATH } from "./config.js";
import { debugLog } from "./log.js";

type JsonObject = Record<string, unknown>;

// Editor calls (export, capture, generation) can run long; keep the WS and HTTP
// fallback paths on the same ceiling. The status probe is a quick liveness check.
const EDITOR_CALL_TIMEOUT_MS = 120_000;
const BRIDGE_PROBE_TIMEOUT_MS = 5_000;

interface PendingEditorRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

let serverPromise: Promise<Server> | null = null;
let activeEditor: WebSocketConnection | null = null;
let editorSession: unknown = null;
let editorRequestCounter = 0;
const pendingEditorRequests = new Map<string, PendingEditorRequest>();

function isLocalRequest(request: IncomingMessage) {
  const address = request.socket.remoteAddress;
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function createAcceptKey(key: string) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function sendJsonResponse(
  response: ServerResponse,
  status: number,
  body: unknown,
) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readJsonBody(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject;
}

function persistAgentFrameResult(result: unknown) {
  if (!result || typeof result !== "object") return result;
  const frame = result as JsonObject;
  const dataUrl = frame.dataUrl;
  if (typeof dataUrl !== "string") return result;

  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(dataUrl);
  if (!match) return result;

  const mimeType = match[1] || String(frame.mimeType ?? "image/png");
  const extension = mimeType.includes("jpeg")
    ? "jpg"
    : mimeType.includes("webp")
      ? "webp"
      : "png";
  const directory = join(process.cwd(), ".tmp", "agent-frames");
  mkdirSync(directory, { recursive: true });
  const filename = `screenslick-frame-${Date.now()}-${randomUUID()}.${extension}`;
  const filePath = join(directory, filename);
  const bytes = Buffer.from(match[2], "base64");
  writeFileSync(filePath, bytes);

  const rest = { ...frame };
  delete rest.dataUrl;
  return {
    ...rest,
    mimeType,
    size: bytes.length,
    filePath,
    filename,
    dataUrlSaved: true,
  };
}

class WebSocketConnection {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  closed = false;

  constructor(private socket: Duplex) {
    socket.on("data", (chunk: Buffer) => this.read(chunk));
    socket.on("close", () => this.close());
    socket.on("error", (error) => {
      debugLog(`editor socket error ${error.message}`);
      this.close();
    });
  }

  sendJson(value: unknown) {
    this.sendText(JSON.stringify(value));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    debugLog("editor disconnected");
    if (activeEditor === this) {
      activeEditor = null;
      editorSession = null;
      for (const [id, pending] of pendingEditorRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("ScreenSlick editor disconnected."));
        pendingEditorRequests.delete(id);
      }
    }
    this.socket.destroy();
  }

  private sendText(text: string) {
    if (this.closed) return;
    const payload = Buffer.from(text);
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length]);
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  private read(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        length = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      const maskLength = masked ? 4 : 0;
      const frameEnd = offset + maskLength + length;
      if (this.buffer.length < frameEnd) return;

      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskLength;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(frameEnd);

      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }

      // Control frames (0x8-0xF) are never fragmented and may be interleaved
      // between data fragments.
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.sendPong(payload);
        continue;
      }
      if (opcode === 0xa) {
        continue; // pong; nothing to do
      }

      // Data frames: 0x1 text, 0x2 binary, 0x0 continuation. Reassemble across
      // fragments so large editor responses (export MP4, captured PNG) survive a
      // multi-frame send.
      if (opcode === 0x1 || opcode === 0x2) {
        this.fragments = [payload];
        this.fragmentOpcode = opcode;
      } else if (opcode === 0x0) {
        if (this.fragments.length === 0) {
          debugLog("unexpected continuation frame with no message in progress");
          this.close();
          return;
        }
        this.fragments.push(payload);
      } else {
        debugLog(`ignoring unsupported ws opcode 0x${opcode.toString(16)}`);
        continue;
      }

      if (!fin) continue; // more fragments to come

      const message = Buffer.concat(this.fragments);
      const completedOpcode = this.fragmentOpcode;
      this.fragments = [];
      this.fragmentOpcode = 0;
      if (completedOpcode === 0x1) this.handleText(message.toString("utf8"));
    }
  }

  private sendPong(payload: Buffer) {
    if (this.closed) return;
    // Control frame payloads are capped at 125 bytes; echo what fits.
    const length = Math.min(payload.length, 125);
    const header = Buffer.from([0x8a, length]);
    this.socket.write(Buffer.concat([header, payload.subarray(0, length)]));
  }

  private handleText(text: string) {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    if (
      message &&
      typeof message === "object" &&
      (message as JsonObject).type === "hello"
    ) {
      editorSession = (message as JsonObject).session;
      debugLog(`editor hello ${JSON.stringify(editorSession)}`);
      return;
    }

    const response = message as {
      id?: unknown;
      result?: unknown;
      error?: { message?: unknown };
    };
    if (typeof response.id !== "string") return;
    const pending = pendingEditorRequests.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingEditorRequests.delete(response.id);
    if (response.error) {
      pending.reject(new Error(String(response.error.message ?? "Editor error.")));
    } else {
      pending.resolve(response.result);
    }
  }
}

export function getBridgeStatus() {
  const { port } = getConfig();
  return {
    ok: true,
    connected: Boolean(activeEditor && !activeEditor.closed),
    port,
    path: WS_PATH,
    session: editorSession,
  };
}

async function fetchBridgeStatus() {
  const { bridgeBaseUrl } = getConfig();
  const response = await fetch(`${bridgeBaseUrl}/status`, {
    signal: AbortSignal.timeout(BRIDGE_PROBE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Bridge status failed: ${response.status}`);
  return response.json();
}

async function callExternalBridge(method: string, params: unknown) {
  const { bridgeBaseUrl } = getConfig();
  const response = await fetch(`${bridgeBaseUrl}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(EDITOR_CALL_TIMEOUT_MS),
  });
  const payload = (await response.json()) as {
    result?: unknown;
    error?: string;
  };
  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? `Bridge call failed: ${response.status}`);
  }
  return payload.result;
}

export async function callEditor(method: string, params: unknown) {
  await ensureBridge();

  if (!activeEditor || activeEditor.closed) {
    if (!serverPromise) {
      return callExternalBridge(method, params);
    }
    throw new Error(
      "No active ScreenSlick editor session. Open the editor and enable Agent.",
    );
  }

  const id = `agent_${++editorRequestCounter}`;
  activeEditor.sendJson({ id, method, params });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingEditorRequests.delete(id);
      reject(new Error(`ScreenSlick editor did not answer "${method}" in time.`));
    }, EDITOR_CALL_TIMEOUT_MS);
    pendingEditorRequests.set(id, { resolve, reject, timer });
  });
}

export async function ensureBridge() {
  if (!serverPromise) {
    try {
      return await fetchBridgeStatus();
    } catch {}
  }

  if (serverPromise) {
    await serverPromise;
    return getBridgeStatus();
  }

  serverPromise = startBridgeServer();
  try {
    await serverPromise;
  } catch (error) {
    // Starting our own bridge failed, most likely because another MCP instance
    // already bound the port (EADDRINUSE). Clear the rejected promise so future
    // calls re-probe, and fall back to whoever owns the bridge right now.
    serverPromise = null;
    debugLog(
      `bridge startup failed, falling back to existing bridge ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return await fetchBridgeStatus();
  }
  return getBridgeStatus();
}

async function startBridgeServer() {
  const { host, port } = getConfig();
  const server = createServer(async (request, response) => {
    if (!isLocalRequest(request)) {
      sendJsonResponse(response, 403, { error: "Forbidden" });
      return;
    }

    try {
      if (request.method === "GET" && request.url === "/status") {
        sendJsonResponse(response, 200, getBridgeStatus());
        return;
      }

      if (request.method === "POST" && request.url === "/call") {
        const body = await readJsonBody(request);
        const method = String(body.method ?? "");
        const result = persistAgentFrameResult(
          await callEditor(method, body.params),
        );
        sendJsonResponse(response, 200, { result });
        return;
      }

      sendJsonResponse(response, 404, { error: "Not found" });
    } catch (error) {
      sendJsonResponse(response, 500, {
        error:
          error instanceof Error ? error.message : "Unknown bridge error.",
      });
    }
  });

  server.on("upgrade", (request, socket, head) => {
    debugLog(`upgrade url=${request.url} remote=${request.socket.remoteAddress}`);
    if (
      request.url !== WS_PATH ||
      !isLocalRequest(request) ||
      request.headers.upgrade?.toLowerCase() !== "websocket"
    ) {
      socket.destroy();
      return;
    }

    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${createAcceptKey(key)}`,
        "\r\n",
      ].join("\r\n"),
    );

    if (head.length > 0) socket.unshift(head);

    activeEditor?.close();
    activeEditor = new WebSocketConnection(socket);
    debugLog("editor connected");
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    debugLog(`bridge server error ${error.message}`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      debugLog(`bridge listening ${host}:${port}${WS_PATH}`);
      resolve();
    });
  });

  return server;
}
