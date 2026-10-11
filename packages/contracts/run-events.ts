/** Application presentation protocol. No provider or Agent SDK types cross this boundary. */
import type { RunStatus, RunStreamEvent } from './index.ts'

export interface AssistantBlock { index: number; kind: 'text' | 'reasoning'; text: string }
export interface AssistantPart {
  type: 'assistant'
  id: string
  step: number
  status: 'streaming' | 'completed' | 'interrupted' | 'abandoned'
  blocks: AssistantBlock[]
}
export interface ToolPart {
  type: 'tool'
  id: string
  callId: string
  step: number
  messageId: string | null
  name: string
  arguments: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted'
  result: string
  error: string | null
}
export type RunPart = AssistantPart | ToolPart
export interface RunView { status: RunStatus; text: string; error: string | null; parts: RunPart[] }
export type RunEventPayload =
  | { type: 'run.started' }
  | { type: 'step.started' | 'step.finished'; turn: number; step: number }
  | { type: 'assistant.started'; messageId: string; step: number }
  | { type: 'assistant.delta'; messageId: string; index: number; kind: AssistantBlock['kind']; text: string }
  | { type: 'assistant.block'; messageId: string; block: AssistantBlock }
  | { type: 'assistant.finished'; messageId: string; status: AssistantPart['status']; blocks?: AssistantBlock[] }
  | { type: 'tool.delta'; id: string; callId: string; messageId: string; step: number; name?: string; delta: string }
  | { type: 'tool.called'; tool: ToolPart }
  | { type: 'tool.result'; id: string; result: string; error: string | null; failed: boolean }
  | { type: 'run.completed' }
  | { type: 'run.failed'; error: string }
export interface RunEvent {
  type: 'event'
  runId: string
  sequence: number
  time: number
  event: RunEventPayload
}

export function emptyRunView(): RunView { return { status: 'queued', text: '', error: null, parts: [] } }

/** The Worker projection and browser replay use identical, immutable presentation rules. */
export function reduceRunEvent(state: RunView, event: RunEventPayload): RunView {
  let parts = state.parts
  let status = state.status
  let error = state.error
  const updateAssistant = (id: string, update: (part: AssistantPart) => AssistantPart) => {
    parts = parts.map(part => part.type === 'assistant' && part.id === id ? update(part) : part)
  }
  switch (event.type) {
    case 'run.started': status = 'running'; break
    case 'step.started': case 'step.finished': break
    case 'assistant.started':
      if (!parts.some(part => part.id === event.messageId)) parts = [...parts, {
        type: 'assistant', id: event.messageId, step: event.step, status: 'streaming', blocks: [],
      }]
      break
    case 'assistant.delta': case 'assistant.block': {
      const block = event.type === 'assistant.block' ? event.block : { index: event.index, kind: event.kind, text: event.text }
      updateAssistant(event.messageId, part => {
        const previous = part.blocks.find(value => value.index === block.index)
        const value = { ...block, text: event.type === 'assistant.delta' ? (previous?.text ?? '') + block.text : block.text }
        const blocks = previous ? part.blocks.map(item => item.index === block.index ? value : item) : [...part.blocks, value]
        return { ...part, blocks: blocks.sort((a, b) => a.index - b.index) }
      })
      break
    }
    case 'assistant.finished':
      updateAssistant(event.messageId, part => ({ ...part, status: event.status, blocks: event.blocks ?? part.blocks }))
      if (event.status === 'abandoned' || event.status === 'interrupted') parts = parts.map(part =>
        part.type === 'tool' && part.messageId === event.messageId && part.status === 'pending' ? { ...part, status: 'interrupted' } : part)
      break
    case 'tool.delta': {
      const previous = parts.find(part => part.type === 'tool' && part.id === event.id) as ToolPart | undefined
      const tool: ToolPart = { type: 'tool', id: event.id, callId: event.callId, messageId: event.messageId, step: event.step,
        name: event.name ?? previous?.name ?? '', arguments: (previous?.arguments ?? '') + event.delta,
        status: 'pending', result: '', error: null }
      parts = previous ? parts.map(part => part.id === event.id ? tool : part) : [...parts, tool]
      break
    }
    case 'tool.called':
      parts = parts.some(part => part.id === event.tool.id)
        ? parts.map(part => part.id === event.tool.id ? event.tool : part) : [...parts, event.tool]
      break
    case 'tool.result':
      parts = parts.map(part => part.type === 'tool' && part.id === event.id
        ? { ...part, status: event.failed ? 'failed' : 'completed', result: event.result, error: event.error } : part)
      break
    case 'run.completed': case 'run.failed':
      status = event.type === 'run.completed' ? 'completed' : 'failed'
      error = event.type === 'run.failed' ? event.error : null
      parts = parts.map(part => part.type === 'tool' && ['pending', 'running'].includes(part.status)
        ? { ...part, status: 'interrupted' }
        : part.type === 'assistant' && part.status === 'streaming' ? { ...part, status: 'interrupted' } : part)
      break
  }
  const text = !parts.length ? state.text : parts.filter((part): part is AssistantPart => part.type === 'assistant' && part.status !== 'abandoned')
    .map(part => part.blocks.filter(block => block.kind === 'text').map(block => block.text).join('')).filter(Boolean).join('\n\n')
  return { status, text, error, parts }
}

export function isTerminalStreamEvent(event: RunStreamEvent): boolean {
  return event.type === 'snapshot' ? event.run.status === 'completed' || event.run.status === 'failed'
    : event.event.type === 'run.completed' || event.event.type === 'run.failed'
}
