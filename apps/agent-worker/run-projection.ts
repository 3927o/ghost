/** The application handler owns the public-event allowlist and presentation projection. */
import { emptyRunView, reduceRunEvent, type AssistantBlock, type RunEventPayload, type RunView, type ToolPart } from '@ghost/contracts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AgentRuntimeEvent } from './runtime/events.ts'

export class RunProjection {
  view: RunView = emptyRunView()
  private readonly runId: string
  private readonly attempts = new Map<string, { turn: number; step: number }>()
  private readonly messages = new Map<string, string>()
  private readonly tools = new Map<string, string>()
  constructor(runId: string) { this.runId = runId }

  apply(event: RunEventPayload): void { this.view = reduceRunEvent(this.view, event) }

  accept(input: AgentRuntimeEvent): RunEventPayload[] {
    const events: RunEventPayload[] = []
    const emit = (event: RunEventPayload) => { events.push(event); this.apply(event) }
    const ensureMessage = (id: string, step: number) => {
      if (!this.view.parts.some(part => part.id === id)) emit({ type: 'assistant.started', messageId: id, step })
    }
    if (input.type === 'assistant-stream') {
      const frame = input.frame
      const id = String(frame.attemptId)
      if (frame.type === 'start') {
        this.attempts.set(id, { turn: frame.turn, step: frame.step })
        this.messages.set(`${frame.turn}:${frame.step}`, id)
        ensureMessage(id, frame.step)
      } else if (frame.type === 'chunk') {
        const attempt = this.attempts.get(id)
        if (!attempt) throw new Error('Assistant chunk arrived before its start')
        const chunk = frame.chunk
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          emit({ type: 'assistant.delta', messageId: id, index: chunk.index,
            kind: chunk.type === 'text-delta' ? 'text' : 'reasoning', text: chunk.text })
        } else if (chunk.type === 'block-end' && (chunk.block.type === 'text' || chunk.block.type === 'reasoning')) {
          emit({ type: 'assistant.block', messageId: id, block: { index: chunk.index, kind: chunk.block.type, text: chunk.block.text } })
        } else if (chunk.type === 'tool-call-delta') {
          const toolId = `${id}:tool:${chunk.index}`
          this.tools.set(`${attempt.turn}:${attempt.step}:${chunk.id}`, toolId)
          emit({ type: 'tool.delta', id: toolId, callId: String(chunk.id), messageId: id,
            step: attempt.step, name: chunk.name, delta: chunk.argumentsDelta })
        }
      } else if (frame.outcome.kind === 'abandoned') {
        emit({ type: 'assistant.finished', messageId: id, status: 'abandoned' })
      }
      return events
    }
    const event = input.event
    switch (event.type) {
      case 'step/start': case 'step/end':
        emit({ type: event.type === 'step/start' ? 'step.started' : 'step.finished', turn: event.data.turn, step: event.data.step })
        break
      case 'assistant/message': case 'assistant/attempt': {
        const { turn, step } = event.data
        const id = this.messages.get(`${turn}:${step}`) ?? `${this.runId}:message:${event.seq}`
        ensureMessage(id, step)
        if (event.type === 'assistant/message') {
          const blocks: AssistantBlock[] = event.data.message.content.flatMap((block, index) =>
            block.type === 'text' || block.type === 'reasoning' ? [{ index, kind: block.type, text: block.text }] : [])
          emit({ type: 'assistant.finished', messageId: id, status: event.data.interrupted ? 'interrupted' : 'completed', blocks })
        } else emit({ type: 'assistant.finished', messageId: id, status: 'abandoned' })
        break
      }
      case 'tool/call': {
        const { turn, step, callId, name, arguments: args } = event.data
        const key = `${turn}:${step}:${callId}`
        const id = this.tools.get(key) ?? `${this.runId}:tool:${key}`
        this.tools.set(key, id)
        const previous = this.view.parts.find(part => part.type === 'tool' && part.id === id) as ToolPart | undefined
        emit({ type: 'tool.called', tool: { type: 'tool', id, callId: String(callId), step,
          messageId: previous?.messageId ?? this.messages.get(`${turn}:${step}`) ?? null,
          name, arguments: args, status: 'running', result: '', error: null } })
        break
      }
      case 'tool/result': {
        const { turn, step, message } = event.data
        const id = this.tools.get(`${turn}:${step}:${message.toolCallId}`)
        if (!id) throw new Error('Tool result arrived without its call')
        emit({ type: 'tool.result', id, result: visibleContent(message.content),
          error: event.data.error?.reason ?? null, failed: !!message.isError })
        break
      }
      // Prompts, request headers, provider replay state and other internal records stay in DSH storage.
    }
    return events
  }
}

function visibleContent(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => block.type === 'text' || block.type === 'reasoning' ? block.text
    : block.type === 'image' ? '[图片]' : block.type === 'file' ? '[文件]' : '').filter(Boolean).join('\n')
}
