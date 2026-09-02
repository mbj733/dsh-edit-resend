import { SessionLogOffset } from "@deepseek-ai/dsh-session";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
//#region src/shared.ts
/** Same-origin endpoint owned by the Edit & Resend host plugin. */
const EDIT_RESEND_PATH = "/edit-resend";
/** Timeline view order: between Trajectory (10) and Prompt Studio (20). */
const VIEW_ORDER = 15;
//#endregion
//#region src/host.ts
/** Stable Cordis plugin name. */
const name = "edit-resend";
/** Public services used by the branch transaction and timeline projection. */
const inject = [
	"sessions",
	"agents",
	"sessionQuery",
	"workspaceRegistry",
	"webServer"
];
function pairVersionEffect(sourceSessionId, effect) {
	return {
		effect: {
			...effect,
			id: crypto.randomUUID()
		},
		inverseSessionId: sourceSessionId,
		time: Date.now()
	};
}
function isTextualBlock(block) {
	return block?.type === "text" || block?.type === "reasoning";
}
function userText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
function cloneUser(message, content = structuredClone(message.content)) {
	return Object.freeze({
		id: crypto.randomUUID(),
		role: "user",
		content: Object.freeze(content),
		source: Object.freeze({ kind: "user" })
	});
}
function replaceTextBlock(content, blockIndex, text) {
	const block = content[blockIndex];
	if (!isTextualBlock(block)) throw new Error("所选内容块不是可编辑文本。");
	return content.map((candidate, index) => index === blockIndex ? {
		...candidate,
		text
	} : structuredClone(candidate));
}
/** Fold complete turn brackets plus the optional still-open tail turn. */
function foldTurns(events) {
	const closed = [];
	let current;
	for (const event of events) {
		if (event.type === "turn/start") {
			if (current !== void 0) {}
			current = {
				turn: event.data.turn,
				startSeq: event.seq,
				assistants: []
			};
			continue;
		}
		if (current === void 0) continue;
		if (event.type === "user/message" && current.user === void 0 && event.data.source.kind === "user") {
			current.user = event;
			continue;
		}
		if (event.type === "assistant/message" && event.data.turn === current.turn) {
			current.assistants.push(event);
			continue;
		}
		if (event.type === "turn/end" && event.data.turn === current.turn) {
			closed.push({
				...current,
				endSeq: event.seq
			});
			current = void 0;
		}
	}
	if (current !== void 0 && (current.user !== void 0 || current.assistants.length > 0)) return {
		closed,
		open: { ...current }
	};
	return { closed };
}
function editableMessages(closed, open) {
	const result = [];
	const pushUser = (event, turnNumber, openFlag) => {
		for (const [blockIndex, block] of event.data.content.entries()) {
			if (block.type !== "text") continue;
			result.push({
				key: String(event.seq) + ":" + String(blockIndex),
				turn: turnNumber,
				eventSeq: event.seq,
				blockIndex,
				kind: "user",
				text: block.text,
				time: event.time,
				...openFlag ? { open: true } : {}
			});
		}
	};
	const pushAssistant = (event, openFlag) => {
		for (const [blockIndex, block] of event.data.message.content.entries()) {
			if (!isTextualBlock(block)) continue;
			result.push({
				key: String(event.seq) + ":" + String(blockIndex),
				turn: event.data.turn,
				eventSeq: event.seq,
				blockIndex,
				kind: block.type === "reasoning" ? "assistant.reasoning" : "assistant.response",
				text: block.text,
				time: event.time,
				...openFlag ? { open: true } : {}
			});
		}
	};
	for (const turn of closed) {
		if (turn.user !== void 0) pushUser(turn.user, turn.turn, false);
		for (const event of turn.assistants) pushAssistant(event, false);
	}
	if (open !== void 0) {
		if (open.user !== void 0) pushUser(open.user, open.turn, true);
		for (const event of open.assistants) pushAssistant(event, true);
	}
	return result;
}
function retryableTurns(closed, open) {
	const base = closed.flatMap((turn) => turn.user === void 0 ? [] : [{
		turn: turn.turn,
		userEventSeq: turn.user.seq,
		preview: userText(turn.user.data),
		time: turn.user.time
	}]);
	if (open?.user !== void 0) base.push({
		turn: open.turn,
		userEventSeq: open.user.seq,
		preview: userText(open.user.data),
		time: open.user.time,
		open: true
	});
	return base;
}
function downstreamUsers(closed, start) {
	return closed.slice(start).flatMap((turn) => turn.user === void 0 ? [] : [cloneUser(turn.user.data)]);
}
function assistantReplacement(event, blockIndex, text) {
	const replaced = replaceTextBlock(event.data.message.content, blockIndex, text).filter((block) => block.type === "text" || block.type === "reasoning");
	return Object.freeze({
		id: crypto.randomUUID(),
		role: "assistant",
		content: Object.freeze(replaced),
		source: Object.freeze({
			kind: "model",
			provider: event.data.message.source.provider,
			model: event.data.message.source.model
		})
	});
}
function editPlan(operation, closed, open) {
	if (open !== void 0 && open.user !== void 0 && open.user.seq === operation.eventSeq) {
		const turn = open;
		const user = open.user;
		const before = user.data.content[operation.blockIndex];
		if (before?.type !== "text") throw new Error("所选用户消息块不是文本。");
		const edited = cloneUser(user.data, replaceTextBlock(user.data.content, operation.blockIndex, operation.text));
		return {
			boundary: turn.startSeq - 1,
			version: pairVersionEffect(operation.sessionId, {
				operation: "edit",
				cascade: "truncate",
				targetTurn: turn.turn,
				targetEventSeq: user.seq,
				targetBlockIndex: operation.blockIndex,
				blockKind: "user",
				before: before.text,
				after: operation.text
			}),
			queuedUsers: [edited]
		};
	}
	const turnIndex = closed.findIndex((turn) => operation.eventSeq > turn.startSeq && operation.eventSeq < turn.endSeq);
	const turn = closed[turnIndex];
	if (turn === void 0) throw new Error("所选消息不属于已落定回合。");
	const event = turn.user?.seq === operation.eventSeq ? turn.user : turn.assistants.find((candidate) => candidate.seq === operation.eventSeq);
	if (event === void 0) throw new Error("所选消息不存在或不可编辑。");
	if (event.type === "user/message") {
		const before = event.data.content[operation.blockIndex];
		if (before?.type !== "text") throw new Error("所选用户消息块不是文本。");
		const edited = cloneUser(event.data, replaceTextBlock(event.data.content, operation.blockIndex, operation.text));
		const later = operation.cascade === "preserve" ? downstreamUsers(closed, turnIndex + 1) : [];
		return {
			boundary: turn.startSeq - 1,
			version: pairVersionEffect(operation.sessionId, {
				operation: "edit",
				cascade: operation.cascade,
				targetTurn: turn.turn,
				targetEventSeq: event.seq,
				targetBlockIndex: operation.blockIndex,
				blockKind: "user",
				before: before.text,
				after: operation.text
			}),
			queuedUsers: [edited, ...later]
		};
	}
	const before = event.data.message.content[operation.blockIndex];
	if (!isTextualBlock(before)) throw new Error("所选助手消息块不是文本或思考。");
	const blockKind = before.type === "reasoning" ? "assistant.reasoning" : "assistant.response";
	if (turn.user === void 0) throw new Error("所选助手消息没有可重建的用户输入。");
	return {
		boundary: turn.startSeq - 1,
		version: pairVersionEffect(operation.sessionId, {
			operation: "edit",
			cascade: operation.cascade,
			targetTurn: turn.turn,
			targetEventSeq: event.seq,
			targetBlockIndex: operation.blockIndex,
			blockKind,
			before: before.text,
			after: operation.text
		}),
		manualTurn: {
			turn: turn.turn,
			user: cloneUser(turn.user.data),
			assistant: assistantReplacement(event, operation.blockIndex, operation.text)
		},
		queuedUsers: operation.cascade === "preserve" ? downstreamUsers(closed, turnIndex + 1) : []
	};
}
function retryPlan(sessionId, turnNumber, cascade, closed, open) {
	if (open?.turn === turnNumber && open.user !== void 0) return {
		boundary: open.startSeq - 1,
		version: pairVersionEffect(sessionId, {
			operation: "retry",
			cascade: "truncate",
			targetTurn: open.turn,
			targetEventSeq: open.user.seq
		}),
		queuedUsers: [cloneUser(open.user.data)]
	};
	const turnIndex = closed.findIndex((turn) => turn.turn === turnNumber);
	const turn = closed[turnIndex];
	if (turn?.user === void 0) throw new Error("所选回合没有可重放的用户输入。");
	return {
		boundary: turn.startSeq - 1,
		version: pairVersionEffect(sessionId, {
			operation: "retry",
			cascade,
			targetTurn: turn.turn,
			targetEventSeq: turn.user.seq
		}),
		queuedUsers: cascade === "preserve" ? downstreamUsers(closed, turnIndex) : [cloneUser(turn.user.data)]
	};
}
function rerollPlan(sessionId, closed) {
	for (let index = closed.length - 1; index >= 0; index -= 1) {
		const turn = closed[index];
		if (turn?.user === void 0) continue;
		const target = turn.assistants.findLast((event) => event.data.message.content.some(isTextualBlock));
		if (target === void 0) continue;
		return {
			boundary: turn.startSeq - 1,
			version: pairVersionEffect(sessionId, {
				operation: "reroll",
				cascade: "truncate",
				targetTurn: turn.turn,
				targetEventSeq: target.seq
			}),
			queuedUsers: [cloneUser(turn.user.data)]
		};
	}
	throw new Error("当前会话没有可重生成的已落定助手回复。");
}
function planOperation(operation, events) {
	const { closed, open } = foldTurns(events);
	switch (operation.action) {
		case "edit": return editPlan(operation, closed, open);
		case "reroll": return rerollPlan(operation.sessionId, closed);
		case "retry": return retryPlan(operation.sessionId, operation.turn, operation.cascade, closed, open);
	}
}
function agentOptions(events, fallback) {
	const config = events.findLast((event) => event.type === "request/header")?.data.header.config;
	const provider = config?.provider ?? fallback?.provider;
	const model = config?.model ?? fallback?.model;
	if (provider === void 0 || provider.length === 0 || model === void 0 || model.length === 0) throw new Error("无法从会话历史解析模型路由。");
	const maxTokens = config?.maxTokens ?? fallback?.maxTokens;
	return {
		provider,
		model,
		...maxTokens === void 0 ? {} : { maxTokens }
	};
}
/** Whether the version operation targets the still-open (in-flight or aborted) tail turn. */
function targetsOpenTail(operation, events) {
	const { open } = foldTurns(events);
	if (open === void 0) return false;
	if (operation.action === "edit") return open.user?.seq === operation.eventSeq;
	if (operation.action === "retry") return operation.turn === open.turn;
	return false;
}
async function withSourceAgent(ctx, sessionId, operation, job) {
	let handle;
	let agent = ctx.agents.get(sessionId);
	if (agent === void 0) {
		const snapshot = await ctx.sessionQuery.readSession(sessionId);
		handle = await ctx.agents.resume({
			resumeSessionId: sessionId,
			agentOptions: agentOptions(snapshot.events)
		});
		agent = handle.agent;
	}
	try {
		if (agent.status === "idle") return await agent.runMaintenance(async () => job(agent));
		if (targetsOpenTail(operation, agent.session.snapshotEvents())) {
			agent.cancel({ kind: "user" });
			await agent.whenIdle();
			return await agent.runMaintenance(async () => job(agent));
		}
		return await job(agent);
	} finally {
		await handle?.dispose();
	}
}
function inheritedSeed(source, boundary) {
	if (boundary === -1) return [];
	const events = source.snapshotEvents();
	const boundaryEvent = events[boundary];
	if (boundary < 0 || boundaryEvent === void 0 || boundaryEvent.seq !== boundary) throw new Error("分支边界不是连续会话事件。");
	return events.slice(0, boundary + 1);
}
function appendLogSeedEvent(events, type, data) {
	events.push({
		type,
		seq: events.length,
		time: Date.now(),
		data
	});
}
function appendSurfaceSeedEvent(events, type, data, intent) {
	events.push({
		type,
		seq: events.length,
		time: Date.now(),
		data,
		surfaceOp: intent.surfaceOp,
		...intent.sourceEventSeqs === void 0 ? {} : { sourceEventSeqs: intent.sourceEventSeqs }
	});
}
function appendManualTurn(events, manual) {
	const { turn, user, assistant } = manual;
	appendLogSeedEvent(events, "turn/start", { turn });
	appendSurfaceSeedEvent(events, "user/message", user, { surfaceOp: "append" });
	appendLogSeedEvent(events, "step/start", {
		turn,
		step: 1
	});
	appendSurfaceSeedEvent(events, "assistant/message", {
		turn,
		step: 1,
		message: assistant
	}, {
		surfaceOp: "append",
		sourceEventSeqs: []
	});
	appendLogSeedEvent(events, "step/end", {
		turn,
		step: 1
	});
	appendLogSeedEvent(events, "turn/end", {
		turn,
		reason: { kind: "completed" }
	});
}
function versionSeed(source, plan) {
	const events = inheritedSeed(source, plan.boundary);
	const inheritedLength = events.length;
	if (plan.manualTurn !== void 0) appendManualTurn(events, plan.manualTurn);
	return {
		events,
		inheritedLength
	};
}
function sessionPreset(session) {
	const header = session.header;
	if (header.agentPreset !== void 0) return header.agentPreset;
	const events = session.snapshotEvents();
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type === "agent-preset/selected" && event.data?.agentPreset !== void 0) return event.data.agentPreset;
	}
}
async function createVersionAgent(ctx, source, childId, plan, options) {
	const seed = versionSeed(source, plan);
	const presets = ctx.get("agentPresets");
	const presetId = sessionPreset(source);
	let agentPreset;
	let setup;
	if (presets !== void 0 && presetId !== void 0) {
		const resolved = (await presets.resolve(presetId)).id;
		agentPreset = resolved;
		setup = async (agentCtx) => {
			await presets.mount(agentCtx, resolved);
		};
	}
	const child = await ctx.agents.create({
		sessionId: childId,
		seed: seed.events,
		inheritedEventCount: SessionLogOffset(seed.inheritedLength),
		meta: {
			...source.header.cwd === void 0 ? {} : { cwd: source.header.cwd },
			parentSession: source.id,
			isSeeded: true,
			...agentPreset === void 0 ? {} : { agentPreset }
		},
		agentOptions: options,
		...setup === void 0 ? {} : { setup }
	});
	try {
		await ctx.sessions.flush(child.agent.session);
		return child;
	} catch (error) {
		await child.dispose();
		throw error;
	}
}
function sourceWorkspace(ctx, sessionId) {
	return ctx.workspaceRegistry.list().find((workspace) => workspace.sessionIds.includes(sessionId));
}
async function recoverOperation(inverses) {
	const failures = [];
	for (const inverse of inverses.reverse()) try {
		await inverse();
	} catch (error) {
		failures.push(error);
	}
	if (failures.length > 0) throw new AggregateError(failures, "版本操作恢复失败。");
}
function storePath() {
	const home = process.env.DSH_HOME ?? process.cwd();
	return join(home, "storages", "dsh-edit-resend", "versions.json");
}
function loadStore() {
	try {
		const raw = readFileSync(storePath(), "utf8");
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}
function saveStore(store) {
	const path = storePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(store, null, 2));
}
function rememberVersion(childId, version) {
	const store = loadStore();
	store[childId] = version;
	saveStore(store);
}
/** Best-effort: carry the source session's title over to the new version. */
async function inheritTitle(ctx, sourceId, childSession) {
	const sessionTitle = ctx.get("sessionTitle");
	if (sessionTitle === void 0) return;
	const snapshot = await ctx.sessionQuery.readTitle(sourceId);
	if (snapshot?.title != null && snapshot.title.trim().length > 0) sessionTitle.rename(childSession, snapshot.title);
}
async function runOperation(ctx, operation) {
	const sourceId = sessionIdOf(operation.sessionId);
	return withSourceAgent(ctx, sourceId, operation, async (source) => {
		const childId = sessionIdOf("session-" + crypto.randomUUID());
		const inverses = [];
		try {
			const events = source.session.snapshotEvents();
			const plan = planOperation(operation, events);
			const options = agentOptions(events, source.options);
			const child = await createVersionAgent(ctx, source.session, childId, plan, options);
			inverses.push(() => child.dispose());
			const workspace = sourceWorkspace(ctx, sourceId);
			if (workspace !== void 0) {
				await workspace.attachSession(childId);
				inverses.push(() => workspace.detachSession(childId));
			}
			for (const message of plan.queuedUsers) child.agent.followup(message);
			rememberVersion(childId, plan.version);
			inverses.length = 0;
			return {
				sessionId: childId,
				queuedTurns: plan.queuedUsers.length
			};
		} catch (error) {
			try {
				await recoverOperation(inverses);
			} catch (recoveryError) {
				throw new AggregateError([error, recoveryError], "版本操作及其恢复均失败。");
			}
			throw error;
		}
	});
}
/**
* Post-edit finalization, run OFF the request's critical path: inherit the
* source title and archive (soft-delete) the previous version so the sidebar
* keeps a single conversation. Fire-and-forget; failures only warn.
*/
async function finalizeEdit(ctx, sourceId, childId) {
	try {
		const childSession = ctx.agents.get(childId)?.session;
		if (childSession !== void 0) await inheritTitle(ctx, sourceId, childSession);
	} catch (error) {
		ctx.logger.warn("edit-resend: inherit title failed: " + (error instanceof Error ? error.message : String(error)));
	}
	try {
		await ctx.workspaceRegistry.archiveSession(sourceId);
	} catch (error) {
		ctx.logger.warn("edit-resend: archive source failed: " + (error instanceof Error ? error.message : String(error)));
	}
}
function ownVersion(header, store) {
	return store[header.id];
}
function flattenLineage(root, descendants) {
	const result = [{
		record: root,
		depth: 0
	}];
	const visit = (nodes, depth) => {
		const ordered = [...nodes].sort((left, right) => left.session.header.createdAt - right.session.header.createdAt || String(left.session.header.id).localeCompare(String(right.session.header.id)));
		for (const node of ordered) {
			result.push({
				record: node.session,
				depth
			});
			visit(node.descendants, depth + 1);
		}
	};
	visit(descendants, 1);
	return result;
}
/** Projection cache: one entry per viewed session, keyed by log-tail seq + version-store size. */
const timelineCache = /* @__PURE__ */ new Map();
async function timeline(ctx, sessionId) {
	const store = loadStore();
	const storeSize = Object.keys(store).length;
	const liveEvents = ctx.agents.get(sessionId)?.session.snapshotEvents();
	if (liveEvents !== void 0) {
		const lastSeq = liveEvents.at(-1)?.seq ?? -1;
		const cached = timelineCache.get(sessionId);
		if (cached !== void 0 && cached.lastSeq === lastSeq && cached.storeSize === storeSize) return cached.timeline;
	}
	const targetTrace = await ctx.sessionQuery.traceSession(sessionId);
	const rootId = targetTrace.complete ? targetTrace.root.header.id : targetTrace.ancestors.at(-1)?.header.id ?? sessionId;
	const rootTrace = rootId === sessionId ? targetTrace : await ctx.sessionQuery.traceSession(rootId);
	const lineage = flattenLineage(rootTrace.target, rootTrace.descendants);
	const recordsById = new Map(lineage.map(({ record }) => [record.header.id, record]));
	const currentPath = /* @__PURE__ */ new Set();
	let pathId = sessionId;
	while (pathId !== void 0 && !currentPath.has(pathId)) {
		currentPath.add(pathId);
		pathId = recordsById.get(pathId)?.header.parentSession;
	}
	const versions = lineage.map(({ record, depth }) => {
		const header = record.header;
		const version = ownVersion(header, store);
		return {
			sessionId: header.id,
			...header.parentSession === void 0 ? {} : { parentSessionId: header.parentSession },
			...version === void 0 ? {} : {
				effectId: version.effect.id,
				inverseSessionId: version.inverseSessionId
			},
			createdAt: version?.time ?? header.createdAt,
			depth,
			current: header.id === sessionId,
			onCurrentEffectPath: currentPath.has(header.id),
			...version === void 0 ? {} : {
				operation: version.effect.operation,
				cascade: version.effect.cascade,
				targetTurn: version.effect.targetTurn,
				...version.effect.blockKind === void 0 ? {} : { blockKind: version.effect.blockKind },
				...version.effect.before === void 0 ? {} : { before: version.effect.before },
				...version.effect.after === void 0 ? {} : { after: version.effect.after }
			}
		};
	});
	const effectIds = /* @__PURE__ */ new Set();
	for (const version of versions) {
		if (version.effectId === void 0) continue;
		if (effectIds.has(version.effectId)) throw new Error("版本效果重复。");
		effectIds.add(version.effectId);
	}
	const versionsById = new Map(versions.map((version) => [version.sessionId, version]));
	const undoStack = [];
	let undoCursor = versionsById.get(sessionId);
	while (undoCursor?.inverseSessionId !== void 0) {
		const inverseId = undoCursor.inverseSessionId;
		if (undoStack.includes(inverseId)) throw new Error("版本效果逆链包含循环。");
		if (!versionsById.has(inverseId)) throw new Error("恢复目标不在可见版本树中。");
		undoStack.push(inverseId);
		undoCursor = versionsById.get(inverseId);
	}
	const redoSessionIds = versions.filter((version) => version.inverseSessionId === sessionId).map((version) => version.sessionId);
	const currentEvents = liveEvents ?? (await ctx.sessionQuery.readSession(sessionId)).events;
	const { closed, open } = foldTurns(currentEvents);
	const result = {
		sessionId,
		messages: editableMessages(closed, open),
		retryableTurns: retryableTurns(closed, open),
		versions,
		undoStack,
		redoSessionIds
	};
	const lastSeq = currentEvents.at(-1)?.seq ?? -1;
	if (timelineCache.size >= 64) {
		const oldest = timelineCache.keys().next().value;
		if (oldest !== void 0) timelineCache.delete(oldest);
	}
	timelineCache.set(sessionId, {
		lastSeq,
		storeSize,
		timeline: result
	});
	return result;
}
function objectValue(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("请求体必须是 JSON 对象。");
	return value;
}
function sessionIdOf(value) {
	if (typeof value !== "string" || value.length === 0) throw new TypeError("sessionId 必须是非空字符串。");
	return value;
}
function integerOf(value, name) {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(name + " 必须是非负安全整数。");
	return value;
}
function cascadeOf(value) {
	if (value !== "truncate" && value !== "preserve") throw new TypeError("cascade 必须是 truncate 或 preserve。");
	return value;
}
function decodeOperation(value) {
	const record = objectValue(value);
	const sessionId = sessionIdOf(record["sessionId"]);
	switch (record["action"]) {
		case "edit":
			if (typeof record["text"] !== "string") throw new TypeError("text 必须是字符串。");
			return {
				action: "edit",
				sessionId,
				eventSeq: integerOf(record["eventSeq"], "eventSeq"),
				blockIndex: integerOf(record["blockIndex"], "blockIndex"),
				text: record["text"],
				cascade: cascadeOf(record["cascade"])
			};
		case "reroll": return {
			action: "reroll",
			sessionId
		};
		case "retry": return {
			action: "retry",
			sessionId,
			turn: integerOf(record["turn"], "turn"),
			cascade: cascadeOf(record["cascade"])
		};
		default: throw new TypeError("action 必须是 edit、reroll 或 retry。");
	}
}
function requestJson(request) {
	return new Promise((resolve, reject) => {
		const decoder = new TextDecoder();
		let text = "";
		request.on("data", (chunk) => {
			text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		});
		request.on("end", () => {
			try {
				text += decoder.decode();
				resolve(JSON.parse(text));
			} catch (error) {
				reject(error);
			}
		});
		request.on("error", reject);
	});
}
function respondJson(response, status, value) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	response.end(JSON.stringify(value));
}
async function handleRoute(ctx, request, response) {
	try {
		if (request.method === "GET") {
			respondJson(response, 200, await timeline(ctx, sessionIdOf(new URL(request.url ?? "/edit-resend", "http://edit-resend.local").searchParams.get("sessionId"))));
			return;
		}
		if (request.method === "POST") {
			const operation = decodeOperation(await requestJson(request));
			const result = await runOperation(ctx, operation);
			finalizeEdit(ctx, sessionIdOf(operation.sessionId), sessionIdOf(result.sessionId));
			respondJson(response, 200, result);
			return;
		}
		response.writeHead(405);
		response.end();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		respondJson(response, error instanceof TypeError ? 400 : 409, { error: message });
	}
}
/** Register the reversible route contribution. */
function apply(ctx) {
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: EDIT_RESEND_PATH,
		handler: (request, response) => handleRoute(ctx, request, response)
	}), "edit-resend: HTTP route");
}
//#endregion
export { EDIT_RESEND_PATH, VIEW_ORDER, apply, foldTurns, inject, name, planOperation };
