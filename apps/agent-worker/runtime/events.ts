/** Full runtime input to the application handler; only Worker code depends on DSH. */
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentExecution } from '@ghost/contracts'

export type AgentRuntimeEvent = { type: 'session'; event: SessionEvent }
  | { type: 'assistant-stream'; frame: AssistantStreamFrame }
export interface AgentExecutor {
  execute(run: AgentExecution, signal: AbortSignal, onEvent: (event: AgentRuntimeEvent) => void): Promise<void>
}
