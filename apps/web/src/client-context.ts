import type { ConversationContext } from '@ghost/contracts'

/** Frontend identity defaults; future login/channel clients supply their own context. */
export const clientContext: Readonly<ConversationContext> = {
  userId: 'owner',
  channel: 'main',
}
