/** Edit & Resend browser half: Timeline view, header controls, inline edit, and stop-in-flight. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// The slots service typing is declared by ui-renderer's client face.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { VIEW_ORDER } from '../shared.ts'
import { EditResendController } from './controller.ts'
import { EditResendHeader } from './EditResendHeader.tsx'
import { EditResendTimelineView } from './EditResendTimelineView.tsx'

export const inject = ['slots', 'conversation', 'connection', 'sessions']

export function apply(ctx: Context): void {
  const controllers = new Map<SessionId, EditResendController>()
  const controllerFor = (sessionId: SessionId): EditResendController => {
    let controller = controllers.get(sessionId)
    if (controller === undefined) {
      controller = new EditResendController(ctx, sessionId)
      controllers.set(sessionId, controller)
    }
    return controller
  }

  ctx.on('connection/reset', () => {
    for (const controller of controllers.values()) controller.refreshIfLoaded()
  })

  ctx.slots.register({
    name: 'conversation.view',
    id: 'edit-resend-timeline',
    order: VIEW_ORDER,
    label: '编辑与重发',
    inject: (sessionId: SessionId) => controllerFor(sessionId).face,
  }, EditResendTimelineView)

  ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'edit-resend-controls',
    order: VIEW_ORDER,
    inject: (sessionId: SessionId) => controllerFor(sessionId).face,
  }, EditResendHeader)
}
