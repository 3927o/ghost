import type { MessageStreamEvent } from '../../../src/shared/types.ts'

/** Read complete SSE records even when UTF-8 text and records span network chunks. */
export async function readMessageStream(
  body: ReadableStream<Uint8Array>,
  onMessage: (message: MessageStreamEvent) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })

      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)

        if (line === '' && dataLines.length > 0) {
          const message: MessageStreamEvent = JSON.parse(dataLines.join('\n'))
          dataLines = []
          onMessage(message)
          if (message.type === 'done' || message.type === 'error') return
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''))
        }
      }

      if (done) throw new Error('Response stream ended before completion')
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
