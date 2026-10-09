import type { ConversationContext } from '@ghost/contracts'

/** All channels currently share the user's main conversation. */
export function resolveConversation(context: ConversationContext) {
  return {
    userId: context.userId.trim(),
    channel: context.channel,
    // Channel-specific conversation policies can be introduced here later.
    conversationId: 'main',
  }
}
