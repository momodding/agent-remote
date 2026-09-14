import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as net from "node:net";

type ThinkingLevelParam = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

interface BridgeCommandMessage {
	type?: string;
	requestId?: string;
	command?: string;
	args?: unknown;
}

export default function (pi: ExtensionAPI) {
	const socketPath = process.env.AGENTIC_REMOTE_BRIDGE_SOCKET;
	const agentId = process.env.AGENTIC_REMOTE_BRIDGE_AGENT_ID;
	const secret = process.env.AGENTIC_REMOTE_BRIDGE_SECRET;

	if (!socketPath || !agentId || !secret) {
		return;
	}

	let latestCtx: ExtensionContext | null = null;
	let socket: net.Socket | null = null;
	let buffer = "";
	let isConnected = false;
	let shuttingDown = false;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let retryDelayMs = 100;
	let initialSessionId: string | null = null;
	let initialSessionFile: string | null = null;

	function sendFrame(frame: unknown) {
		if (socket && isConnected) {
			try {
				socket.write(JSON.stringify(frame) + "\n");
			} catch {
				// Ignore write failures; socket error handler will clean up
			}
		}
	}

	function sendResult(requestId: string, ok: boolean, error?: string) {
		sendFrame({
			type: "command.result",
			requestId,
			ok,
			...(error ? { error } : {}),
		});
	}

	async function handleCommand(msg: BridgeCommandMessage) {
		const { requestId, command, args } = msg;
		if (!requestId || !command) return;

		try {
			if (command === "prompt") {
				let text = "";
				if (typeof args === "string") {
					text = args;
				} else if (args && typeof args === "object" && "prompt" in args && typeof args.prompt === "string") {
					text = args.prompt;
				}
				pi.sendUserMessage(text);
				sendResult(requestId, true);
				return;
			}

			if (command === "abort") {
				if (latestCtx) {
					latestCtx.abort();
					sendResult(requestId, true);
				} else {
					sendResult(requestId, false, "no active context to abort");
				}
				return;
			}

			if (command === "model") {
				let modelSelector = "";
				if (typeof args === "string") {
					modelSelector = args;
				} else if (args && typeof args === "object") {
					if ("model" in args && typeof args.model === "string") {
						modelSelector = args.model;
					} else if ("name" in args && typeof args.name === "string") {
						modelSelector = args.name;
					}
				}
				if (!modelSelector) {
					sendResult(requestId, false, "missing model selector");
					return;
				}
				if (!latestCtx) {
					sendResult(requestId, false, "no active context");
					return;
				}
				const resolved = latestCtx.models.resolve(modelSelector);
				if (!resolved) {
					sendResult(requestId, false, `failed to resolve model: ${modelSelector}`);
					return;
				}
				const ok = await pi.setModel(resolved);
				if (!ok) {
					sendResult(requestId, false, `failed to set model: ${modelSelector}`);
					return;
				}
				sendResult(requestId, true);
				return;
			}

			if (command === "thinking") {
				let level = "";
				if (typeof args === "string") {
					level = args;
				} else if (args && typeof args === "object") {
					if ("level" in args && typeof args.level === "string") {
						level = args.level;
					} else if ("thinkingLevel" in args && typeof args.thinkingLevel === "string") {
						level = args.thinkingLevel;
					}
				}
				const validLevels = new Set([
					"inherit",
					"off",
					"minimal",
					"low",
					"medium",
					"high",
					"xhigh",
					"max",
				]);
				const normalized = level.toLowerCase();
				if (!validLevels.has(normalized)) {
					sendResult(requestId, false, `invalid thinking level: ${level}`);
					return;
				}
				pi.setThinkingLevel(normalized as ThinkingLevelParam);
				sendResult(requestId, true);
				return;
			}

			sendResult(requestId, false, `unknown command: ${command}`);
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : String(err);
			sendResult(requestId, false, errMsg);
		}
	}

	function sendHello(ctx: ExtensionContext) {
		if (!socket || !isConnected) return;
		const sessionId = ctx.sessionManager.getSessionId() || "";
		const sessionFile = ctx.sessionManager.getSessionFile() || "";
		if (!initialSessionId && sessionId) {
			initialSessionId = sessionId;
		}
		if (!initialSessionFile && sessionFile) {
			initialSessionFile = sessionFile;
		}
		sendFrame({
			type: "hello",
			agentId,
			secret,
			sessionId,
			sessionFile,
			capabilities: ["prompt", "abort", "model", "thinking"],
		});
	}

	function scheduleReconnect() {
		if (shuttingDown || socket || retryTimer) return;
		retryTimer = setTimeout(() => {
			retryTimer = null;
			connect();
		}, retryDelayMs);
		retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
	}

	function connect() {
		if (socket) return;
		socket = net.createConnection(socketPath);

		socket.on("connect", () => {
			isConnected = true;
			retryDelayMs = 100;
			if (latestCtx) {
				sendHello(latestCtx);
			}
		});

		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			if (buffer.length > 2 * 1024 * 1024) {
				buffer = "";
				socket?.destroy();
				return;
			}
			let newlineIdx: number;
			while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newlineIdx).trim();
				buffer = buffer.slice(newlineIdx + 1);
				if (!line) continue;
				try {
					const msg = JSON.parse(line) as BridgeCommandMessage;
					if (msg && msg.type === "command") {
						handleCommand(msg);
					}
				} catch {
					// ignore malformed frame
				}
			}
		});

		socket.on("error", () => {
			socket?.destroy();
		});

		socket.on("close", () => {
			isConnected = false;
			socket = null;
			scheduleReconnect();
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		if (isConnected) {
			sendHello(ctx);
		} else {
			connect();
		}
	});

	pi.on("session_before_switch", async () => {
		return { cancel: true };
	});

	pi.on("session_before_branch", async () => {
		return { cancel: true };
	});

	pi.on("session_switch", async (_event, ctx) => {
		latestCtx = ctx;
		const currentSessionId = ctx.sessionManager.getSessionId() || "";
		const currentSessionFile = ctx.sessionManager.getSessionFile() || "";
		if (
			(initialSessionId && currentSessionId && currentSessionId !== initialSessionId) ||
			(initialSessionFile && currentSessionFile && currentSessionFile !== initialSessionFile)
		) {
			sendFrame({
				type: "lifecycle",
				event: "session_changed",
				sessionId: currentSessionId,
				sessionFile: currentSessionFile,
			});
		} else {
			sendHello(ctx);
		}
	});

	pi.on("session_branch", async (_event, ctx) => {
		latestCtx = ctx;
		const currentSessionId = ctx.sessionManager.getSessionId() || "";
		const currentSessionFile = ctx.sessionManager.getSessionFile() || "";
		if (
			(initialSessionId && currentSessionId && currentSessionId !== initialSessionId) ||
			(initialSessionFile && currentSessionFile && currentSessionFile !== initialSessionFile)
		) {
			sendFrame({
				type: "lifecycle",
				event: "session_changed",
				sessionId: currentSessionId,
				sessionFile: currentSessionFile,
			});
		} else {
			sendHello(ctx);
		}
	});

	pi.on("agent_start", async () => {
		sendFrame({
			type: "lifecycle",
			event: "agent_start",
			state: "working",
		});
	});

	pi.on("turn_start", async (_event, ctx) => {
		latestCtx = ctx;
		sendFrame({
			type: "lifecycle",
			event: "turn_start",
			state: "working",
		});
	});

	pi.on("tool_execution_start", async (event) => {
		sendFrame({
			type: "lifecycle",
			event: "tool_start",
			state: "working",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
		});
	});

	pi.on("tool_execution_end", async (event) => {
		sendFrame({
			type: "lifecycle",
			event: "tool_end",
			state: "working",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			isError: event.isError,
		});
	});

	pi.on("tool_approval_requested", async (event) => {
		sendFrame({
			type: "lifecycle",
			event: "approval_requested",
			state: "needsYou",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			reason: event.reason,
			approvalMode: event.approvalMode,
		});
	});

	pi.on("tool_approval_resolved", async (event) => {
		sendFrame({
			type: "lifecycle",
			event: "approval_resolved",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			approved: event.approved,
			reason: event.reason,
		});
	});

	pi.on("turn_end", async (_event, ctx) => {
		latestCtx = ctx;
		sendFrame({
			type: "lifecycle",
			event: "turn_end",
			state: "idle",
		});
	});

	pi.on("agent_end", async () => {
		sendFrame({
			type: "lifecycle",
			event: "agent_end",
			state: "idle",
		});
	});

	pi.on("session_compact", async (_event, ctx) => {
		latestCtx = ctx;
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		sendFrame({
			type: "lifecycle",
			event: "session_shutdown",
			state: "exited",
		});
		if (retryTimer) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
		if (socket) {
			socket.destroy();
			socket = null;
		}
	});
}
