/** HTTP and chat types shared by the application and frontend. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Identity supplied by a client or a future channel adapter. */
export interface ConversationContext {
  userId: string
  channel: string
}

/** User message sent from client */
export interface MessageRequest extends ConversationContext {
  content: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  error?: boolean
}

export interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

/** Response after processing a message */
export interface MessageResponse {
  conversationId: string
  sessionId: string
}

/** SSE messages; text contains the current attempt's complete visible text. */
export type MessageStreamEvent =
  | { type: 'metadata'; conversationId: string }
  | { type: 'text'; text: string }
  | { type: 'event'; event: SessionEvent }
  | { type: 'done' }
  | { type: 'error'; error: string }
