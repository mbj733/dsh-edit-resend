/**
 * Browser controller for one session's Timeline projection, branch mutations,
 * and stop-in-flight cancellation.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionFace, SessionListState, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  EDIT_RESEND_PATH,
  type CascadePolicy, type EditableMessageBlock, type EditResendOperation,
  type EditResendOperationResult, type EditResendTimeline, type RetryableTurn,
  type VersionOperation, type VersionSummary,
} from '../shared.ts'

export interface EditResendState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  pending: VersionOperation | null
  timeline: EditResendTimeline | null
}

/** Outcome of one version mutation: ok, or the user-facing failure reason. */
export interface EditResendOutcome {
  ok: boolean
  error?: string
}

export interface EditResendFace {
  hooks: { editResend: ObservableSnapshot<EditResendState> }
  load(): void
  edit(message: EditableMessageBlock, text: string, cascade: CascadePolicy): Promise<EditResendOutcome>
  retry(turn: number, cascade: CascadePolicy): Promise<EditResendOutcome>
  reroll(): Promise<EditResendOutcome>
  openVersion(sessionId: string): Promise<void>
  stop(): Promise<boolean>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(label + ' 不是对象')
  return value as Record<string, unknown>
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(label + ' 不是字符串')
  return value
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(label + ' 不是数字')
  return value
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(label + ' 不是布尔值')
  return value
}

function blockKind(value: unknown): EditableMessageBlock['kind'] {
  if (value !== 'user' && value !== 'assistant.reasoning' && value !== 'assistant.response') {
    throw new TypeError('消息块类型无效')
  }
  return value
}

function decodeMessage(value: unknown, index: number): EditableMessageBlock {
  const row = objectValue(value, 'messages[' + String(index) + ']')
  return {
    key: stringValue(row['key'], '消息 key'),
    turn: numberValue(row['turn'], '消息 turn'),
    eventSeq: numberValue(row['eventSeq'], '消息 eventSeq'),
    blockIndex: numberValue(row['blockIndex'], '消息 blockIndex'),
    kind: blockKind(row['kind']),
    text: stringValue(row['text'], '消息 text'),
    time: numberValue(row['time'], '消息 time'),
    ...(row['open'] === undefined ? {} : { open: booleanValue(row['open'], '消息 open') }),
  }
}

function decodeRetryable(value: unknown, index: number): RetryableTurn {
  const row = objectValue(value, 'retryableTurns[' + String(index) + ']')
  return {
    turn: numberValue(row['turn'], '回合 turn'),
    userEventSeq: numberValue(row['userEventSeq'], '回合 userEventSeq'),
    preview: stringValue(row['preview'], '回合 preview'),
    time: numberValue(row['time'], '回合 time'),
    ...(row['open'] === undefined ? {} : { open: booleanValue(row['open'], '回合 open') }),
  }
}

function optionalOperation(value: unknown): VersionOperation | undefined {
  if (value === undefined) return undefined
  if (value === 'edit' || value === 'reroll' || value === 'retry') return value
  throw new TypeError('版本 operation 无效')
}

function decodeVersion(value: unknown, index: number): VersionSummary {
  const row = objectValue(value, 'versions[' + String(index) + ']')
  const operation = optionalOperation(row['operation'])
  const cascade = row['cascade']
  if (cascade !== undefined && cascade !== 'truncate' && cascade !== 'preserve') throw new TypeError('版本 cascade 无效')
  const kind = row['blockKind'] === undefined ? undefined : blockKind(row['blockKind'])
  return {
    sessionId: stringValue(row['sessionId'], '版本 sessionId'),
    ...(row['parentSessionId'] === undefined ? {} : { parentSessionId: stringValue(row['parentSessionId'], '版本 parentSessionId') }),
    ...(row['effectId'] === undefined ? {} : { effectId: stringValue(row['effectId'], '版本 effectId') }),
    ...(row['inverseSessionId'] === undefined ? {} : { inverseSessionId: stringValue(row['inverseSessionId'], '版本 inverseSessionId') }),
    createdAt: numberValue(row['createdAt'], '版本 createdAt'),
    depth: numberValue(row['depth'], '版本 depth'),
    current: booleanValue(row['current'], '版本 current'),
    onCurrentEffectPath: booleanValue(row['onCurrentEffectPath'], '版本 onCurrentEffectPath'),
    ...(operation === undefined ? {} : { operation }),
    ...(cascade === undefined ? {} : { cascade }),
    ...(row['targetTurn'] === undefined ? {} : { targetTurn: numberValue(row['targetTurn'], '版本 targetTurn') }),
    ...(kind === undefined ? {} : { blockKind: kind }),
    ...(row['before'] === undefined ? {} : { before: stringValue(row['before'], '版本 before') }),
    ...(row['after'] === undefined ? {} : { after: stringValue(row['after'], '版本 after') }),
  }
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(label + ' 不是数组')
  return value
}

function stringArray(value: unknown, label: string): string[] {
  return arrayValue(value, label).map((item, index) => stringValue(item, label + '[' + String(index) + ']'))
}

function decodeTimeline(value: unknown): EditResendTimeline {
  const data = objectValue(value, 'Timeline 响应')
  return {
    sessionId: stringValue(data['sessionId'], 'Timeline sessionId'),
    messages: arrayValue(data['messages'], 'Timeline messages').map(decodeMessage),
    retryableTurns: arrayValue(data['retryableTurns'], 'Timeline retryableTurns').map(decodeRetryable),
    versions: arrayValue(data['versions'], 'Timeline versions').map(decodeVersion),
    undoStack: stringArray(data['undoStack'], 'Timeline undoStack'),
    redoSessionIds: stringArray(data['redoSessionIds'], 'Timeline redoSessionIds'),
  }
}

function decodeOperationResult(value: unknown): EditResendOperationResult {
  const data = objectValue(value, '操作响应')
  return {
    sessionId: stringValue(data['sessionId'], '操作 sessionId'),
    queuedTurns: numberValue(data['queuedTurns'], '操作 queuedTurns'),
  }
}

async function responseValue(response: Response): Promise<unknown> {
  const value = await response.json() as unknown
  if (response.ok) return value
  const error = objectValue(value, '错误响应')['error']
  throw new Error(typeof error === 'string' ? error : '请求失败：HTTP ' + String(response.status))
}

/**
 * Refresh key: only the running flag and the highest completed turn move the
 * host projection. History paging (older turns, hasMore/removed/openState) does
 * NOT change the host-side full-log result, so it must not trigger a refetch.
 */
function conversationRevision(snapshot: SessionSnapshot): string {
  // alpha.3 split the old snapshot: lifecycle lives on SessionSnapshot (running,
  // queue), message nodes live in conversation views. Turn completion always
  // settles 'running' and drains the queue, so running + queue length is a
  // sufficient refetch key; history-paging fields are deliberately excluded.
  return (snapshot.running ? 'R' : 'r') + ':' + String(snapshot.queue.length)
}

function lineageRevision(snapshot: SessionListState, sessionId: SessionId): string {
  let root = sessionId
  const ancestorIds = new Set<SessionId>()
  while (!ancestorIds.has(root)) {
    ancestorIds.add(root)
    const parent = snapshot.byId[root]?.parentId
    if (parent === undefined || snapshot.byId[parent] === undefined) break
    root = parent
  }
  const connected: string[] = []
  for (const rawId of Object.keys(snapshot.byId).sort()) {
    const id = rawId as SessionId
    const seen = new Set<SessionId>()
    let cursor: SessionId | undefined = id
    while (cursor !== undefined && !seen.has(cursor)) {
      if (cursor === root) {
        connected.push(id + '>' + (snapshot.byId[id]?.parentId ?? ''))
        break
      }
      seen.add(cursor)
      cursor = snapshot.byId[cursor]?.parentId
    }
  }
  return connected.join('|')
}

export class EditResendController {
  readonly store: SnapshotStore<EditResendState> = createSnapshotStore<EditResendState>({
    status: 'idle',
    error: null,
    pending: null,
    timeline: null,
  })

  readonly face: EditResendFace
  private generation = 0
  private readonly sessions: ISessions
  private sessionSource: SessionFace | undefined
  private sessionSourceDispose: (() => void) | undefined
  private sessionRevision: string | undefined
  private listRevision = ''
  private refreshScheduled = false
  private observing = false
  private readonly navigationWaits = new Set<() => void>()

  constructor(ctx: Context, private readonly sessionId: SessionId) {
    this.sessions = ctx.get('sessions') as unknown as ISessions
    this.face = {
      hooks: { editResend: this.store },
      load: () => { void this.load() },
      edit: (message, text, cascade) => this.mutate({
        action: 'edit',
        sessionId: this.sessionId,
        eventSeq: message.eventSeq,
        blockIndex: message.blockIndex,
        text,
        cascade,
      }),
      retry: (turn, cascade) => this.mutate({ action: 'retry', sessionId: this.sessionId, turn, cascade }),
      reroll: () => this.mutate({ action: 'reroll', sessionId: this.sessionId }),
      openVersion: sessionId => this.openWhenListed(sessionId as SessionId),
      stop: () => this.stop(),
    }
    ctx.effect(() => this.observeDependencies(), 'edit-resend: observe ' + sessionId)
  }

  private observeDependencies(): () => void {
    this.observing = true
    this.listRevision = lineageRevision(this.sessions.list.getSnapshot(), this.sessionId)
    this.bindSessionSource()
    const disposeList = this.sessions.list.subscribe(() => {
      const rebound = this.bindSessionSource()
      const nextRevision = lineageRevision(this.sessions.list.getSnapshot(), this.sessionId)
      if (nextRevision === this.listRevision && !rebound) return
      this.listRevision = nextRevision
      this.invalidate()
    })
    return () => {
      this.observing = false
      this.generation += 1
      disposeList()
      this.sessionSourceDispose?.()
      this.sessionSourceDispose = undefined
      this.sessionSource = undefined
      this.sessionRevision = undefined
      for (const cancel of [...this.navigationWaits]) cancel()
    }
  }

  private bindSessionSource(): boolean {
    const source = this.sessions.binding(this.sessionId)?.session
    if (source === this.sessionSource) return false
    this.sessionSourceDispose?.()
    this.sessionSource = source
    this.sessionRevision = source === undefined ? undefined : conversationRevision(source.getSnapshot())
    this.sessionSourceDispose = source?.subscribe(() => {
      if (this.sessionSource !== source) return
      const revision = conversationRevision(source.getSnapshot())
      if (revision === this.sessionRevision) return
      this.sessionRevision = revision
      this.invalidate()
    })
    return true
  }

  private invalidate(): void {
    if (!this.observing || this.store.getSnapshot().status === 'idle' || this.refreshScheduled) return
    this.refreshScheduled = true
    // Debounce across macrotasks: rapid snapshot updates (e.g. turn/end settling
    // or a burst of paging events) collapse into one projection refetch.
    setTimeout(() => {
      this.refreshScheduled = false
      if (this.observing && this.store.getSnapshot().status !== 'idle') void this.load()
    }, 200)
  }

  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((state) => { state.status = 'loading'; state.error = null })
    try {
      const response = await fetch(EDIT_RESEND_PATH + '?sessionId=' + encodeURIComponent(this.sessionId), {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      const timeline = decodeTimeline(await responseValue(response))
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'ready'
        state.error = null
        state.timeline = timeline
      })
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'error'
        state.error = messageOf(error)
      })
    }
  }

  refreshIfLoaded(): void {
    if (this.store.getSnapshot().status !== 'idle') void this.load()
  }

  private async mutate(operation: EditResendOperation): Promise<EditResendOutcome> {
    const current = this.store.getSnapshot()
    if (current.pending !== null || current.status !== 'ready') {
      return { ok: false, error: '时间线尚未就绪，请稍候再试。' }
    }
    this.store.update((state) => { state.pending = operation.action; state.error = null })
    try {
      const response = await fetch(EDIT_RESEND_PATH, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(operation),
      })
      const result = decodeOperationResult(await responseValue(response))
      this.store.update((state) => { state.pending = null })
      await this.openWhenListed(result.sessionId as SessionId)
      return { ok: true }
    } catch (error) {
      const message = messageOf(error)
      this.store.update((state) => { state.pending = null; state.error = message })
      return { ok: false, error: message }
    }
  }

  /** Cancel the in-flight reply via the session face (preserving the pending queue). */
  private async stop(): Promise<boolean> {
    const session = this.sessions.binding(this.sessionId)?.session
    if (session === undefined) return false
    try {
      const result = await session.cancel()
      return result.ok
    } catch {
      return false
    }
  }

  private openWhenListed(sessionId: SessionId): Promise<void> {
    if (this.sessions.list.getSnapshot().byId[sessionId] !== undefined) {
      this.sessions.open(sessionId)
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      let settled = false
      let dispose = (): void => {}
      const finish = (open: boolean): void => {
        if (settled) return
        settled = true
        dispose()
        this.navigationWaits.delete(cancel)
        if (open) this.sessions.open(sessionId)
        resolve()
      }
      const cancel = (): void => { finish(false) }
      this.navigationWaits.add(cancel)
      dispose = this.sessions.list.subscribe(() => {
        if (this.sessions.list.getSnapshot().byId[sessionId] === undefined) return
        finish(true)
      })
      if (this.sessions.list.getSnapshot().byId[sessionId] !== undefined) finish(true)
    })
  }
}
