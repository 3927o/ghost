import type { ConversationContext } from '../../src/shared/types.ts'

/** Frontend identity defaults; future login/channel clients supply their own context. */
export const clientContext: Readonly<ConversationContext> = {
  userId: 'owner',
  channel: 'main',
}
