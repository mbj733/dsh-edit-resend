/** Timeline tab: durable version tree plus turn/block edit, retry, and reroll. */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CascadePolicy, EditableBlockKind, EditableMessageBlock, RetryableTurn,
  VersionOperation, VersionSummary,
} from '../shared.ts'
import type { EditResendFace } from './controller.ts'
import styles from './EditResendTimelineView.module.css'

type EditResendTimelineViewProps = ConvViewProps & InjectFace<EditResendFace>

interface TurnSection {
  retry: RetryableTurn
  messages: EditableMessageBlock[]
}

interface EditingState {
  message: EditableMessageBlock
  text: string
}

const BLOCK_LABEL: Record<EditableBlockKind, string> = {
  user: '用户消息',
  'assistant.reasoning': '助手思考',
  'assistant.response': '助手回复',
}

const OPERATION_LABEL: Record<VersionOperation, string> = {
  edit: '编辑',
  reroll: '重生成',
  retry: '重试',
}

function timeLabel(value: number): string {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function turnSections(turns: readonly RetryableTurn[], messages: readonly EditableMessageBlock[]): TurnSection[] {
  return turns.map(retry => ({ retry, messages: messages.filter(message => message.turn === retry.turn) }))
}

function VersionRow({ version, disabled, onOpen }: {
  version: VersionSummary
  disabled: boolean
  onOpen: (sessionId: string) => void
}): ReactNode {
  const depthStyle = { '--edit-resend-depth': String(version.depth) } as CSSProperties
  const operation = version.operation === undefined
    ? version.parentSessionId === undefined ? '原始版本' : '外部分支'
    : OPERATION_LABEL[version.operation]
  return (
    <li className={styles['versionItem']} style={depthStyle}>
      <button
        type="button"
        className={styles['versionButton']}
        data-current={version.current || undefined}
        disabled={version.current || disabled}
        onClick={() => { onOpen(version.sessionId) }}
      >
        <span className={styles['versionLine']} aria-hidden />
        <span className={styles['versionDot']} aria-hidden />
        <span className={styles['versionMain']}>
          <span className={styles['versionTitle']}>
            {operation}
            {version.targetTurn === undefined ? null : ' · 回合 ' + String(version.targetTurn)}
          </span>
          <span className={styles['versionMeta']}>
            {timeLabel(version.createdAt)} · {version.sessionId.slice(0, 12)}
          </span>
          {version.before === undefined && version.after === undefined
            ? null
            : (
              <span className={styles['versionDiff']}>
                <span>原：{version.before || '（空）'}</span>
                <span>新：{version.after || '（空）'}</span>
              </span>
            )}
        </span>
        {version.current
          ? <span className={styles['currentBadge']}>当前</span>
          : version.onCurrentEffectPath ? <span className={styles['pathBadge']}>链上</span> : null}
      </button>
    </li>
  )
}

function MessageCard({
  message, editing, disabled, cascade,
  onBeginEdit, onCancelEdit, onTextChange, onApplyEdit,
}: {
  message: EditableMessageBlock
  editing: EditingState | null
  disabled: boolean
  cascade: CascadePolicy
  onBeginEdit: (message: EditableMessageBlock) => void
  onCancelEdit: () => void
  onTextChange: (text: string) => void
  onApplyEdit: (message: EditableMessageBlock, text: string, cascade: CascadePolicy) => void
}): ReactNode {
  const active = editing?.message.key === message.key
  return (
    <article className={styles['messageCard']}>
      <div className={styles['messageHeader']}>
        <span className={styles['kindBadge']} data-kind={message.kind}>{BLOCK_LABEL[message.kind]}</span>
        {message.open === true ? <span className={styles['openBadge']}>待重发</span> : null}
        <span className={styles['messageTime']}>{timeLabel(message.time)}</span>
        <button
          type="button"
          className={styles['textButton']}
          disabled={disabled}
          onClick={() => { active ? onCancelEdit() : onBeginEdit(message) }}
        >
          {active ? '取消' : '编辑'}
        </button>
      </div>
      {active && editing !== null
        ? (
          <div className={styles['editor']}>
            <textarea
              className={styles['textarea']}
              value={editing.text}
              rows={6}
              autoFocus
              onChange={(event) => { onTextChange(event.currentTarget.value) }}
            />
            <div className={styles['editorActions']}>
              <span className={styles['editorHint']}>将从该回合之前分支，原版本保持不变。</span>
              <button
                type="button"
                className={styles['primaryButton']}
                disabled={disabled}
                onClick={() => { onApplyEdit(message, editing.text, cascade) }}
              >
                应用并重新发送
              </button>
            </div>
          </div>
        )
        : <pre className={styles['messageText']}>{message.text || '（空内容）'}</pre>}
    </article>
  )
}

export function EditResendTimelineView({
  useEditResend, load, edit, retry, reroll, openVersion,
}: EditResendTimelineViewProps): ReactNode {
  const state = useEditResend(value => value)
  const [cascade, setCascade] = useState<CascadePolicy>('truncate')
  const [editing, setEditing] = useState<EditingState | null>(null)

  useEffect(() => { load() }, [load])

  const timeline = state.timeline
  const sections = useMemo(
    () => timeline === null ? [] : turnSections(timeline.retryableTurns, timeline.messages),
    [timeline],
  )
  const busy = state.pending !== null || state.status !== 'ready'

  useEffect(() => {
    setEditing((current) => {
      if (current === null || timeline === null) return current
      return timeline.messages.some(message => message.key === current.message.key) ? current : null
    })
  }, [timeline])

  if (timeline === null && (state.status === 'idle' || state.status === 'loading')) {
    return <div className={styles['status']}>正在载入消息时间线…</div>
  }
  if (timeline === null && state.status === 'error') {
    return (
      <div className={styles['status']}>
        <p className={styles['error']}>{state.error}</p>
        <button type="button" className={styles['secondaryButton']} onClick={load}>重新载入</button>
      </div>
    )
  }
  if (timeline === null) return null

  const applyEdit = (message: EditableMessageBlock, text: string, policy: CascadePolicy): void => {
    setEditing(null)
    void edit(message, text, policy)
  }

  return (
    <div className={styles['root']}>
      <header className={styles['pageHeader']}>
        <div>
          <h1 className={styles['title']}>编辑与重新发送</h1>
          <p className={styles['intro']}>
            可编辑已发送的消息（含正在回复中的最后一条）：先点标题栏的「停止」，再编辑并重新发送。每次修改都保留原版本，可随时切回。
          </p>
        </div>
        <div className={styles['headerActions']}>
          <label className={styles['cascadeField']}>
            <span>后续策略</span>
            <select
              className={styles['select']}
              value={cascade}
              disabled={busy}
              onChange={(event) => { setCascade(event.currentTarget.value as CascadePolicy) }}
            >
              <option value="truncate">截断后续（默认）</option>
              <option value="preserve">保留输入并重生成后续</option>
            </select>
          </label>
          <button type="button" className={styles['primaryButton']} disabled={busy} onClick={() => { void reroll() }}>
            {state.pending === 'reroll' ? '正在重生成…' : '重生成最后回复'}
          </button>
        </div>
      </header>

      {state.error === null ? null : <p className={styles['error']}>{state.error}</p>}
      {state.status === 'loading' ? <p className={styles['notice']}>正在刷新时间线…</p> : null}

      <div className={styles['columns']}>
        <aside className={styles['versionsPanel']} aria-label="版本时间线">
          <div className={styles['sectionHeading']}>
            <h2 className={styles['subtitle']}>版本时间线</h2>
            <span className={styles['count']}>{String(timeline.versions.length)}</span>
          </div>
          <div className={styles['effectControls']}>
            <span className={styles['effectDepth']}>当前效果链 {String(timeline.undoStack.length)} 层</span>
            <div className={styles['effectButtons']}>
              <button
                type="button"
                className={styles['secondaryButton']}
                disabled={busy || timeline.undoStack[0] === undefined}
                onClick={() => { const target = timeline.undoStack[0]; if (target !== undefined) void openVersion(target) }}
              >
                撤销当前效果
              </button>
              <button
                type="button"
                className={styles['secondaryButton']}
                disabled={busy || timeline.redoSessionIds.length === 0}
                onClick={() => { const target = timeline.redoSessionIds.at(-1); if (target !== undefined) void openVersion(target) }}
              >
                重施加下一效果
              </button>
            </div>
          </div>
          <ol className={styles['versionList']}>
            {timeline.versions.map(version => (
              <VersionRow key={version.sessionId} version={version} disabled={busy} onOpen={(sid) => { void openVersion(sid) }} />
            ))}
          </ol>
        </aside>

        <main className={styles['turnsPanel']}>
          <div className={styles['sectionHeading']}>
            <h2 className={styles['subtitle']}>消息</h2>
            <span className={styles['count']}>{String(timeline.messages.length)}</span>
          </div>
          {sections.length === 0
            ? <p className={styles['empty']}>当前会话还没有可编辑的消息。</p>
            : (
              <ol className={styles['turnList']}>
                {sections.map(section => (
                  <li key={String(section.retry.turn)} className={styles['turnSection']}>
                    <div className={styles['turnHeader']}>
                      <div>
                        <h3 className={styles['turnTitle']}>回合 {String(section.retry.turn)}</h3>
                        <p className={styles['turnPreview']}>{section.retry.preview || '（空用户输入）'}</p>
                      </div>
                      <button
                        type="button"
                        className={styles['secondaryButton']}
                        disabled={busy}
                        onClick={() => { void retry(section.retry.turn, cascade) }}
                      >
                        {state.pending === 'retry' ? '正在重试…' : '重试此回合'}
                      </button>
                    </div>
                    <div className={styles['messageList']}>
                      {section.messages.map(message => (
                        <MessageCard
                          key={message.key}
                          message={message}
                          editing={editing}
                          disabled={busy}
                          cascade={cascade}
                          onBeginEdit={value => { setEditing({ message: value, text: value.text }) }}
                          onCancelEdit={() => { setEditing(null) }}
                          onTextChange={(text) => { setEditing(current => current === null ? null : { ...current, text }) }}
                          onApplyEdit={applyEdit}
                        />
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
            )}
        </main>
      </div>
    </div>
  )
}