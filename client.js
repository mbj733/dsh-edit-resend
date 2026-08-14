window.__ModuleLoader__.load({
	id: "dsh-edit-resend",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_runtime_client = require("@deepseek-ai/dsh-client-runtime/client");
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/shared.ts
		/** Same-origin endpoint owned by the Edit & Resend host plugin. */
		const EDIT_RESEND_PATH = "/edit-resend";
		//#endregion
		//#region src/client/controller.ts
		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}
		function objectValue(value, label) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(label + " 不是对象");
			return value;
		}
		function stringValue(value, label) {
			if (typeof value !== "string") throw new TypeError(label + " 不是字符串");
			return value;
		}
		function numberValue(value, label) {
			if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(label + " 不是数字");
			return value;
		}
		function booleanValue(value, label) {
			if (typeof value !== "boolean") throw new TypeError(label + " 不是布尔值");
			return value;
		}
		function blockKind(value) {
			if (value !== "user" && value !== "assistant.reasoning" && value !== "assistant.response") throw new TypeError("消息块类型无效");
			return value;
		}
		function decodeMessage(value, index) {
			const row = objectValue(value, "messages[" + String(index) + "]");
			return {
				key: stringValue(row["key"], "消息 key"),
				turn: numberValue(row["turn"], "消息 turn"),
				eventSeq: numberValue(row["eventSeq"], "消息 eventSeq"),
				blockIndex: numberValue(row["blockIndex"], "消息 blockIndex"),
				kind: blockKind(row["kind"]),
				text: stringValue(row["text"], "消息 text"),
				time: numberValue(row["time"], "消息 time"),
				...row["open"] === void 0 ? {} : { open: booleanValue(row["open"], "消息 open") }
			};
		}
		function decodeRetryable(value, index) {
			const row = objectValue(value, "retryableTurns[" + String(index) + "]");
			return {
				turn: numberValue(row["turn"], "回合 turn"),
				userEventSeq: numberValue(row["userEventSeq"], "回合 userEventSeq"),
				preview: stringValue(row["preview"], "回合 preview"),
				time: numberValue(row["time"], "回合 time"),
				...row["open"] === void 0 ? {} : { open: booleanValue(row["open"], "回合 open") }
			};
		}
		function optionalOperation(value) {
			if (value === void 0) return void 0;
			if (value === "edit" || value === "reroll" || value === "retry") return value;
			throw new TypeError("版本 operation 无效");
		}
		function decodeVersion(value, index) {
			const row = objectValue(value, "versions[" + String(index) + "]");
			const operation = optionalOperation(row["operation"]);
			const cascade = row["cascade"];
			if (cascade !== void 0 && cascade !== "truncate" && cascade !== "preserve") throw new TypeError("版本 cascade 无效");
			const kind = row["blockKind"] === void 0 ? void 0 : blockKind(row["blockKind"]);
			return {
				sessionId: stringValue(row["sessionId"], "版本 sessionId"),
				...row["parentSessionId"] === void 0 ? {} : { parentSessionId: stringValue(row["parentSessionId"], "版本 parentSessionId") },
				...row["effectId"] === void 0 ? {} : { effectId: stringValue(row["effectId"], "版本 effectId") },
				...row["inverseSessionId"] === void 0 ? {} : { inverseSessionId: stringValue(row["inverseSessionId"], "版本 inverseSessionId") },
				createdAt: numberValue(row["createdAt"], "版本 createdAt"),
				depth: numberValue(row["depth"], "版本 depth"),
				current: booleanValue(row["current"], "版本 current"),
				onCurrentEffectPath: booleanValue(row["onCurrentEffectPath"], "版本 onCurrentEffectPath"),
				...operation === void 0 ? {} : { operation },
				...cascade === void 0 ? {} : { cascade },
				...row["targetTurn"] === void 0 ? {} : { targetTurn: numberValue(row["targetTurn"], "版本 targetTurn") },
				...kind === void 0 ? {} : { blockKind: kind },
				...row["before"] === void 0 ? {} : { before: stringValue(row["before"], "版本 before") },
				...row["after"] === void 0 ? {} : { after: stringValue(row["after"], "版本 after") }
			};
		}
		function arrayValue(value, label) {
			if (!Array.isArray(value)) throw new TypeError(label + " 不是数组");
			return value;
		}
		function stringArray(value, label) {
			return arrayValue(value, label).map((item, index) => stringValue(item, label + "[" + String(index) + "]"));
		}
		function decodeTimeline(value) {
			const data = objectValue(value, "Timeline 响应");
			return {
				sessionId: stringValue(data["sessionId"], "Timeline sessionId"),
				messages: arrayValue(data["messages"], "Timeline messages").map(decodeMessage),
				retryableTurns: arrayValue(data["retryableTurns"], "Timeline retryableTurns").map(decodeRetryable),
				versions: arrayValue(data["versions"], "Timeline versions").map(decodeVersion),
				undoStack: stringArray(data["undoStack"], "Timeline undoStack"),
				redoSessionIds: stringArray(data["redoSessionIds"], "Timeline redoSessionIds")
			};
		}
		function decodeOperationResult(value) {
			const data = objectValue(value, "操作响应");
			return {
				sessionId: stringValue(data["sessionId"], "操作 sessionId"),
				queuedTurns: numberValue(data["queuedTurns"], "操作 queuedTurns")
			};
		}
		async function responseValue(response) {
			const value = await response.json();
			if (response.ok) return value;
			const error = objectValue(value, "错误响应")["error"];
			throw new Error(typeof error === "string" ? error : "请求失败：HTTP " + String(response.status));
		}
		/**
		* Refresh key: only the running flag and the highest completed turn move the
		* host projection. History paging (older turns, hasMore/removed/openState) does
		* NOT change the host-side full-log result, so it must not trigger a refetch.
		*/
		function conversationRevision(snapshot) {
			let maxTurn = 0;
			for (const turn of snapshot.turnEnds.keys()) if (turn > maxTurn) maxTurn = turn;
			return (snapshot.running ? "R" : "r") + ":" + String(maxTurn);
		}
		function lineageRevision(snapshot, sessionId) {
			let root = sessionId;
			const ancestorIds = /* @__PURE__ */ new Set();
			while (!ancestorIds.has(root)) {
				ancestorIds.add(root);
				const parent = snapshot.byId[root]?.parentId;
				if (parent === void 0 || snapshot.byId[parent] === void 0) break;
				root = parent;
			}
			const connected = [];
			for (const rawId of Object.keys(snapshot.byId).sort()) {
				const id = rawId;
				const seen = /* @__PURE__ */ new Set();
				let cursor = id;
				while (cursor !== void 0 && !seen.has(cursor)) {
					if (cursor === root) {
						connected.push(id + ">" + (snapshot.byId[id]?.parentId ?? ""));
						break;
					}
					seen.add(cursor);
					cursor = snapshot.byId[cursor]?.parentId;
				}
			}
			return connected.join("|");
		}
		var EditResendController = class {
			sessionId;
			store = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)({
				status: "idle",
				error: null,
				pending: null,
				timeline: null
			});
			face;
			generation = 0;
			sessions;
			sessionSource;
			sessionSourceDispose;
			sessionRevision;
			listRevision = "";
			refreshScheduled = false;
			observing = false;
			navigationWaits = /* @__PURE__ */ new Set();
			constructor(ctx, sessionId) {
				this.sessionId = sessionId;
				this.sessions = ctx.get("sessions");
				this.face = {
					hooks: { editResend: this.store },
					load: () => {
						this.load();
					},
					edit: (message, text, cascade) => this.mutate({
						action: "edit",
						sessionId: this.sessionId,
						eventSeq: message.eventSeq,
						blockIndex: message.blockIndex,
						text,
						cascade
					}),
					retry: (turn, cascade) => this.mutate({
						action: "retry",
						sessionId: this.sessionId,
						turn,
						cascade
					}),
					reroll: () => this.mutate({
						action: "reroll",
						sessionId: this.sessionId
					}),
					openVersion: (sessionId) => this.openWhenListed(sessionId),
					stop: () => this.stop()
				};
				ctx.effect(() => this.observeDependencies(), "edit-resend: observe " + sessionId);
			}
			observeDependencies() {
				this.observing = true;
				this.listRevision = lineageRevision(this.sessions.list.getSnapshot(), this.sessionId);
				this.bindSessionSource();
				const disposeList = this.sessions.list.subscribe(() => {
					const rebound = this.bindSessionSource();
					const nextRevision = lineageRevision(this.sessions.list.getSnapshot(), this.sessionId);
					if (nextRevision === this.listRevision && !rebound) return;
					this.listRevision = nextRevision;
					this.invalidate();
				});
				return () => {
					this.observing = false;
					this.generation += 1;
					disposeList();
					this.sessionSourceDispose?.();
					this.sessionSourceDispose = void 0;
					this.sessionSource = void 0;
					this.sessionRevision = void 0;
					for (const cancel of [...this.navigationWaits]) cancel();
				};
			}
			bindSessionSource() {
				const source = this.sessions.binding(this.sessionId)?.session;
				if (source === this.sessionSource) return false;
				this.sessionSourceDispose?.();
				this.sessionSource = source;
				this.sessionRevision = source === void 0 ? void 0 : conversationRevision(source.getSnapshot());
				this.sessionSourceDispose = source?.subscribe(() => {
					if (this.sessionSource !== source) return;
					const revision = conversationRevision(source.getSnapshot());
					if (revision === this.sessionRevision) return;
					this.sessionRevision = revision;
					this.invalidate();
				});
				return true;
			}
			invalidate() {
				if (!this.observing || this.store.getSnapshot().status === "idle" || this.refreshScheduled) return;
				this.refreshScheduled = true;
				setTimeout(() => {
					this.refreshScheduled = false;
					if (this.observing && this.store.getSnapshot().status !== "idle") this.load();
				}, 200);
			}
			async load() {
				const generation = ++this.generation;
				this.store.update((state) => {
					state.status = "loading";
					state.error = null;
				});
				try {
					const timeline = decodeTimeline(await responseValue(await fetch("/edit-resend?sessionId=" + encodeURIComponent(this.sessionId), {
						method: "GET",
						headers: { accept: "application/json" },
						cache: "no-store"
					})));
					if (generation !== this.generation) return;
					this.store.update((state) => {
						state.status = "ready";
						state.error = null;
						state.timeline = timeline;
					});
				} catch (error) {
					if (generation !== this.generation) return;
					this.store.update((state) => {
						state.status = "error";
						state.error = messageOf(error);
					});
				}
			}
			refreshIfLoaded() {
				if (this.store.getSnapshot().status !== "idle") this.load();
			}
			async mutate(operation) {
				const current = this.store.getSnapshot();
				if (current.pending !== null || current.status !== "ready") return false;
				this.store.update((state) => {
					state.pending = operation.action;
					state.error = null;
				});
				try {
					const result = decodeOperationResult(await responseValue(await fetch(EDIT_RESEND_PATH, {
						method: "POST",
						headers: {
							accept: "application/json",
							"content-type": "application/json"
						},
						body: JSON.stringify(operation)
					})));
					this.store.update((state) => {
						state.pending = null;
					});
					await this.openWhenListed(result.sessionId);
					return true;
				} catch (error) {
					this.store.update((state) => {
						state.pending = null;
						state.error = messageOf(error);
					});
					return false;
				}
			}
			/** Cancel the in-flight reply via the session face (preserving the pending queue). */
			async stop() {
				const session = this.sessions.binding(this.sessionId)?.session;
				if (session === void 0) return false;
				try {
					return (await session.cancel()).ok;
				} catch {
					return false;
				}
			}
			openWhenListed(sessionId) {
				if (this.sessions.list.getSnapshot().byId[sessionId] !== void 0) {
					this.sessions.open(sessionId);
					return Promise.resolve();
				}
				return new Promise((resolve) => {
					let settled = false;
					let dispose = () => {};
					const finish = (open) => {
						if (settled) return;
						settled = true;
						dispose();
						this.navigationWaits.delete(cancel);
						if (open) this.sessions.open(sessionId);
						resolve();
					};
					const cancel = () => {
						finish(false);
					};
					this.navigationWaits.add(cancel);
					dispose = this.sessions.list.subscribe(() => {
						if (this.sessions.list.getSnapshot().byId[sessionId] === void 0) return;
						finish(true);
					});
					if (this.sessions.list.getSnapshot().byId[sessionId] !== void 0) finish(true);
				});
			}
		};
		//#endregion
		//#region src/client/messages.ts
		/**
		* Synchronously derive editable message blocks from the conversation snapshot's
		* finalized nodes. This is the zero-latency source for the inline edit/retry
		* icons: it needs no host round-trip, so the icons render with the message
		* (exactly like the built-in copy icon). The host Timeline tab still uses the
		* richer server projection for version-tree / per-block editing.
		*/
		function snapshotMessages(nodes) {
			const result = [];
			for (let index = 0; index < nodes.length; index += 1) {
				const node = nodes[index];
				if (node === void 0) continue;
				if (node.kind === "user") {
					const user = node;
					let turn = 0;
					for (let j = index + 1; j < nodes.length; j += 1) {
						const next = nodes[j];
						if (next?.kind === "assistant") {
							turn = next.turn;
							break;
						}
						if (next?.kind === "user") break;
					}
					for (const [blockIndex, block] of user.content.entries()) {
						if (block.type !== "text") continue;
						result.push({
							key: String(user.seq) + ":" + String(blockIndex),
							turn,
							eventSeq: user.seq,
							blockIndex,
							kind: "user",
							text: block.text,
							time: user.time
						});
					}
				} else if (node.kind === "assistant") {
					const assistant = node;
					for (const [blockIndex, block] of assistant.blocks.entries()) {
						if (block.kind !== "text" && block.kind !== "reasoning") continue;
						result.push({
							key: String(assistant.seq) + ":" + String(blockIndex),
							turn: assistant.turn,
							eventSeq: assistant.seq,
							blockIndex,
							kind: block.kind === "reasoning" ? "assistant.reasoning" : "assistant.response",
							text: block.text,
							time: assistant.time
						});
					}
				}
			}
			return result;
		}
		//#endregion
		//#region \0dsh-css:D:\dsh\dsh-edit-resend\src\client\InlineEdit.module.css.mjs
		const css$2 = ".fVO5cq_iconButton{width:24px;height:24px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:6px;justify-content:center;align-items:center;padding:0;display:inline-flex}.fVO5cq_iconButton:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.fVO5cq_overlay{z-index:1000;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);justify-content:center;align-items:center;padding:24px;display:flex;position:fixed;inset:0}.fVO5cq_panel{z-index:1;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-alias-bg-layer-2);width:min(440px,100%);box-shadow:var(--dsw-shadow-lv3);border-radius:20px;flex-direction:column;gap:14px;padding:20px;display:flex;position:relative}.fVO5cq_title{color:var(--dsw-alias-label-primary);margin:0;font-size:15px;font-weight:600;line-height:22px}.fVO5cq_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input-major);width:100%;min-height:72px;max-height:360px;color:var(--dsw-alias-label-primary);resize:none;border-radius:12px;padding:10px 12px;font-family:inherit;font-size:14px;line-height:22px;overflow-y:auto}.fVO5cq_input:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}.fVO5cq_footer{justify-content:space-between;align-items:center;gap:12px;display:flex}.fVO5cq_hint{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}.fVO5cq_actions{flex:none;align-items:center;gap:12px;display:flex}.fVO5cq_save,.fVO5cq_cancel{cursor:pointer;border-radius:17px;justify-content:center;align-items:center;height:34px;padding:0 16px;font-size:14px;line-height:20px;transition:background .15s;display:inline-flex}.fVO5cq_save{background:var(--dsw-alias-button-primary-fill);min-width:92px;color:var(--dsw-alias-label-primary-foreground);border:none}.fVO5cq_save:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}.fVO5cq_save:disabled{opacity:.4;cursor:not-a... (line truncated to 2000 chars)
		const tagId$2 = "dsh-edit-resend/InlineEdit.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-edit-resend";
			tag.dataset.pluginCss = tagId$2;
			tag.textContent = css$2;
			document.head.appendChild(tag);
		}
		var InlineEdit_module_css_default = {
			"input": "fVO5cq_input",
			"iconButton": "fVO5cq_iconButton",
			"overlay": "fVO5cq_overlay",
			"actions": "fVO5cq_actions",
			"hint": "fVO5cq_hint",
			"title": "fVO5cq_title",
			"footer": "fVO5cq_footer",
			"panel": "fVO5cq_panel",
			"cancel": "fVO5cq_cancel",
			"save": "fVO5cq_save"
		};
		//#endregion
		//#region src/client/InlineEdit.tsx
		/**
		* Message-row edit affordance: injects edit + retry icon buttons into each
		* settled (and open-tail) message's icon-actions row via a MutationObserver,
		* because the official MessageIconActions exposes no plugin slot.
		*/
		const BLOCK_TITLE = {
			user: "编辑并重新发送",
			"assistant.reasoning": "编辑助手思考",
			"assistant.response": "编辑助手回复"
		};
		const STYLE = {
			overlay: InlineEdit_module_css_default["overlay"] ?? "",
			panel: InlineEdit_module_css_default["panel"] ?? "",
			title: InlineEdit_module_css_default["title"] ?? "",
			input: InlineEdit_module_css_default["input"] ?? "",
			footer: InlineEdit_module_css_default["footer"] ?? "",
			hint: InlineEdit_module_css_default["hint"] ?? "",
			actions: InlineEdit_module_css_default["actions"] ?? "",
			iconButton: InlineEdit_module_css_default["iconButton"] ?? "",
			save: InlineEdit_module_css_default["save"] ?? "",
			cancel: InlineEdit_module_css_default["cancel"] ?? ""
		};
		const EDIT_PATH = "M9.94076 1.34942C10.7047 0.90231 11.6503 0.902415 12.4143 1.34942C12.7061 1.52015 12.9688 1.79118 13.3104 2.13284C13.6521 2.47448 13.9231 2.73721 14.0939 3.02894C14.5408 3.79294 14.5409 4.73856 14.0939 5.50251C13.9231 5.79415 13.652 6.05704 13.3104 6.39861L6.65932 13.0497C6.28068 13.4284 6.00695 13.7108 5.66543 13.9097C5.32391 14.1085 4.94315 14.2074 4.42705 14.3498L3.24394 14.6761C2.77527 14.8054 2.34538 14.9262 2.00131 14.9684C1.65196 15.0112 1.17964 15.0013 0.810764 14.6325C0.441921 14.2637 0.432107 13.7913 0.47486 13.442C0.517035 13.0979 0.6379 12.668 0.767181 12.1993L1.09352 11.0162C1.23588 10.5001 1.33481 10.1193 1.5336 9.77784C1.7325 9.43632 2.0149 9.1626 2.39355 8.78395L9.04466 2.13284C9.38625 1.79126 9.64911 1.52016 9.94076 1.34942ZM15.5427 14.8398H7.55223L8.96707 13.425H15.5427V14.8398ZM3.39382 9.78422C2.965 10.213 2.84244 10.3436 2.75709 10.49C2.67183 10.6366 2.61862 10.8079 2.45733 11.3925L2.13099 12.5756C2.00183 13.0439 1.92194 13.3419 1.88863 13.5536C2.10041 13.5204 2.39872 13.4416 2.86764 13.3123L4.05075 12.9859C4.63544 12.8246 4.80669 12.7715 4.95323 12.6862C5.09968 12.6008 5.23022 12.4783 5.65905 12.0494L10.721 6.98644L8.45577 4.72121L3.39382 9.78422ZM11.7 2.57079C11.3774 2.38198 10.9777 2.38198 10.6551 2.57079C10.5602 2.62647 10.4487 2.72931 10.0449 3.13311L9.45604 3.72094L11.7213 5.98617L12.3102 5.39833C12.7139 4.99457 12.8168 4.88307 12.8725 4.78818C13.0613 4.46561 13.0612 4.06585 12.8725 3.74326C12.8169 3.64827 12.7146 3.53752 12.3102 3.13311C11.9057 2.72863 11.795 2.6264 11.7 2.57079Z";
		const REFRESH_PATH = "M7.92136 0.349152C10.3744 0.349234 12.5564 1.5052 13.9557 3.29894L15.1281 2.12759C15.3303 1.92546 15.6767 2.06943 15.6767 2.35538V5.53923C15.6766 5.71626 15.5329 5.85976 15.3559 5.86002H12.171C11.8854 5.8597 11.7426 5.51465 11.9443 5.31249L12.9641 4.29056C11.8237 2.74305 9.98908 1.74106 7.92136 1.74097C4.46436 1.74097 1.66233 4.543 1.66233 8C1.66233 11.457 4.46436 14.259 7.92136 14.259C11.3782 14.2589 14.1804 11.4569 14.1804 8H15.5722C15.5722 12.2251 12.1465 15.6507 7.92136 15.6508C3.69614 15.6508 0.270508 12.2252 0.270508 8C0.270508 3.77478 3.69614 0.349152 7.92136 0.349152Z";
		function svgIcon(path) {
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("width", "16");
			svg.setAttribute("height", "16");
			svg.setAttribute("viewBox", "0 0 16 16");
			svg.setAttribute("fill", "none");
			const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
			p.setAttribute("d", path);
			p.setAttribute("fill", "currentColor");
			svg.appendChild(p);
			return svg;
		}
		function blockTitle(kind) {
			return BLOCK_TITLE[kind] ?? "编辑消息";
		}
		function mountEditor(block, edit, close) {
			const overlay = document.createElement("div");
			overlay.className = STYLE.overlay;
			const panel = document.createElement("div");
			panel.className = STYLE.panel;
			const title = document.createElement("div");
			title.className = STYLE.title;
			title.textContent = blockTitle(block.kind);
			const input = document.createElement("textarea");
			input.className = STYLE.input;
			input.value = block.text;
			const footer = document.createElement("div");
			footer.className = STYLE.footer;
			const hint = document.createElement("span");
			hint.className = STYLE.hint;
			hint.textContent = "从该消息之前分支重新生成，原版本保留";
			const actions = document.createElement("div");
			actions.className = STYLE.actions;
			const save = document.createElement("button");
			save.className = STYLE.save;
			save.textContent = "重新发送";
			const cancel = document.createElement("button");
			cancel.className = STYLE.cancel;
			cancel.textContent = "取消";
			actions.append(save, cancel);
			footer.append(hint, actions);
			panel.append(title, input, footer);
			overlay.appendChild(panel);
			document.body.appendChild(overlay);
			const autoSize = () => {
				input.style.height = "auto";
				input.style.height = Math.min(input.scrollHeight, 360) + "px";
			};
			input.addEventListener("input", autoSize);
			input.focus();
			input.setSelectionRange(input.value.length, input.value.length);
			autoSize();
			let mounted = true;
			let saving = false;
			const saveEdit = () => {
				if (saving) return;
				saving = true;
				save.disabled = true;
				edit(block, input.value, "truncate").then((applied) => {
					if (!mounted) return;
					if (applied) {
						close();
						return;
					}
					saving = false;
					save.disabled = false;
				});
			};
			const cancelEdit = () => {
				close();
			};
			const dismiss = (event) => {
				if (event.target === overlay) close();
			};
			save.addEventListener("click", saveEdit);
			cancel.addEventListener("click", cancelEdit);
			overlay.addEventListener("click", dismiss);
			return () => {
				mounted = false;
				save.removeEventListener("click", saveEdit);
				cancel.removeEventListener("click", cancelEdit);
				overlay.removeEventListener("click", dismiss);
				overlay.remove();
			};
		}
		function createOverlayHost(edit) {
			let active;
			const editBlock = (block) => {
				active?.();
				let cleanup = () => {};
				let mounted = true;
				const close = () => {
					if (!mounted) return;
					mounted = false;
					cleanup();
					if (active === close) active = void 0;
				};
				active = close;
				try {
					cleanup = mountEditor(block, edit, close);
				} catch (error) {
					active = void 0;
					mounted = false;
					throw error;
				}
			};
			return {
				editBlock,
				dispose: () => {
					active?.();
				}
			};
		}
		function InlineEdit({ messages, edit, retry }) {
			(0, react.useEffect)(() => {
				const cleanups = [];
				const overlays = createOverlayHost(edit);
				let observer;
				const sync = () => {
					const actionRows = Array.from(document.querySelectorAll("[class*=\"actions\"]"));
					const claimedEvents = /* @__PURE__ */ new Set();
					for (const row of actionRows) {
						const marker = row;
						if (marker.__editResendInjected === true) {
							if (marker.__editResendEventSeq !== void 0) claimedEvents.add(marker.__editResendEventSeq);
							continue;
						}
						const text = (row.parentElement?.parentElement?.textContent ?? "").trim();
						if (text.length === 0) continue;
						const eventSeq = [...new Set(messages.filter((message) => message.kind === "user" && message.text.length > 0 && text.includes(message.text.slice(0, 24))).map((message) => message.eventSeq))].find((candidate) => !claimedEvents.has(candidate));
						if (eventSeq === void 0) continue;
						const blocks = messages.filter((message) => message.eventSeq === eventSeq && message.kind === "user");
						if (blocks.length === 0) continue;
						const previousMarker = marker.__editResendInjected;
						const previousEventSeq = marker.__editResendEventSeq;
						marker.__editResendInjected = true;
						marker.__editResendEventSeq = eventSeq;
						claimedEvents.add(eventSeq);
						const editButton = document.createElement("button");
						editButton.className = STYLE.iconButton;
						editButton.setAttribute("aria-label", "编辑并重新发送");
						editButton.title = "编辑并重新发送";
						editButton.appendChild(svgIcon(EDIT_PATH));
						const editMessage = () => {
							const block = blocks[0];
							if (block !== void 0) overlays.editBlock(block);
						};
						editButton.addEventListener("click", editMessage);
						const retryButton = document.createElement("button");
						retryButton.className = STYLE.iconButton;
						retryButton.setAttribute("aria-label", "重试此回合");
						retryButton.title = "重试此回合";
						retryButton.appendChild(svgIcon(REFRESH_PATH));
						const turn = blocks[0]?.turn;
						const retryTurn = () => {
							if (turn !== void 0) retry(turn, "truncate");
						};
						retryButton.addEventListener("click", retryTurn);
						const lastOfficial = Array.from(row.querySelectorAll("button")).filter((button) => button !== editButton && button !== retryButton).at(-1);
						if (lastOfficial !== void 0) {
							lastOfficial.insertAdjacentElement("afterend", retryButton);
							lastOfficial.insertAdjacentElement("afterend", editButton);
						} else {
							row.appendChild(editButton);
							row.appendChild(retryButton);
						}
						cleanups.push(() => {
							editButton.removeEventListener("click", editMessage);
							retryButton.removeEventListener("click", retryTurn);
							editButton.remove();
							retryButton.remove();
							if (previousMarker === void 0) delete marker.__editResendInjected;
							else marker.__editResendInjected = previousMarker;
							if (previousEventSeq === void 0) delete marker.__editResendEventSeq;
							else marker.__editResendEventSeq = previousEventSeq;
						});
					}
				};
				sync();
				observer = new MutationObserver(sync);
				observer.observe(document.body, {
					childList: true,
					subtree: true
				});
				return () => {
					observer?.disconnect();
					overlays.dispose();
					for (const cleanup of cleanups.reverse()) cleanup();
				};
			}, [
				messages,
				edit,
				retry
			]);
			return null;
		}
		//#endregion
		//#region \0dsh-css:D:\dsh\dsh-edit-resend\src\client\EditResendHeader.module.css.mjs
		const css$1 = ".k-Flkq_root{align-items:center;gap:6px;display:inline-flex}.k-Flkq_iconButton{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:8px;justify-content:center;align-items:center;font-size:14px;display:inline-flex}.k-Flkq_iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.k-Flkq_iconButton:disabled{opacity:.4;cursor:not-allowed}.k-Flkq_rerollButton,.k-Flkq_stopButton{cursor:pointer;border-radius:14px;justify-content:center;align-items:center;height:28px;padding:0 10px;font-size:12px;line-height:18px;transition:background .15s;display:inline-flex}.k-Flkq_rerollButton{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:0 0}.k-Flkq_rerollButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.k-Flkq_stopButton{border:1px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-weight:500}.k-Flkq_stopButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}.k-Flkq_rerollButton:disabled,.k-Flkq_stopButton:disabled{opacity:.4;cursor:not-allowed}.k-Flkq_counter{color:var(--dsw-alias-label-caption);white-space:nowrap;font-size:11px;line-height:16px}";
		const tagId$1 = "dsh-edit-resend/EditResendHeader.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-edit-resend";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var EditResendHeader_module_css_default = {
			"counter": "k-Flkq_counter",
			"root": "k-Flkq_root",
			"iconButton": "k-Flkq_iconButton",
			"stopButton": "k-Flkq_stopButton",
			"rerollButton": "k-Flkq_rerollButton"
		};
		//#endregion
		//#region src/client/EditResendHeader.tsx
		function EditResendHeader({ useEditResend, useSession, load, openVersion, reroll, stop, edit, retry }) {
			const state = useEditResend((value) => value);
			const running = useSession((snapshot) => snapshot.running);
			const nodes = useSession((snapshot) => snapshot.nodes);
			const syncMessages = (0, react.useMemo)(() => snapshotMessages(nodes), [nodes]);
			(0, react.useEffect)(() => {
				load();
			}, [load]);
			const timeline = state.timeline;
			const undoSessionId = timeline?.undoStack[0];
			const redoSessionId = timeline?.redoSessionIds.at(-1);
			const effectDepth = timeline?.undoStack.length ?? 0;
			const versionCount = timeline?.versions.length ?? 0;
			const busy = state.pending !== null || state.status !== "ready";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(InlineEdit, {
				messages: syncMessages,
				edit,
				retry
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: EditResendHeader_module_css_default["root"],
				children: [
					running ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: EditResendHeader_module_css_default["stopButton"],
						title: "停止当前回复，之后可直接编辑并重新发送",
						onClick: () => {
							stop();
						},
						children: "■ 停止"
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: EditResendHeader_module_css_default["iconButton"],
						"aria-label": "撤销当前版本效果",
						title: "撤销当前效果",
						disabled: undoSessionId === void 0 || busy,
						onClick: () => {
							if (undoSessionId !== void 0) openVersion(undoSessionId);
						},
						children: "←"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: EditResendHeader_module_css_default["counter"],
						children: versionCount === 0 ? "编辑 —" : "编辑 " + String(effectDepth) + " 层 · " + String(versionCount) + " 版"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: EditResendHeader_module_css_default["iconButton"],
						"aria-label": "重施加下一版本效果",
						title: "重施加下一效果",
						disabled: redoSessionId === void 0 || busy,
						onClick: () => {
							if (redoSessionId !== void 0) openVersion(redoSessionId);
						},
						children: "→"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: EditResendHeader_module_css_default["rerollButton"],
						disabled: busy || timeline === null,
						onClick: () => {
							reroll();
						},
						children: state.pending === "reroll" ? "重生成中…" : "重生成"
					})
				]
			})] });
		}
		//#endregion
		//#region \0dsh-css:D:\dsh\dsh-edit-resend\src\client\EditResendTimelineView.module.css.mjs
		const css = ".dvKrZa_root{color:var(--dsw-alias-label-primary);flex-direction:column;gap:16px;padding:16px;font-size:13px;display:flex}.dvKrZa_pageHeader{justify-content:space-between;align-items:flex-start;gap:16px;display:flex}.dvKrZa_title{margin:0 0 4px;font-size:16px;font-weight:500;line-height:24px}.dvKrZa_intro{color:var(--dsw-alias-label-caption);margin:0;font-size:12px;line-height:18px}.dvKrZa_headerActions{align-items:center;gap:10px;display:flex}.dvKrZa_cascadeField{color:var(--dsw-alias-label-caption);flex-direction:column;gap:2px;font-size:11px;display:flex}.dvKrZa_select{background:var(--dsw-specific-selector);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 8px}.dvKrZa_columns{grid-template-columns:260px 1fr;align-items:start;gap:16px;display:grid}.dvKrZa_versionsPanel,.dvKrZa_turnsPanel{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:10px}.dvKrZa_sectionHeading{align-items:baseline;gap:8px;margin-bottom:8px;display:flex}.dvKrZa_subtitle{margin:0;font-size:14px;font-weight:500;line-height:22px}.dvKrZa_count{color:var(--dsw-alias-label-caption);font-size:12px}.dvKrZa_effectControls{flex-direction:column;gap:6px;margin-bottom:10px;display:flex}.dvKrZa_effectDepth{color:var(--dsw-alias-label-caption);font-size:11px}.dvKrZa_effectButtons{flex-wrap:wrap;gap:6px;display:flex}.dvKrZa_versionList{flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;display:flex}.dvKrZa_versionItem{--edit-resend-depth:0;padding-left:calc(var(--edit-resend-depth) * 12px)}.dvKrZa_versionButton{text-align:left;width:100%;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:8px;align-items:center;gap:6px;padding:4px 6px;display:flex}.dvKrZa_versionButton:hover,.dvKrZa_versionButton[data-current=true]{background:var(--dsw-alias-interactive-bg-hover)}.dvKrZa_versionLine{background:var(--dsw-alias-border-l2);... (line truncated to 2000 chars)
		const tagId = "dsh-edit-resend/EditResendTimelineView.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-edit-resend";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var EditResendTimelineView_module_css_default = {
			"select": "dvKrZa_select",
			"title": "dvKrZa_title",
			"effectDepth": "dvKrZa_effectDepth",
			"messageList": "dvKrZa_messageList",
			"kindBadge": "dvKrZa_kindBadge",
			"effectButtons": "dvKrZa_effectButtons",
			"openBadge": "dvKrZa_openBadge",
			"versionTitle": "dvKrZa_versionTitle",
			"versionList": "dvKrZa_versionList",
			"editorActions": "dvKrZa_editorActions",
			"editorHint": "dvKrZa_editorHint",
			"primaryButton": "dvKrZa_primaryButton",
			"intro": "dvKrZa_intro",
			"versionsPanel": "dvKrZa_versionsPanel",
			"versionButton": "dvKrZa_versionButton",
			"turnTitle": "dvKrZa_turnTitle",
			"turnPreview": "dvKrZa_turnPreview",
			"secondaryButton": "dvKrZa_secondaryButton",
			"editor": "dvKrZa_editor",
			"notice": "dvKrZa_notice",
			"empty": "dvKrZa_empty",
			"versionDot": "dvKrZa_versionDot",
			"sectionHeading": "dvKrZa_sectionHeading",
			"root": "dvKrZa_root",
			"versionLine": "dvKrZa_versionLine",
			"messageText": "dvKrZa_messageText",
			"headerActions": "dvKrZa_headerActions",
			"turnList": "dvKrZa_turnList",
			"turnSection": "dvKrZa_turnSection",
			"subtitle": "dvKrZa_subtitle",
			"columns": "dvKrZa_columns",
			"pageHeader": "dvKrZa_pageHeader",
			"count": "dvKrZa_count",
			"effectControls": "dvKrZa_effectControls",
			"versionItem": "dvKrZa_versionItem",
			"cascadeField": "dvKrZa_cascadeField",
			"versionMain": "dvKrZa_versionMain",
			"versionMeta": "dvKrZa_versionMeta",
			"currentBadge": "dvKrZa_currentBadge",
			"versionDiff": "dvKrZa_versionDiff",
			"messageCard": "dvKrZa_messageCard",
			"pathBadge": "dvKrZa_pathBadge",
			"messageHeader": "dvKrZa_messageHeader",
			"turnHeader": "dvKrZa_turnHeader",
			"textButton": "dvKrZa_textButton",
			"status": "dvKrZa_status",
			"textarea": "dvKrZa_textarea",
			"turnsPanel": "dvKrZa_turnsPanel",
			"error": "dvKrZa_error",
			"messageTime": "dvKrZa_messageTime"
		};
		//#endregion
		//#region src/client/EditResendTimelineView.tsx
		/** Timeline tab: durable version tree plus turn/block edit, retry, and reroll. */
		const BLOCK_LABEL = {
			user: "用户消息",
			"assistant.reasoning": "助手思考",
			"assistant.response": "助手回复"
		};
		const OPERATION_LABEL = {
			edit: "编辑",
			reroll: "重生成",
			retry: "重试"
		};
		function timeLabel(value) {
			return new Date(value).toLocaleString("zh-CN", {
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit"
			});
		}
		function turnSections(turns, messages) {
			return turns.map((retry) => ({
				retry,
				messages: messages.filter((message) => message.turn === retry.turn)
			}));
		}
		function VersionRow({ version, disabled, onOpen }) {
			const depthStyle = { "--edit-resend-depth": String(version.depth) };
			const operation = version.operation === void 0 ? version.parentSessionId === void 0 ? "原始版本" : "外部分支" : OPERATION_LABEL[version.operation];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
				className: EditResendTimelineView_module_css_default["versionItem"],
				style: depthStyle,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: EditResendTimelineView_module_css_default["versionButton"],
					"data-current": version.current || void 0,
					disabled: version.current || disabled,
					onClick: () => {
						onOpen(version.sessionId);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: EditResendTimelineView_module_css_default["versionLine"],
							"aria-hidden": true
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: EditResendTimelineView_module_css_default["versionDot"],
							"aria-hidden": true
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: EditResendTimelineView_module_css_default["versionMain"],
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: EditResendTimelineView_module_css_default["versionTitle"],
									children: [operation, version.targetTurn === void 0 ? null : " · 回合 " + String(version.targetTurn)]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: EditResendTimelineView_module_css_default["versionMeta"],
									children: [
										timeLabel(version.createdAt),
										" · ",
										version.sessionId.slice(0, 12)
									]
								}),
								version.before === void 0 && version.after === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: EditResendTimelineView_module_css_default["versionDiff"],
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["原：", version.before || "（空）"] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["新：", version.after || "（空）"] })]
								})
							]
						}),
						version.current ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: EditResendTimelineView_module_css_default["currentBadge"],
							children: "当前"
						}) : version.onCurrentEffectPath ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: EditResendTimelineView_module_css_default["pathBadge"],
							children: "链上"
						}) : null
					]
				})
			});
		}
		function MessageCard({ message, editing, disabled, cascade, onBeginEdit, onCancelEdit, onTextChange, onApplyEdit }) {
			const active = editing?.message.key === message.key;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
				className: EditResendTimelineView_module_css_default["messageCard"],
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: EditResendTimelineView_module_css_default["messageHeader"],
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: EditResendTimelineView_module_css_default["kindBadge"],
							"data-kind": message.kind,
							children: BLOCK_LABEL[message.kind]
						}),
						message.open === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: EditResendTimelineView_module_css_default["openBadge"],
							children: "待重发"
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: EditResendTimelineView_module_css_default["messageTime"],
							children: timeLabel(message.time)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: EditResendTimelineView_module_css_default["textButton"],
							disabled,
							onClick: () => {
								active ? onCancelEdit() : onBeginEdit(message);
							},
							children: active ? "取消" : "编辑"
						})
					]
				}), active && editing !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: EditResendTimelineView_module_css_default["editor"],
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
						className: EditResendTimelineView_module_css_default["textarea"],
						value: editing.text,
						rows: 6,
						autoFocus: true,
						onChange: (event) => {
							onTextChange(event.currentTarget.value);
						}
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: EditResendTimelineView_module_css_default["editorActions"],
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: EditResendTimelineView_module_css_default["editorHint"],
							children: "将从该回合之前分支，原版本保持不变。"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: EditResendTimelineView_module_css_default["primaryButton"],
							disabled,
							onClick: () => {
								onApplyEdit(message, editing.text, cascade);
							},
							children: "应用并重新发送"
						})]
					})]
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
					className: EditResendTimelineView_module_css_default["messageText"],
					children: message.text || "（空内容）"
				})]
			});
		}
		function EditResendTimelineView({ useEditResend, load, edit, retry, reroll, openVersion }) {
			const state = useEditResend((value) => value);
			const [cascade, setCascade] = (0, react.useState)("truncate");
			const [editing, setEditing] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				load();
			}, [load]);
			const timeline = state.timeline;
			const sections = (0, react.useMemo)(() => timeline === null ? [] : turnSections(timeline.retryableTurns, timeline.messages), [timeline]);
			const busy = state.pending !== null || state.status !== "ready";
			(0, react.useEffect)(() => {
				setEditing((current) => {
					if (current === null || timeline === null) return current;
					return timeline.messages.some((message) => message.key === current.message.key) ? current : null;
				});
			}, [timeline]);
			if (timeline === null && (state.status === "idle" || state.status === "loading")) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: EditResendTimelineView_module_css_default["status"],
				children: "正在载入消息时间线…"
			});
			if (timeline === null && state.status === "error") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: EditResendTimelineView_module_css_default["status"],
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: EditResendTimelineView_module_css_default["error"],
					children: state.error
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: EditResendTimelineView_module_css_default["secondaryButton"],
					onClick: load,
					children: "重新载入"
				})]
			});
			if (timeline === null) return null;
			const applyEdit = (message, text, policy) => {
				setEditing(null);
				edit(message, text, policy);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: EditResendTimelineView_module_css_default["root"],
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: EditResendTimelineView_module_css_default["pageHeader"],
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", {
							className: EditResendTimelineView_module_css_default["title"],
							children: "编辑与重新发送"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: EditResendTimelineView_module_css_default["intro"],
							children: "可编辑已发送的消息（含正在回复中的最后一条）：先点标题栏的「停止」，再编辑并重新发送。每次修改都保留原版本，可随时切回。"
						})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: EditResendTimelineView_module_css_default["headerActions"],
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: EditResendTimelineView_module_css_default["cascadeField"],
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "后续策略" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									className: EditResendTimelineView_module_css_default["select"],
									value: cascade,
									disabled: busy,
									onChange: (event) => {
										setCascade(event.currentTarget.value);
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "truncate",
										children: "截断后续（默认）"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "preserve",
										children: "保留输入并重生成后续"
									})]
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: EditResendTimelineView_module_css_default["primaryButton"],
								disabled: busy,
								onClick: () => {
									reroll();
								},
								children: state.pending === "reroll" ? "正在重生成…" : "重生成最后回复"
							})]
						})]
					}),
					state.error === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: EditResendTimelineView_module_css_default["error"],
						children: state.error
					}),
					state.status === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: EditResendTimelineView_module_css_default["notice"],
						children: "正在刷新时间线…"
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: EditResendTimelineView_module_css_default["columns"],
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
							className: EditResendTimelineView_module_css_default["versionsPanel"],
							"aria-label": "版本时间线",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: EditResendTimelineView_module_css_default["sectionHeading"],
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
										className: EditResendTimelineView_module_css_default["subtitle"],
										children: "版本时间线"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: EditResendTimelineView_module_css_default["count"],
										children: String(timeline.versions.length)
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: EditResendTimelineView_module_css_default["effectControls"],
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: EditResendTimelineView_module_css_default["effectDepth"],
										children: [
											"当前效果链 ",
											String(timeline.undoStack.length),
											" 层"
										]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: EditResendTimelineView_module_css_default["effectButtons"],
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: EditResendTimelineView_module_css_default["secondaryButton"],
											disabled: busy || timeline.undoStack[0] === void 0,
											onClick: () => {
												const target = timeline.undoStack[0];
												if (target !== void 0) openVersion(target);
											},
											children: "撤销当前效果"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: EditResendTimelineView_module_css_default["secondaryButton"],
											disabled: busy || timeline.redoSessionIds.length === 0,
											onClick: () => {
												const target = timeline.redoSessionIds.at(-1);
												if (target !== void 0) openVersion(target);
											},
											children: "重施加下一效果"
										})]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
									className: EditResendTimelineView_module_css_default["versionList"],
									children: timeline.versions.map((version) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(VersionRow, {
										version,
										disabled: busy,
										onOpen: (sid) => {
											openVersion(sid);
										}
									}, version.sessionId))
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("main", {
							className: EditResendTimelineView_module_css_default["turnsPanel"],
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: EditResendTimelineView_module_css_default["sectionHeading"],
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
									className: EditResendTimelineView_module_css_default["subtitle"],
									children: "消息"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: EditResendTimelineView_module_css_default["count"],
									children: String(timeline.messages.length)
								})]
							}), sections.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: EditResendTimelineView_module_css_default["empty"],
								children: "当前会话还没有可编辑的消息。"
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
								className: EditResendTimelineView_module_css_default["turnList"],
								children: sections.map((section) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
									className: EditResendTimelineView_module_css_default["turnSection"],
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: EditResendTimelineView_module_css_default["turnHeader"],
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
											className: EditResendTimelineView_module_css_default["turnTitle"],
											children: ["回合 ", String(section.retry.turn)]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: EditResendTimelineView_module_css_default["turnPreview"],
											children: section.retry.preview || "（空用户输入）"
										})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: EditResendTimelineView_module_css_default["secondaryButton"],
											disabled: busy,
											onClick: () => {
												retry(section.retry.turn, cascade);
											},
											children: state.pending === "retry" ? "正在重试…" : "重试此回合"
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: EditResendTimelineView_module_css_default["messageList"],
										children: section.messages.map((message) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MessageCard, {
											message,
											editing,
											disabled: busy,
											cascade,
											onBeginEdit: (value) => {
												setEditing({
													message: value,
													text: value.text
												});
											},
											onCancelEdit: () => {
												setEditing(null);
											},
											onTextChange: (text) => {
												setEditing((current) => current === null ? null : {
													...current,
													text
												});
											},
											onApplyEdit: applyEdit
										}, message.key))
									})]
								}, String(section.retry.turn)))
							})]
						})]
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		const inject = [
			"slots",
			"conversation",
			"connection",
			"sessions"
		];
		function apply(ctx) {
			const controllers = /* @__PURE__ */ new Map();
			const controllerFor = (sessionId) => {
				let controller = controllers.get(sessionId);
				if (controller === void 0) {
					controller = new EditResendController(ctx, sessionId);
					controllers.set(sessionId, controller);
				}
				return controller;
			};
			ctx.on("connection/reset", () => {
				for (const controller of controllers.values()) controller.refreshIfLoaded();
			});
			ctx.slots.register({
				name: "conversation.view",
				id: "edit-resend-timeline",
				order: 15,
				label: "编辑与重发",
				inject: (sessionId) => controllerFor(sessionId).face
			}, EditResendTimelineView);
			ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "edit-resend-controls",
				order: 15,
				inject: (sessionId) => controllerFor(sessionId).face
			}, EditResendHeader);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map