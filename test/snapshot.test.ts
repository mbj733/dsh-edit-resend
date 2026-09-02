import assert from 'node:assert'
import { snapshotMessages } from '../src/client/messages.ts'
import type { AssistantMessageNode, UserMessageNode } from '@deepseek-ai/dsh-client-runtime/client'

function userNode(seq: number, text: string): UserMessageNode {
  return { kind: 'user', seq, time: seq * 1000, content: [{ type: 'text', text }], source: {} } as UserMessageNode
}
function assistantNode(seq: number, turn: number, blocks: AssistantMessageNode['blocks']): AssistantMessageNode {
  return { kind: 'assistant', seq, time: seq * 1000, turn, step: 1, blocks } as AssistantMessageNode
}

const nodes = [
  userNode(1, 'first question'),
  assistantNode(2, 1, [{ kind: 'text', text: 'answer one' }]),
  userNode(5, 'second question'),
  assistantNode(6, 2, [{ kind: 'reasoning', text: 'thinking…' }, { kind: 'text', text: 'answer two' }]),
]

const blocks = snapshotMessages(nodes)

// user + assistant blocks: user(1,5) + assistant(2, 6 with 2 blocks) = 5
assert.strictEqual(blocks.length, 5, '5 editable blocks')

// user 'first' -> seq 1, turn 1 (paired with following assistant)
assert.strictEqual(blocks[0]?.eventSeq, 1)
assert.strictEqual(blocks[0]?.turn, 1)
assert.strictEqual(blocks[0]?.kind, 'user')
assert.strictEqual(blocks[0]?.text, 'first question')

// assistant 'answer one' -> seq 2, assistant.response, turn 1
assert.strictEqual(blocks[1]?.eventSeq, 2)
assert.strictEqual(blocks[1]?.turn, 1)
assert.strictEqual(blocks[1]?.kind, 'assistant.response')

// user 'second' -> seq 5, turn 2
assert.strictEqual(blocks[2]?.eventSeq, 5)
assert.strictEqual(blocks[2]?.turn, 2)

// assistant reasoning -> seq 6, assistant.reasoning, blockIndex 0
assert.strictEqual(blocks[3]?.kind, 'assistant.reasoning')
assert.strictEqual(blocks[3]?.eventSeq, 6)
assert.strictEqual(blocks[3]?.blockIndex, 0)

// assistant text -> assistant.response, blockIndex 1
assert.strictEqual(blocks[4]?.kind, 'assistant.response')
assert.strictEqual(blocks[4]?.blockIndex, 1)

console.log('snapshotMessages: OK — turn pairing, seq, blockIndex, kinds all correct')
