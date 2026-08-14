import assert from 'node:assert'
import { foldTurns, planOperation } from '../src/host.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

function ev(type: string, data: unknown, seq: number): SessionEvent {
  return { type, seq, time: seq * 1000, data } as SessionEvent
}

function userEvent(seq: number, text: string): SessionEvent {
  return ev('user/message', {
    id: 'u-' + seq, role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }, seq)
}

function assistantEvent(seq: number, turn: number, text: string): SessionEvent {
  return ev('assistant/message', {
    turn, step: 1,
    message: {
      id: 'a-' + seq, role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
  }, seq)
}

// Scenario: one closed turn (seqs 0..3), then an open tail turn (seqs 4..5, no turn/end).
const events: SessionEvent[] = [
  ev('turn/start', { turn: 1 }, 0),
  userEvent(1, 'first question'),
  assistantEvent(2, 1, 'first answer'),
  ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3),
  ev('turn/start', { turn: 2 }, 4),
  userEvent(5, 'second question (in flight)'),
]

const folded = foldTurns(events)
assert.strictEqual(folded.closed.length, 1, 'one closed turn')
assert.strictEqual(folded.closed[0]?.turn, 1)
assert.ok(folded.open, 'open tail present')
assert.strictEqual(folded.open?.turn, 2)
assert.strictEqual(folded.open?.user?.seq, 5)
console.log('foldTurns: OK  closed=1 openTurn=2 openUserSeq=5')

// 1) edit the OPEN tail user message -> boundary = turn2.startSeq - 1 = 3, truncate, edited text queued
const openPlan = planOperation({
  action: 'edit', sessionId: 's-src', eventSeq: 5, blockIndex: 0, text: 'EDITED second question', cascade: 'truncate',
}, events)
assert.strictEqual(openPlan.boundary, 3, 'open-tail edit boundary is before turn 2')
assert.strictEqual(openPlan.queuedUsers.length, 1, 'open-tail edit queues exactly the edited message')
assert.ok(openPlan.queuedUsers[0]?.content[0] && (openPlan.queuedUsers[0].content[0] as { text?: string }).text === 'EDITED second question')
assert.strictEqual(openPlan.version.effect.operation, 'edit')
console.log('edit(open tail): OK  boundary=3 queued=1 text=edited')

// 2) edit the CLOSED turn user message -> boundary = turn1.startSeq - 1 = -1, truncate
const closedPlan = planOperation({
  action: 'edit', sessionId: 's-src', eventSeq: 1, blockIndex: 0, text: 'EDITED first', cascade: 'truncate',
}, events)
assert.strictEqual(closedPlan.boundary, -1, 'closed-turn edit boundary is -1 (empty seed)')
assert.strictEqual(closedPlan.queuedUsers.length, 1)
console.log('edit(closed turn): OK  boundary=-1 queued=1')

// 3) reroll -> targets last closed assistant (turn 1), boundary -1
const reroll = planOperation({ action: 'reroll', sessionId: 's-src' }, events)
assert.strictEqual(reroll.boundary, -1)
assert.strictEqual(reroll.version.effect.operation, 'reroll')
assert.strictEqual(reroll.queuedUsers.length, 1)
assert.ok((reroll.queuedUsers[0]?.content[0] as { text?: string }).text === 'first question')
console.log('reroll: OK  boundary=-1 target=last-closed')

// 4) retry the OPEN tail turn -> boundary 3
const retryOpen = planOperation({ action: 'retry', sessionId: 's-src', turn: 2, cascade: 'truncate' }, events)
assert.strictEqual(retryOpen.boundary, 3)
assert.strictEqual(retryOpen.queuedUsers.length, 1)
console.log('retry(open tail): OK  boundary=3')

// 5) retry the closed turn -> boundary -1
const retryClosed = planOperation({ action: 'retry', sessionId: 's-src', turn: 1, cascade: 'truncate' }, events)
assert.strictEqual(retryClosed.boundary, -1)
console.log('retry(closed): OK  boundary=-1')

// 6) edit with preserve on a closed turn keeps downstream users (none here -> empty)
const preserve = planOperation({
  action: 'edit', sessionId: 's-src', eventSeq: 1, blockIndex: 0, text: 'x', cascade: 'preserve',
}, events)
assert.strictEqual(preserve.queuedUsers.length, 1, 'preserve with no later users queues only edited')
console.log('edit(closed preserve): OK')

console.log('ALL LOGIC TESTS PASSED')