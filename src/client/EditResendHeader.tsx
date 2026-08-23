import { useEffect, useMemo, type ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { EditResendFace } from './controller.ts'
import { snapshotMessages } from './messages.ts'
import { InlineEdit } from './InlineEdit.tsx'
import styles from './EditResendHeader.module.css'

type EditResendHeaderProps = PropsRuntime<'conversation.session.header.actions'> & InjectFace<EditResendFace>

export function EditResendHeader({
  useEditResend,
  useSession,
  load,
  openVersion,
  reroll,
  stop,
  edit,
  retry,
}: EditResendHeaderProps): ReactNode {
  const state = useEditResend(value => value)
  const running = useSession(snapshot => snapshot.running)
  // Zero-latency inline icons: derived synchronously from the session snapshot
  // (same source the built-in copy icon uses), never gated on the async load().
  const nodes = useSession(snapshot => snapshot.nodes)
  const syncMessages = useMemo(() => snapshotMessages(nodes), [nodes])

  useEffect(() => { load() }, [load])

  const timeline = state.timeline
  const undoSessionId = timeline?.undoStack[0]
  const redoSessionId = timeline?.redoSessionIds.at(-1)
  const effectDepth = timeline?.undoStack.length ?? 0
  const versionCount = timeline?.versions.length ?? 0
  const busy = state.pending !== null || state.status !== 'ready'

  return (
    <>
      <InlineEdit
        messages={syncMessages}
        edit={edit}
        retry={retry}
      />
      {state.error === null ? null : (
        <div className={styles['error']} role="alert">{state.error}</div>
      )}
      <div className={styles['root']}>
        {running
          ? (
            <button
              type="button"
              className={styles['stopButton']}
              title="停止当前回复，之后可直接编辑并重新发送"
              onClick={() => { void stop() }}
            >
              ■ 停止
            </button>
          )
          : null}
        <button
          type="button"
          className={styles['iconButton']}
          aria-label="撤销当前版本效果"
          title="撤销当前效果"
          disabled={undoSessionId === undefined || busy}
          onClick={() => { if (undoSessionId !== undefined) void openVersion(undoSessionId) }}
        >
          ←
        </button>
        <span className={styles['counter']}>
          {versionCount === 0 ? '编辑 —' : '编辑 ' + String(effectDepth) + ' 层 · ' + String(versionCount) + ' 版'}
        </span>
        <button
          type="button"
          className={styles['iconButton']}
          aria-label="重施加下一版本效果"
          title="重施加下一效果"
          disabled={redoSessionId === undefined || busy}
          onClick={() => { if (redoSessionId !== undefined) void openVersion(redoSessionId) }}
        >
          →
        </button>
        <button
          type="button"
          className={styles['rerollButton']}
          disabled={busy || timeline === null}
          onClick={() => { void reroll() }}
        >
          {state.pending === 'reroll' ? '重生成中…' : '重生成'}
        </button>
      </div>
    </>
  )
}
