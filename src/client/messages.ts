import type { AssistantMessageNode, ConversationNode, UserMessageNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { EditableMessageBlock } from '../shared.ts'

/**
 * Synchronously derive editable message blocks from the conversation snapshot's
 * finalized nodes. This is the zero-latency source for the inline edit/retry
 * icons: it needs no host round-trip, so the icons render with the message
 * (exactly like the built-in copy icon). The host Timeline tab still uses the
 * richer server projection for version-tree / per-block editing.
 */
export function snapshotMessages(nodes: readonly ConversationNode[]): EditableMessageBlock[] {
  const result: EditableMessageBlock[] = []
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (node === undefined) continue
    if (node.kind === 'user') {
      const user = node as UserMessageNode
      // A finalized user node carries the user/message event seq but no turn;
      // the following finalized assistant node (same turn) supplies it.
      let turn = 0
      for (let j = index + 1; j < nodes.length; j += 1) {
        const next = nodes[j]
        if (next?.kind === 'assistant') { turn = (next as AssistantMessageNode).turn; break }
        if (next?.kind === 'user') break
      }
      for (const [blockIndex, block] of user.content.entries()) {
        if (block.type !== 'text') continue
        result.push({
          key: String(user.seq) + ':' + String(blockIndex),
          turn,
          eventSeq: user.seq,
          blockIndex,
          kind: 'user',
          text: block.text,
          time: user.time,
        })
      }
    } else if (node.kind === 'assistant') {
      const assistant = node as AssistantMessageNode
      for (const [blockIndex, block] of assistant.blocks.entries()) {
        if (block.kind !== 'text' && block.kind !== 'reasoning') continue
        result.push({
          key: String(assistant.seq) + ':' + String(blockIndex),
          turn: assistant.turn,
          eventSeq: assistant.seq,
          blockIndex,
          kind: block.kind === 'reasoning' ? 'assistant.reasoning' : 'assistant.response',
          text: block.text,
          time: assistant.time,
        })
      }
    }
  }
  return result
}