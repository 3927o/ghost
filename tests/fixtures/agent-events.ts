import { LlmAttemptId, ToolCallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { AgentRuntimeEvent } from '../../apps/agent-worker/runtime/events.ts'

export function startText(emit: (event: AgentRuntimeEvent) => void, id = 'test-attempt', step = 1): void {
  emit({ type: 'assistant-stream', frame: { type: 'start', attemptId: LlmAttemptId(id), revision: step, turn: 1, step } })
}
export function deltaText(emit: (event: AgentRuntimeEvent) => void, text: string, id = 'test-attempt', index = 0): void {
  emit({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: LlmAttemptId(id), revision: 1, index: 0, time: Date.now(),
    chunk: { type: 'text-delta', index, text } } })
}
export function finishText(emit: (event: AgentRuntimeEvent) => void, text: string, id = 'test-attempt', step = 1, replayState?: unknown): void {
  emit({ type: 'session', event: { type: 'assistant/message', seq: SessionSeq(step), time: Date.now(), surfaceOp: 'append', data: {
    turn: 1, step, message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'test', model: 'test', replayState } }), stream: [],
  } } })
  emit({ type: 'assistant-stream', frame: { type: 'end', attemptId: LlmAttemptId(id), revision: 1, index: 1,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: SessionSeq(step) } } })
}

export function callTool(emit: (event: AgentRuntimeEvent) => void, callId = 'call-1', step = 1): void {
  emit({ type: 'session', event: { type: 'tool/call', seq: SessionSeq(step + 10), time: Date.now(), data: {
    turn: 1, step, callId: ToolCallId(callId), name: 'probe', arguments: '{"value":"OK"}',
  } } })
}
export function finishTool(emit: (event: AgentRuntimeEvent) => void, result = 'OK', callId = 'call-1', step = 1, failed = false): void {
  emit({ type: 'session', event: { type: 'tool/result', seq: SessionSeq(step + 20), time: Date.now(), surfaceOp: 'append', data: {
    turn: 1, step, message: createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text: result }], isError: failed }),
  } } })
}
