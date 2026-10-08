import { BlockAssembler, expandAssistantStream } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ChatMessage, Conversation } from '../shared/types.ts'

/** Application display policy: build the same one-reply-per-turn view as the live chat. */
export function conversationHistory(
  conversationId: string,
  createdAt: number,
  events: readonly SessionEvent[],
): Conversation {
  const messages: ChatMessage[] = []
  const replies = new Map<number, ChatMessage>()
  const attempts = new Map<number, string>()

  const replyFor = (turn: number, timestamp: number) => {
    let reply = replies.get(turn)
    if (!reply) {
      reply = { id: `assistant-${turn}`, role: 'assistant', content: '', timestamp }
      replies.set(turn, reply)
      messages.push(reply)
    }
    return reply
  }

  for (const event of events) {
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      messages.push({
        id: event.data.id,
        role: 'user',
        content: event.data.content.filter(block => block.type === 'text').map(block => block.text).join(''),
        timestamp: event.time,
      })
    } else if (event.type === 'assistant/message') {
      const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      if (text) replyFor(event.data.turn, event.time).content = text
      attempts.delete(event.data.turn)
    } else if (event.type === 'assistant/attempt') {
      const assembler = new BlockAssembler()
      for (const frame of expandAssistantStream(event.data.stream)) assembler.push(frame.chunk)
      attempts.set(event.data.turn, assembler.interruptedBlocks()
        .filter(block => block.type === 'text').map(block => block.text).join(''))
    } else if (event.type === 'turn/end') {
      const kind = event.data.reason.kind
      if (kind === 'error' || kind === 'aborted' || kind === 'interrupted' || kind === 'blocked') {
        const reply = replyFor(event.data.turn, event.time)
        const text = attempts.get(event.data.turn) || reply.content
        const notice = kind === 'error' ? '生成失败，请重试' : '生成已中断'
        reply.content = text ? `${text}\n\n${notice}` : notice
        reply.error = true
      }
      attempts.delete(event.data.turn)
    }
  }

  return {
    id: conversationId,
    title: conversationId,
    messages,
    createdAt,
    updatedAt: events.at(-1)?.time ?? createdAt,
  }
}
