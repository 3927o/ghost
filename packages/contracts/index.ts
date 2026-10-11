/** Public application protocol. These JSON values are independent of the Agent SDK. */
export interface ConversationContext {
  userId: string
  channel: string
}

export interface MessageRequest extends ConversationContext {
  content: string
  /** Stable across retries of the same submission. */
  requestId: string
}

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  error?: boolean
  runId?: string
  streaming?: boolean
  parts?: RunPart[]
  failure?: string
}

export interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
  activeRunIds: string[]
}

export interface RunSnapshot {
  id: string
  conversationId: string
  assistantMessageId: string
  status: RunStatus
  text: string
  error: string | null
  revision: number
  createdAt: number
  updatedAt: number
  parts: RunPart[]
  lastEventSeq: number
}

export interface MessageResponse {
  conversationId: string
  runId: string
  accepted: boolean
}

import type { RunPart, RunEvent } from './run-events.ts'
export * from './run-events.ts'

/** Bootstrap from a snapshot, then deliver ordered, replayable application events. */
export type RunStreamEvent = { type: 'snapshot'; run: RunSnapshot } | RunEvent

export function isTerminalRun(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed'
}

/** Redis carries identifiers; authoritative inputs and results remain in business storage. */
export interface RunJob { runId: string }

export interface AgentExecution { id: string; sessionId: string; input: string }
