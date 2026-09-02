/** Same-origin endpoint owned by the Edit & Resend host plugin. */
export const EDIT_RESEND_PATH = '/edit-resend'

/** Timeline view order: between Trajectory (10) and Prompt Studio (20). */
export const VIEW_ORDER = 15

/** Downstream-history policy after a historical turn changes. */
export type CascadePolicy = 'truncate' | 'preserve'

/** User-visible operation represented by one child version. */
export type VersionOperation = 'edit' | 'reroll' | 'retry'

/** Editable model-surface block classification. */
export type EditableBlockKind = 'user' | 'assistant.reasoning' | 'assistant.response'

/** Forward half of one atomic version effect (stored OUTSIDE the session log). */
export interface VersionEffect {
  id: string
  operation: VersionOperation
  cascade: CascadePolicy
  targetTurn: number
  targetEventSeq: number
  targetBlockIndex?: number
  blockKind?: EditableBlockKind
  before?: string
  after?: string
}

/** Durable metadata for one branch version, keyed by child session id. */
export interface VersionRecord {
  effect: VersionEffect
  /** The session id this version restores to on undo. */
  inverseSessionId: string
  time: number
}

/** One text-bearing block that the Timeline editor can replace. */
export interface EditableMessageBlock {
  key: string
  turn: number
  eventSeq: number
  blockIndex: number
  kind: EditableBlockKind
  text: string
  time: number
  /** true when the block belongs to the still-open (in-flight/aborted) tail turn. */
  open?: boolean
}

/** One completed message-triggered turn eligible for Retry. */
export interface RetryableTurn {
  turn: number
  userEventSeq: number
  preview: string
  time: number
  open?: boolean
}

/** One session version in the complete known lineage tree. */
export interface VersionSummary {
  sessionId: string
  parentSessionId?: string
  effectId?: string
  inverseSessionId?: string
  createdAt: number
  depth: number
  current: boolean
  onCurrentEffectPath: boolean
  operation?: VersionOperation
  cascade?: CascadePolicy
  targetTurn?: number
  blockKind?: EditableBlockKind
  before?: string
  after?: string
}

/** Complete value-level projection consumed by Timeline and header controls. */
export interface EditResendTimeline {
  sessionId: string
  messages: EditableMessageBlock[]
  retryableTurns: RetryableTurn[]
  versions: VersionSummary[]
  /** Atomic inverses from the current version outward, in application order. */
  undoStack: string[]
  /** Direct child effects that can be re-applied from the current version. */
  redoSessionIds: string[]
}

/** Edit one text/reasoning block and regenerate from its turn boundary. */
export interface EditOperation {
  action: 'edit'
  sessionId: string
  eventSeq: number
  blockIndex: number
  text: string
  cascade: CascadePolicy
}

/** Regenerate the latest completed assistant reply. */
export interface RerollOperation {
  action: 'reroll'
  sessionId: string
}

/** Regenerate any selected historical turn. */
export interface RetryOperation {
  action: 'retry'
  sessionId: string
  turn: number
  cascade: CascadePolicy
}

/** Mutation accepted by the host route. */
export type EditResendOperation = EditOperation | RerollOperation | RetryOperation

/** Host acknowledgement after the child Agent has been published and queued. */
export interface EditResendOperationResult {
  sessionId: string
  queuedTurns: number
}
