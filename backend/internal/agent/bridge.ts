import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as net from "node:net";
type ThinkingLevelParam = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

interface BridgeCommandMessage {
	type?: string;
	requestId?: string;
	command?: string;
	args?: unknown;
}

interface ParsedContentItem {
	type: "text" | "thinking" | "toolCall" | "other";
	text?: string;
	thinking?: string;
	id?: string;
	toolCallId?: string;
	name?: string;
	arguments?: unknown;
}

interface FileMentionFile {
	path?: string;
}

interface SessionEntryMessage {
	role?: string;
	content?: unknown;
	files?: FileMentionFile[];
	toolCallId?: string;
	toolName?: string;
	command?: string;
	output?: string;
	isError?: boolean;
	aborted?: boolean;
	stopReason?: string;
	display?: boolean;
}

interface SessionEntryLike {
	id?: string;
	type?: string;
	display?: boolean;
	content?: unknown;
	message?: SessionEntryMessage;
}

export default function (pi: ExtensionAPI) {
	const socketPath = process.env.AGENTIC_REMOTE_BRIDGE_SOCKET;
	const agentId = process.env.AGENTIC_REMOTE_BRIDGE_AGENT_ID;
	const secret = process.env.AGENTIC_REMOTE_BRIDGE_SECRET;
	try {
		fs.appendFileSync("/tmp/bridge_debug.log", `[${new Date().toISOString()}] bridge.ts init: socketPath=${socketPath}, agentId=${agentId}, secret=${secret}\n`);
	} catch {}

	if (!socketPath || !agentId || !secret) {
		return;
	}

	let latestCtx: ExtensionContext | null = null;
	let socket: net.Socket | null = null;
	let buffer = "";
	let isConnected = false;
	let shuttingDown = false;
	let retryTimer: NodeJS.Timeout | number | null = null;
	let retryDelayMs = 100;
	let initialSessionId: string | null = null;
	let initialSessionFile: string | null = null;
	const emittedEntryIds = new Set<string>();

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
				} else if (args && typeof args === "object" && "prompt" in args && typeof (args as { prompt: unknown }).prompt === "string") {
					text = (args as { prompt: string }).prompt;
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
				let modelStr = "";
				if (typeof args === "string") {
					modelStr = args;
				} else if (args && typeof args === "object" && "model" in args && typeof (args as { model: unknown }).model === "string") {
					modelStr = (args as { model: string }).model;
				}
				if (!modelStr) {
					sendResult(requestId, false, "model argument missing");
					return;
				}
				if (!latestCtx) {
					sendResult(requestId, false, "no active context to set model");
					return;
				}
				const resolved = latestCtx.models.resolve(modelStr);
				const target =
					resolved ||
					latestCtx.models
						.list()
						.find(
							(m) =>
								`${m.provider}/${m.id}` === modelStr ||
								m.id === modelStr ||
								m.name === modelStr,
						);
				if (!target) {
					sendResult(requestId, false, `model ${modelStr} not found in available models`);
					return;
				}
				const success = await pi.setModel(target);
				if (success) {
					sendResult(requestId, true);
					const meta = getModelMetadata(latestCtx);
					sendFrame({
						type: "metadata",
						...meta,
					});
				} else {
					sendResult(requestId, false, "setModel returned false");
				}
				return;
			}

			if (command === "thinking") {
				let levelStr = "";
				if (typeof args === "string") {
					levelStr = args;
				} else if (args && typeof args === "object") {
					if ("level" in args && typeof args.level === "string") {
						levelStr = args.level;
					} else if ("thinkingLevel" in args && typeof args.thinkingLevel === "string") {
						levelStr = args.thinkingLevel;
					}
				}
				if (!levelStr) {
					sendResult(requestId, false, "thinking level missing");
					return;
				}
				pi.setThinkingLevel(levelStr as ThinkingLevelParam);
				sendResult(requestId, true);
				const meta = getModelMetadata(latestCtx);
				sendFrame({
					type: "metadata",
					...meta,
				});
				return;
			}
			sendResult(requestId, false, `unknown command: ${command}`);
		} catch (err: unknown) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			sendResult(requestId, false, errorMsg);
		}
	}

	function extractTextAndContents(content: unknown): { text: string; contents: ParsedContentItem[] } {
		if (typeof content === "string") {
			return { text: content, contents: [] };
		}
		if (Array.isArray(content)) {
			let fullText = "";
			const items: ParsedContentItem[] = [];
			for (const item of content) {
				if (!item || typeof item !== "object") continue;
				const record = item as Record<string, unknown>;
				const itemType = typeof record.type === "string" ? record.type : "";
				if (itemType === "text" && typeof record.text === "string") {
					fullText += record.text;
					items.push({ type: "text", text: record.text });
				} else if (itemType === "thinking") {
					const thinkingText =
						typeof record.thinking === "string"
							? record.thinking
							: typeof record.text === "string"
								? record.text
								: "";
					items.push({ type: "thinking", thinking: thinkingText, text: thinkingText });
				} else if (itemType === "toolCall") {
					items.push({
						type: "toolCall",
						id: typeof record.id === "string" ? record.id : undefined,
						toolCallId: typeof record.toolCallId === "string" ? record.toolCallId : undefined,
						name: typeof record.name === "string" ? record.name : undefined,
						arguments: record.arguments,
					});
				} else if (typeof record.text === "string") {
					fullText += record.text;
					items.push({ type: "text", text: record.text });
				}
			}
			return { text: fullText, contents: items };
		}
		if (content && typeof content === "object") {
			const record = content as Record<string, unknown>;
			if (typeof record.text === "string") {
				return { text: record.text, contents: [{ type: "text", text: record.text }] };
			}
		}
		return { text: "", contents: [] };
	}

	function emitSemanticEvents(entry: SessionEntryLike) {
		if (!entry || !entry.id) return;
		const id = String(entry.id);

		if (entry.type === "custom_message") {
			const isDisplayed = Boolean(entry.display || (entry.message && entry.message.display));
			if (!isDisplayed) return;
			let text = extractTextAndContents(entry.content).text;
			if (!text && entry.message) {
				text = extractTextAndContents(entry.message.content).text;
			}
			if (!text) return;
			sendFrame({
				type: "semantic",
				event: "message.system",
				eventId: `${id}:message`,
				messageId: id,
				text,
			});
			return;
		}

		if (entry.type !== "message" || !entry.message) {
			return;
		}

		const msg = entry.message;
		const isDisplayed = Boolean(entry.display || msg.display);
		if ((msg.role === "custom" || msg.role === "hookMessage") && !isDisplayed) {
			return;
		}

		let { text, contents } = extractTextAndContents(msg.content);
		if (msg.role === "fileMention" && !text && Array.isArray(msg.files)) {
			text = msg.files
				.map((f) => (f && typeof f.path === "string" ? f.path : ""))
				.filter(Boolean)
				.join("\n");
		}

		if (msg.role === "toolResult") {
			if (!msg.toolCallId) return;
			sendFrame({
				type: "semantic",
				event: "tool.result",
				eventId: `${id}:tool-result:${msg.toolCallId}`,
				messageId: id,
				toolCallId: String(msg.toolCallId),
				text,
				toolOutput: text,
				isError: Boolean(msg.isError),
			});
			return;
		}

		if (msg.role === "bashExecution" || msg.role === "pythonExecution") {
			sendFrame({
				type: "semantic",
				event: "tool.call",
				eventId: `${id}:execution:call`,
				messageId: id,
				toolName: msg.role,
				toolInput: { command: msg.command || "" },
			});
			sendFrame({
				type: "semantic",
				event: "tool.result",
				eventId: `${id}:execution:result`,
				messageId: id,
				toolName: msg.role,
				text: msg.output || "",
				toolOutput: msg.output || "",
				isError: Boolean(msg.isError),
			});
			return;
		}

		const role =
			!msg.role || msg.role === "user"
				? "user"
				: msg.role === "fileMention" || msg.role === "custom" || msg.role === "hookMessage"
					? "system"
					: msg.role;

		const isAborted =
			Boolean(msg.aborted) ||
			(typeof msg.stopReason === "string" && msg.stopReason.toLowerCase() === "aborted");

		if (role !== "assistant" || contents.length === 0) {
			if (!text && !(role === "assistant" && isAborted)) {
				return;
			}
			sendFrame({
				type: "semantic",
				event: `message.${role}`,
				eventId: `${id}:message`,
				messageId: id,
				text,
				isError: Boolean(msg.isError),
				aborted: isAborted,
			});
			return;
		}

		let hasAssistant = false;
		for (let index = 0; index < contents.length; index++) {
			const content = contents[index];
			if (content.type === "text") {
				if (content.text || isAborted) {
					sendFrame({
						type: "semantic",
						event: "message.assistant",
						eventId: `${id}:message:${index}`,
						messageId: id,
						text: content.text || "",
						isError: Boolean(msg.isError),
						aborted: isAborted,
					});
					hasAssistant = true;
				}
			} else if (content.type === "thinking") {
				const thinkingText = content.text || content.thinking || "";
				if (thinkingText) {
					sendFrame({
						type: "semantic",
						event: "message.thinking",
						eventId: `${id}:thinking:${index}`,
						messageId: id,
						text: thinkingText,
					});
				}
			} else if (content.type === "toolCall") {
				const toolCallId = content.id || content.toolCallId || "";
				if (toolCallId) {
					sendFrame({
						type: "semantic",
						event: "tool.call",
						eventId: `${id}:tool-call:${toolCallId}`,
						messageId: id,
						toolCallId: String(toolCallId),
						toolName: content.name || "",
						toolInput: content.arguments,
					});
				}
			}
		}

		if (isAborted && !hasAssistant) {
			sendFrame({
				type: "semantic",
				event: "message.assistant",
				eventId: `${id}:message`,
				messageId: id,
				isError: Boolean(msg.isError),
				aborted: true,
			});
		}
	}
	function emitNewEntries(sessionManager?: ExtensionContext["sessionManager"]) {
		if (!sessionManager || typeof sessionManager.getEntries !== "function") return;
		const entries = sessionManager.getEntries();
		if (!Array.isArray(entries)) return;
		for (const entry of entries) {
			if (!entry || typeof entry !== "object") continue;
			const record = entry as SessionEntryLike;
			if (!record.id) continue;
			if (emittedEntryIds.has(record.id)) continue;
			emittedEntryIds.add(record.id);
			emitSemanticEvents(record);
		}
	}

	function getModelMetadata(ctx?: ExtensionContext) {
		const context = ctx || latestCtx;
		let currentModel: { id: string; name: string; provider: string } | undefined;
		let availableModels: Array<{ id: string; name: string; provider: string }> = [];

		if (context?.models) {
			if (typeof context.models.current === "function") {
				const curr = context.models.current();
				if (curr) {
					currentModel = {
						id: curr.id,
						name: curr.name || curr.id,
						provider: curr.provider || "",
					};
				}
			}
			if (typeof context.models.list === "function") {
				const list = context.models.list() || [];
				availableModels = list.map((m) => ({
					id: m.id,
					name: m.name || m.id,
					provider: m.provider || "",
				}));
			}
		}

		let thinking: string | undefined;
		if (typeof pi.getThinkingLevel === "function") {
			thinking = pi.getThinkingLevel();
		}

		const availableThinking = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

		return {
			model: currentModel,
			thinking,
			availableModels,
			availableThinking,
		};
	}

	function sendHello(ctx: ExtensionContext) {
		if (!socket || !isConnected) return;
		const sessionId = ctx.sessionManager?.getSessionId?.() || "";
		const sessionFile = ctx.sessionManager?.getSessionFile?.() || "";
		if (!initialSessionId && sessionId) {
			initialSessionId = sessionId;
		}
		if (!initialSessionFile && sessionFile) {
			initialSessionFile = sessionFile;
		}
		const meta = getModelMetadata(ctx);
		try {
			fs.appendFileSync("/tmp/bridge_debug.log", `[${new Date().toISOString()}] sendHello: sessionId=${sessionId}, sessionFile=${sessionFile}\n`);
		} catch {}
		sendFrame({
			type: "hello",
			agentId,
			secret,
			sessionId,
			sessionFile,
			capabilities: ["prompt", "abort", "model", "thinking"],
			...meta,
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
		if (socket || !socketPath) return;
		try {
			fs.appendFileSync("/tmp/bridge_debug.log", `[${new Date().toISOString()}] connect() starting to ${socketPath}\n`);
		} catch {}
		socket = net.createConnection({ path: socketPath });
		socket.on("connect", () => {
			try {
				fs.appendFileSync("/tmp/bridge_debug.log", `[${new Date().toISOString()}] socket onConnect, latestCtx=${!!latestCtx}\n`);
			} catch {}
			isConnected = true;
			retryDelayMs = 100;
			if (latestCtx) {
				sendHello(latestCtx);
				emitNewEntries(latestCtx.sessionManager);
			}
		});

		socket.on("data", (chunk) => {
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

		socket.on("error", (err) => {
			try {
				fs.appendFileSync("/tmp/bridge_debug.log", `[${new Date().toISOString()}] socket error: ${err}\n`);
			} catch {}
			socket?.destroy();
		});

		socket.on("close", () => {
			try {
				fs.appendFileSync("/tmp/bridge_debug.log", `[${new Date().toISOString()}] socket close\n`);
			} catch {}
			isConnected = false;
			socket = null;
			scheduleReconnect();
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			fs.appendFileSync("/tmp/bridge_debug.log", `[${new Date().toISOString()}] session_start event fired\n`);
		} catch {}
		latestCtx = ctx;
		emittedEntryIds.clear();
		emitNewEntries(ctx.sessionManager);
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
		emittedEntryIds.clear();
		emitNewEntries(ctx.sessionManager);
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
		emitNewEntries(ctx.sessionManager);
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

	pi.on("agent_start", async (_event, ctx) => {
		latestCtx = ctx;
		emitNewEntries(ctx.sessionManager);
		sendFrame({
			type: "lifecycle",
			event: "agent_start",
			state: "working",
		});
	});
	pi.on("turn_start", async (_event, ctx) => {
		latestCtx = ctx;
		emitNewEntries(ctx.sessionManager);
		sendFrame({
			type: "lifecycle",
			event: "turn_start",
			state: "working",
		});
	});
	pi.on("message_end", async (_event, ctx) => {
		latestCtx = ctx;
		emitNewEntries(ctx.sessionManager);
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
		emitNewEntries(ctx.sessionManager);
	});
	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		emitNewEntries(ctx.sessionManager);
		sendFrame({
			type: "lifecycle",
			event: "agent_end",
			state: "idle",
		});
	});
	pi.on("session_compact", async (_event, ctx) => {
		latestCtx = ctx;
		emitNewEntries(ctx.sessionManager);
	});
	pi.on("session_shutdown", async () => {
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
