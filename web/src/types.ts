import type { ChatMessage, Conversation as StoredConversation } from '../../src/shared/types.ts'

export interface Message extends ChatMessage {
  streaming?: boolean
}

export interface Conversation extends Omit<StoredConversation, 'messages'> {
  messages: Message[]
}
