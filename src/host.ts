/**
 * Host half of Edit & Resend: turn-atomic forks, structurally reversible
 * versions, and open-tail (in-flight) editing. Unlike the upstream
 * dsh-message-edit, version metadata is stored OUTSIDE the append-only session
 * log (a JSON file under DSH_HOME), so no custom session event type is ever
 * written and sessions remain resumable after a host restart.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type {
  SessionId, Session, SessionEvent, SessionEventType, SurfaceEventType, SurfaceIntent,
} from '@deepseek-ai/dsh-session'
import type { SessionLineageNode, SessionRecord, SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import type { AssistantMessage, ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  EDIT_RESEND_PATH, VIEW_ORDER,
  type CascadePolicy, type EditOperation, type EditableBlockKind, type EditableMessageBlock,
  type EditResendOperation, type EditResendOperationResult, type EditResendTimeline,
  type RetryableTurn, type VersionEffect, type VersionRecord, type VersionSummary,
} from './shared.ts'

export { EDIT_RESEND_PATH, VIEW_ORDER } from './shared.ts'
export type {
  CascadePolicy, EditOperation, EditableBlockKind, EditableMessageBlock,
  EditResendOperation, EditResendOperationResult, EditResendTimeline,
  RetryableTurn, VersionEffect, VersionOperation, VersionRecord, VersionSummary,
} from './shared.ts'

// ── HTTP server surface (rc.5 dsh-host-webserver contract) ──────────────────
interface HttpRequestLike {
  method?: string
  url?: string
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): this
  on(event: 'end', listener: () => void): this
  on(event: 'error', listener: (error: unknown) => void): this
}

interface HttpResponseLike {
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(body?: string): void
}

interface HttpServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (request: HttpRequestLike, response: HttpResponseLike) => void | Promise<void>
  }): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: HttpServerLike
  }
}

/** Stable Cordis plugin name. */
export const name = 'edit-resend'

/** Public services used by the branch transaction and timeline projection. */
export const inject = ['sessions', 'agents', 'sessionQuery', 'workspaceRegistry', 'webServer']

type UserEvent = SessionEvent<'user/message'>
type AssistantEvent = SessionEvent<'assistant/message'>

interface ClosedTurn {
  turn: number
  startSeq: number
  endSeq: number
  user?: UserEvent
  assistants: AssistantEvent[]
}

interface OpenTail {
  turn: number
  startSeq: number
  user?: UserEvent
  assistants: AssistantEvent[]
}

interface ManualAssistantTurn {
  turn: number
  user: UserMessage
  assistant: AssistantMessage
}

interface OperationPlan {
  boundary: number
  version: VersionRecord
  manualTurn?: ManualAssistantTurn
  queuedUsers: UserMessage[]
}

type VersionEffectDraft = Omit<VersionEffect, 'id'>

function pairVersionEffect(sourceSessionId: string, effect: VersionEffectDraft): VersionRecord {
  return {
    effect: { ...effect, id: crypto.randomUUID() },
    inverseSessionId: sourceSessionId,
    time: Date.now(),
  }
}

function isTextualBlock(block: ContentBlock | undefined): block is Extract<ContentBlock, { type: 'text' | 'reasoning' }> {
  return block?.type === 'text' || block?.type === 'reasoning'
}

function userText(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function cloneUser(message: UserMessage, content: ContentBlock[] = structuredClone(message.content)): UserMessage {
  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'user' as const,
    content: Object.freeze(content),
    source: Object.freeze({ kind: 'user' as const }),
  }) as UserMessage
}

function replaceTextBlock(content: readonly ContentBlock[], blockIndex: number, text: string): ContentBlock[] {
  const block = content[blockIndex]
  if (!isTextualBlock(block)) throw new Error('所选内容块不是可编辑文本。')
  return content.map((candidate, index) => index === blockIndex
    ? { ...candidate, text } as ContentBlock
    : structuredClone(candidate))
}

/** Fold complete turn brackets plus the optional still-open tail turn. */
export function foldTurns(events: readonly SessionEvent[]): { closed: ClosedTurn[]; open?: OpenTail } {
  const closed: ClosedTurn[] = []
  let current: Omit<ClosedTurn, 'endSeq'> | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (current !== undefined) {
        // Unbalanced previous turn (should not happen for closed folding, but guard).
      }
      current = { turn: event.data.turn, startSeq: event.seq, assistants: [] }
      continue
    }
    if (current === undefined) continue
    if (event.type === 'user/message' && current.user === undefined && event.data.source.kind === 'user') {
      current.user = event
      continue
    }
    if (event.type === 'assistant/message' && event.data.turn === current.turn) {
      current.assistants.push(event)
      continue
    }
    if (event.type === 'turn/end' && event.data.turn === current.turn) {
      closed.push({ ...current, endSeq: event.seq })
      current = undefined
    }
  }
  if (current !== undefined && (current.user !== undefined || current.assistants.length > 0)) {
    return { closed, open: { ...current } }
  }
  return { closed }
}

function editableMessages(closed: readonly ClosedTurn[], open?: OpenTail): EditableMessageBlock[] {
  const result: EditableMessageBlock[] = []
  const pushUser = (event: UserEvent, turnNumber: number, openFlag: boolean): void => {
    for (const [blockIndex, block] of event.data.content.entries()) {
      if (block.type !== 'text') continue
      result.push({
        key: String(event.seq) + ':' + String(blockIndex),
        turn: turnNumber,
        eventSeq: event.seq,
        blockIndex,
        kind: 'user',
        text: block.text,
        time: event.time,
        ...(openFlag ? { open: true } : {}),
      })
    }
  }
  const pushAssistant = (event: AssistantEvent, openFlag: boolean): void => {
    for (const [blockIndex, block] of event.data.message.content.entries()) {
      if (!isTextualBlock(block)) continue
      result.push({
        key: String(event.seq) + ':' + String(blockIndex),
        turn: event.data.turn,
        eventSeq: event.seq,
        blockIndex,
        kind: block.type === 'reasoning' ? 'assistant.reasoning' : 'assistant.response',
        text: block.text,
        time: event.time,
        ...(openFlag ? { open: true } : {}),
      })
    }
  }
  for (const turn of closed) {
    if (turn.user !== undefined) pushUser(turn.user, turn.turn, false)
    for (const event of turn.assistants) pushAssistant(event, false)
  }
  if (open !== undefined) {
    if (open.user !== undefined) pushUser(open.user, open.turn, true)
    for (const event of open.assistants) pushAssistant(event, true)
  }
  return result
}

function retryableTurns(closed: readonly ClosedTurn[], open?: OpenTail): RetryableTurn[] {
  const base = closed.flatMap((turn): RetryableTurn[] => turn.user === undefined ? [] : [{
    turn: turn.turn,
    userEventSeq: turn.user.seq,
    preview: userText(turn.user.data),
    time: turn.user.time,
  }])
  if (open?.user !== undefined) {
    base.push({
      turn: open.turn,
      userEventSeq: open.user.seq,
      preview: userText(open.user.data),
      time: open.user.time,
      open: true,
    })
  }
  return base
}

function downstreamUsers(closed: readonly ClosedTurn[], start: number): UserMessage[] {
  return closed.slice(start).flatMap((turn): UserMessage[] => turn.user === undefined
    ? []
    : [cloneUser(turn.user.data)])
}

function assistantReplacement(event: AssistantEvent, blockIndex: number, text: string): AssistantMessage {
  const replaced = replaceTextBlock(event.data.message.content, blockIndex, text)
    .filter(block => block.type === 'text' || block.type === 'reasoning')
  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'assistant' as const,
    content: Object.freeze(replaced),
    source: Object.freeze({
      kind: 'model' as const,
      provider: event.data.message.source.provider,
      model: event.data.message.source.model,
    }),
  }) as AssistantMessage
}

function editPlan(operation: EditOperation, closed: readonly ClosedTurn[], open?: OpenTail): OperationPlan {
  // Prefer the open tail (the just-sent, possibly in-flight message).
  if (open !== undefined && open.user !== undefined && open.user.seq === operation.eventSeq) {
    const turn = open
    const user = open.user
    const before = user.data.content[operation.blockIndex]
    if (before?.type !== 'text') throw new Error('所选用户消息块不是文本。')
    const edited = cloneUser(user.data, replaceTextBlock(user.data.content, operation.blockIndex, operation.text))
    return {
      boundary: turn.startSeq - 1,
      version: pairVersionEffect(operation.sessionId, {
        operation: 'edit',
        cascade: 'truncate',
        targetTurn: turn.turn,
        targetEventSeq: user.seq,
        targetBlockIndex: operation.blockIndex,
        blockKind: 'user',
        before: before.text,
        after: operation.text,
      }),
      queuedUsers: [edited],
    }
  }

  const turnIndex = closed.findIndex(turn => operation.eventSeq > turn.startSeq && operation.eventSeq < turn.endSeq)
  const turn = closed[turnIndex]
  if (turn === undefined) throw new Error('所选消息不属于已落定回合。')
  const event = turn.user?.seq === operation.eventSeq
    ? turn.user
    : turn.assistants.find(candidate => candidate.seq === operation.eventSeq)
  if (event === undefined) throw new Error('所选消息不存在或不可编辑。')

  if (event.type === 'user/message') {
    const before = event.data.content[operation.blockIndex]
    if (before?.type !== 'text') throw new Error('所选用户消息块不是文本。')
    const edited = cloneUser(event.data, replaceTextBlock(event.data.content, operation.blockIndex, operation.text))
    const later = operation.cascade === 'preserve' ? downstreamUsers(closed, turnIndex + 1) : []
    return {
      boundary: turn.startSeq - 1,
      version: pairVersionEffect(operation.sessionId, {
        operation: 'edit',
        cascade: operation.cascade,
        targetTurn: turn.turn,
        targetEventSeq: event.seq,
        targetBlockIndex: operation.blockIndex,
        blockKind: 'user',
        before: before.text,
        after: operation.text,
      }),
      queuedUsers: [edited, ...later],
    }
  }

  const before = event.data.message.content[operation.blockIndex]
  if (!isTextualBlock(before)) throw new Error('所选助手消息块不是文本或思考。')
  const blockKind: EditableBlockKind = before.type === 'reasoning' ? 'assistant.reasoning' : 'assistant.response'
  if (turn.user === undefined) throw new Error('所选助手消息没有可重建的用户输入。')
  return {
    boundary: turn.startSeq - 1,
    version: pairVersionEffect(operation.sessionId, {
      operation: 'edit',
      cascade: operation.cascade,
      targetTurn: turn.turn,
      targetEventSeq: event.seq,
      targetBlockIndex: operation.blockIndex,
      blockKind,
      before: before.text,
      after: operation.text,
    }),
    manualTurn: {
      turn: turn.turn,
      user: cloneUser(turn.user.data),
      assistant: assistantReplacement(event, operation.blockIndex, operation.text),
    },
    queuedUsers: operation.cascade === 'preserve' ? downstreamUsers(closed, turnIndex + 1) : [],
  }
}

function retryPlan(
  sessionId: string, turnNumber: number, cascade: CascadePolicy,
  closed: readonly ClosedTurn[], open?: OpenTail,
): OperationPlan {
  if (open?.turn === turnNumber && open.user !== undefined) {
    return {
      boundary: open.startSeq - 1,
      version: pairVersionEffect(sessionId, {
        operation: 'retry',
        cascade: 'truncate',
        targetTurn: open.turn,
        targetEventSeq: open.user.seq,
      }),
      queuedUsers: [cloneUser(open.user.data)],
    }
  }
  const turnIndex = closed.findIndex(turn => turn.turn === turnNumber)
  const turn = closed[turnIndex]
  if (turn?.user === undefined) throw new Error('所选回合没有可重放的用户输入。')
  return {
    boundary: turn.startSeq - 1,
    version: pairVersionEffect(sessionId, {
      operation: 'retry',
      cascade,
      targetTurn: turn.turn,
      targetEventSeq: turn.user.seq,
    }),
    queuedUsers: cascade === 'preserve' ? downstreamUsers(closed, turnIndex) : [cloneUser(turn.user.data)],
  }
}

function rerollPlan(sessionId: string, closed: readonly ClosedTurn[]): OperationPlan {
  for (let index = closed.length - 1; index >= 0; index -= 1) {
    const turn = closed[index]
    if (turn?.user === undefined) continue
    const target = turn.assistants.findLast(event => event.data.message.content.some(isTextualBlock))
    if (target === undefined) continue
    return {
      boundary: turn.startSeq - 1,
      version: pairVersionEffect(sessionId, {
        operation: 'reroll',
        cascade: 'truncate',
        targetTurn: turn.turn,
        targetEventSeq: target.seq,
      }),
      queuedUsers: [cloneUser(turn.user.data)],
    }
  }
  throw new Error('当前会话没有可重生成的已落定助手回复。')
}

export function planOperation(operation: EditResendOperation, events: readonly SessionEvent[]): OperationPlan {
  const { closed, open } = foldTurns(events)
  switch (operation.action) {
    case 'edit':
      return editPlan(operation, closed, open)
    case 'reroll':
      return rerollPlan(operation.sessionId, closed)
    case 'retry':
      return retryPlan(operation.sessionId, operation.turn, operation.cascade, closed, open)
  }
}

function agentOptions(events: readonly SessionEvent[], fallback?: AgentOptions): AgentOptions {
  const config = events.findLast(event => event.type === 'request/header')?.data.header.config
  const provider = config?.provider ?? fallback?.provider
  const model = config?.model ?? fallback?.model
  if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) {
    throw new Error('无法从会话历史解析模型路由。')
  }
  const maxTokens = config?.maxTokens ?? fallback?.maxTokens
  return { provider, model, ...(maxTokens === undefined ? {} : { maxTokens }) }
}

async function withSourceAgent<T>(
  ctx: Context, sessionId: SessionId, operation: (agent: Agent) => Promise<T>,
): Promise<T> {
  let handle: AgentHandle | undefined
  let agent = ctx.agents.get(sessionId)
  if (agent === undefined) {
    const snapshot = await ctx.sessionQuery.readSession(sessionId)
    handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: agentOptions(snapshot.events),
    })
    agent = handle.agent
  }
  try {
    return await agent.runMaintenance(async () => operation(agent))
  } finally {
    await handle?.dispose()
  }
}

function inheritedSeed(source: Session, boundary: number): SessionEvent[] {
  if (boundary === -1) return []
  const boundaryEvent = source.events[boundary]
  if (boundary < 0 || boundaryEvent === undefined || boundaryEvent.seq !== boundary) {
    throw new Error('分支边界不是连续会话事件。')
  }
  return source.events.slice(0, boundary + 1)
}

function appendLogSeedEvent<T extends Exclude<SessionEventType, SurfaceEventType>>(
  events: SessionEvent[], type: T, data: SessionEvent<T>['data'],
): void {
  events.push({ type, seq: events.length, time: Date.now(), data } as SessionEvent<T>)
}

function appendSurfaceSeedEvent<T extends SurfaceEventType>(
  events: SessionEvent[], type: T, data: SessionEvent<T>['data'], intent: SurfaceIntent,
): void {
  events.push({
    type, seq: events.length, time: Date.now(), data,
    surfaceOp: intent.surfaceOp,
    ...(intent.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: intent.sourceEventSeqs }),
  } as SessionEvent<T>)
}

function appendManualTurn(events: SessionEvent[], manual: ManualAssistantTurn): void {
  const { turn, user, assistant } = manual
  appendLogSeedEvent(events, 'turn/start', { turn })
  appendSurfaceSeedEvent(events, 'user/message', user, { surfaceOp: 'append' })
  appendLogSeedEvent(events, 'step/start', { turn, step: 1 })
  appendSurfaceSeedEvent(events, 'assistant/message', { turn, step: 1, message: assistant }, {
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  appendLogSeedEvent(events, 'step/end', { turn, step: 1 })
  appendLogSeedEvent(events, 'turn/end', { turn, reason: { kind: 'completed' } })
}

function versionSeed(source: Session, plan: OperationPlan): { events: SessionEvent[]; inheritedLength: number } {
  const events = inheritedSeed(source, plan.boundary)
  const inheritedLength = events.length
  if (plan.manualTurn !== undefined) appendManualTurn(events, plan.manualTurn)
  return { events, inheritedLength }
}

function sessionPreset(session: Session): string | undefined {
  const header = session.header as unknown as { agentPreset?: string }
  if (header.agentPreset !== undefined) return header.agentPreset
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index] as unknown as { type?: string; data?: { agentPreset?: string } } | undefined
    if (event?.type === 'agent-preset/selected' && event.data?.agentPreset !== undefined) {
      return event.data.agentPreset
    }
  }
  return undefined
}

interface AgentPresetService {
  resolve(presetId: string): Promise<{ id: string }>
  mount(agentCtx: Context, presetId: string): Promise<void>
}

async function createVersionAgent(
  ctx: Context, source: Session, childId: SessionId, plan: OperationPlan, options: AgentOptions,
): Promise<AgentHandle> {
  const seed = versionSeed(source, plan)
  const presets = ctx.get('agentPresets') as AgentPresetService | undefined
  const presetId = sessionPreset(source)
  let agentPreset: string | undefined
  let setup: AgentSetup | undefined
  if (presets !== undefined && presetId !== undefined) {
    const resolved = (await presets.resolve(presetId)).id
    agentPreset = resolved
    setup = async (agentCtx) => { await presets.mount(agentCtx, resolved) }
  }
  const child = await ctx.agents.create({
    sessionId: childId,
    seed: seed.events,
    meta: {
      ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
      parentSession: source.id,
      seedLength: seed.inheritedLength,
      ...(agentPreset === undefined ? {} : { agentPreset }),
    },
    agentOptions: options,
    ...(setup === undefined ? {} : { setup }),
  })
  try {
    await ctx.sessions.flush(child.agent.session)
    return child
  } catch (error: unknown) {
    await child.dispose()
    throw error
  }
}

function sourceWorkspace(ctx: Context, sessionId: SessionId): Workspace | undefined {
  return ctx.workspaceRegistry.list().find(workspace => workspace.sessionIds.includes(sessionId))
}

type OperationInverse = () => void | Promise<void>

async function recoverOperation(inverses: OperationInverse[]): Promise<void> {
  const failures: unknown[] = []
  for (const inverse of inverses.reverse()) {
    try {
      await inverse()
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, '版本操作恢复失败。')
}

// ── Version metadata store (outside the session log) ─────────────────────────
function storePath(): string {
  const home = process.env.DSH_HOME ?? process.cwd()
  return join(home, 'storages', 'dsh-edit-resend', 'versions.json')
}

function loadStore(): Record<string, VersionRecord> {
  try {
    const raw = readFileSync(storePath(), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, VersionRecord>
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function saveStore(store: Record<string, VersionRecord>): void {
  const path = storePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(store, null, 2))
}

function rememberVersion(childId: SessionId, version: VersionRecord): void {
  const store = loadStore()
  store[childId] = version
  saveStore(store)
}

interface SessionTitleService {
  rename(session: Session, title: string): unknown
}

/** Best-effort: carry the source session's title over to the new version. */
async function inheritTitle(ctx: Context, sourceId: SessionId, childSession: Session): Promise<void> {
  const sessionTitle = ctx.get('sessionTitle') as unknown as SessionTitleService | undefined
  if (sessionTitle === undefined) return
  const snapshot = await ctx.sessionQuery.readTitle(sourceId) as unknown as { title?: string | null } | undefined
  if (snapshot?.title != null && snapshot.title.trim().length > 0) {
    sessionTitle.rename(childSession, snapshot.title)
  }
}

async function runOperation(ctx: Context, operation: EditResendOperation): Promise<EditResendOperationResult> {
  const sourceId = sessionIdOf(operation.sessionId)
  return withSourceAgent(ctx, sourceId, async (source) => {
    const childId = sessionIdOf('session-' + crypto.randomUUID())
    const inverses: OperationInverse[] = []
    try {
      const events = source.session.events
      const plan = planOperation(operation, events)
      const options = agentOptions(events, source.options)
      const child = await createVersionAgent(ctx, source.session, childId, plan, options)
      inverses.push(() => child.dispose())

      const workspace = sourceWorkspace(ctx, sourceId)
      if (workspace !== undefined) {
        await workspace.attachSession(childId)
        inverses.push(() => workspace.detachSession(childId))
      }
      for (const message of plan.queuedUsers) child.agent.followup(message)

      rememberVersion(childId, plan.version)
      inverses.length = 0
      return { sessionId: childId, queuedTurns: plan.queuedUsers.length }
    } catch (error: unknown) {
      try {
        await recoverOperation(inverses)
      } catch (recoveryError: unknown) {
        throw new AggregateError([error, recoveryError], '版本操作及其恢复均失败。')
      }
      throw error
    }
  })
}

/**
 * Post-edit finalization, run OFF the request's critical path: inherit the
 * source title and archive (soft-delete) the previous version so the sidebar
 * keeps a single conversation. Fire-and-forget; failures only warn.
 */
async function finalizeEdit(ctx: Context, sourceId: SessionId, childId: SessionId): Promise<void> {
  try {
    const childSession = ctx.agents.get(childId)?.session
    if (childSession !== undefined) await inheritTitle(ctx, sourceId, childSession)
  } catch (error: unknown) {
    ctx.logger.warn('edit-resend: inherit title failed: ' + (error instanceof Error ? error.message : String(error)))
  }
  try {
    await ctx.workspaceRegistry.archiveSession(sourceId)
  } catch (error: unknown) {
    ctx.logger.warn('edit-resend: archive source failed: ' + (error instanceof Error ? error.message : String(error)))
  }
}

// ── Timeline projection ──────────────────────────────────────────────────────
function ownVersion(
  header: { id: SessionId; parentSession?: SessionId; createdAt: number },
  store: Record<string, VersionRecord>,
): VersionRecord | undefined {
  return store[header.id]
}

function flattenLineage(
  root: SessionRecord, descendants: readonly SessionLineageNode[],
): Array<{ record: SessionRecord; depth: number }> {
  const result: Array<{ record: SessionRecord; depth: number }> = [{ record: root, depth: 0 }]
  const visit = (nodes: readonly SessionLineageNode[], depth: number): void => {
    const ordered = [...nodes].sort((left, right) => (
      left.session.header.createdAt - right.session.header.createdAt
      || String(left.session.header.id).localeCompare(String(right.session.header.id))
    ))
    for (const node of ordered) {
      result.push({ record: node.session, depth })
      visit(node.descendants, depth + 1)
    }
  }
  visit(descendants, 1)
  return result
}

/** Projection cache: one entry per viewed session, keyed by log-tail seq + version-store size. */
const timelineCache = new Map<string, { lastSeq: number; storeSize: number; timeline: EditResendTimeline }>()

async function timeline(ctx: Context, sessionId: SessionId): Promise<EditResendTimeline> {
  const store = loadStore()
  const storeSize = Object.keys(store).length

  // Cheap in-memory events while the session is live in an agent (the common
  // case during viewing) — avoids readSession's full-log clone + replay pass.
  const liveEvents = ctx.agents.get(sessionId)?.session.events
  if (liveEvents !== undefined) {
    const lastSeq = liveEvents.at(-1)?.seq ?? -1
    const cached = timelineCache.get(sessionId)
    if (cached !== undefined && cached.lastSeq === lastSeq && cached.storeSize === storeSize) {
      return cached.timeline
    }
  }

  const targetTrace = await ctx.sessionQuery.traceSession(sessionId)
  const rootId = targetTrace.complete
    ? targetTrace.root.header.id
    : targetTrace.ancestors.at(-1)?.header.id ?? sessionId
  const rootTrace = rootId === sessionId ? targetTrace : await ctx.sessionQuery.traceSession(rootId)
  const lineage = flattenLineage(rootTrace.target, rootTrace.descendants)
  const recordsById = new Map(lineage.map(({ record }) => [record.header.id, record]))
  const currentPath = new Set<SessionId>()
  let pathId: SessionId | undefined = sessionId
  while (pathId !== undefined && !currentPath.has(pathId)) {
    currentPath.add(pathId)
    pathId = recordsById.get(pathId)?.header.parentSession
  }

  const versions: VersionSummary[] = lineage.map(({ record, depth }) => {
    const header = record.header
    const version = ownVersion(header, store)
    return {
      sessionId: header.id,
      ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
      ...(version === undefined ? {} : {
        effectId: version.effect.id,
        inverseSessionId: version.inverseSessionId,
      }),
      createdAt: version?.time ?? header.createdAt,
      depth,
      current: header.id === sessionId,
      onCurrentEffectPath: currentPath.has(header.id),
      ...(version === undefined ? {} : {
        operation: version.effect.operation,
        cascade: version.effect.cascade,
        targetTurn: version.effect.targetTurn,
        ...(version.effect.blockKind === undefined ? {} : { blockKind: version.effect.blockKind }),
        ...(version.effect.before === undefined ? {} : { before: version.effect.before }),
        ...(version.effect.after === undefined ? {} : { after: version.effect.after }),
      }),
    }
  })

  const effectIds = new Set<string>()
  for (const version of versions) {
    if (version.effectId === undefined) continue
    if (effectIds.has(version.effectId)) throw new Error('版本效果重复。')
    effectIds.add(version.effectId)
  }

  const versionsById = new Map(versions.map(version => [version.sessionId, version]))
  const undoStack: string[] = []
  let undoCursor = versionsById.get(sessionId)
  while (undoCursor?.inverseSessionId !== undefined) {
    const inverseId = undoCursor.inverseSessionId
    if (undoStack.includes(inverseId)) throw new Error('版本效果逆链包含循环。')
    if (!versionsById.has(inverseId)) throw new Error('恢复目标不在可见版本树中。')
    undoStack.push(inverseId)
    undoCursor = versionsById.get(inverseId)
  }
  const redoSessionIds = versions
    .filter(version => version.inverseSessionId === sessionId)
    .map(version => version.sessionId)

  // Only the CURRENT session's events feed the editable projection; ancestor /
  // descendant logs contribute headers (already in lineage), never their events.
  const currentEvents: readonly SessionEvent[] = liveEvents
    ?? (await ctx.sessionQuery.readSession(sessionId)).events
  const { closed, open } = foldTurns(currentEvents)
  const result: EditResendTimeline = {
    sessionId,
    messages: editableMessages(closed, open),
    retryableTurns: retryableTurns(closed, open),
    versions,
    undoStack,
    redoSessionIds,
  }

  const lastSeq = currentEvents.at(-1)?.seq ?? -1
  if (timelineCache.size >= 64) {
    const oldest = timelineCache.keys().next().value
    if (oldest !== undefined) timelineCache.delete(oldest)
  }
  timelineCache.set(sessionId, { lastSeq, storeSize, timeline: result })
  return result
}

// ── Route decoding / encoding ────────────────────────────────────────────────
function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('请求体必须是 JSON 对象。')
  }
  return value as Record<string, unknown>
}

function sessionIdOf(value: unknown): SessionId {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('sessionId 必须是非空字符串。')
  return value as SessionId
}

function integerOf(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(name + ' 必须是非负安全整数。')
  return value as number
}

function cascadeOf(value: unknown): CascadePolicy {
  if (value !== 'truncate' && value !== 'preserve') throw new TypeError('cascade 必须是 truncate 或 preserve。')
  return value
}

function decodeOperation(value: unknown): EditResendOperation {
  const record = objectValue(value)
  const sessionId = sessionIdOf(record['sessionId'])
  switch (record['action']) {
    case 'edit':
      if (typeof record['text'] !== 'string') throw new TypeError('text 必须是字符串。')
      return {
        action: 'edit',
        sessionId,
        eventSeq: integerOf(record['eventSeq'], 'eventSeq'),
        blockIndex: integerOf(record['blockIndex'], 'blockIndex'),
        text: record['text'],
        cascade: cascadeOf(record['cascade']),
      }
    case 'reroll':
      return { action: 'reroll', sessionId }
    case 'retry':
      return { action: 'retry', sessionId, turn: integerOf(record['turn'], 'turn'), cascade: cascadeOf(record['cascade']) }
    default:
      throw new TypeError('action 必须是 edit、reroll 或 retry。')
  }
}

function requestJson(request: HttpRequestLike): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder()
    let text = ''
    request.on('data', (chunk) => {
      text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    })
    request.on('end', () => {
      try {
        text += decoder.decode()
        resolve(JSON.parse(text) as unknown)
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function respondJson(response: HttpResponseLike, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

async function handleRoute(ctx: Context, request: HttpRequestLike, response: HttpResponseLike): Promise<void> {
  try {
    if (request.method === 'GET') {
      const url = new URL(request.url ?? EDIT_RESEND_PATH, 'http://edit-resend.local')
      const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
      respondJson(response, 200, await timeline(ctx, sessionId))
      return
    }
    if (request.method === 'POST') {
      const operation = decodeOperation(await requestJson(request))
      const result = await runOperation(ctx, operation)
      // Defer title-inherit + archive so the edit returns to the client quickly.
      void finalizeEdit(ctx, sessionIdOf(operation.sessionId), sessionIdOf(result.sessionId))
      respondJson(response, 200, result)
      return
    }
    response.writeHead(405)
    response.end()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    respondJson(response, error instanceof TypeError ? 400 : 409, { error: message })
  }
}

/** Register the reversible route contribution. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: EDIT_RESEND_PATH,
    handler: (request, response) => handleRoute(ctx, request, response),
  }), 'edit-resend: HTTP route')
}