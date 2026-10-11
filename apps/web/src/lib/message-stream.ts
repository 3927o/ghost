/** Read complete SSE records across UTF-8 / network chunk boundaries. */
import { isTerminalStreamEvent, type RunStreamEvent } from '@ghost/contracts'

export async function readMessageStream(
  body: ReadableStream<Uint8Array>,
  onMessage: (message: RunStreamEvent) => void,
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
          const message: RunStreamEvent = JSON.parse(dataLines.join('\n'))
          dataLines = []
          onMessage(message)
          if (isTerminalStreamEvent(message)) return
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''))
        }
      }
      if (done) throw new Error('Observation disconnected before completion')
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function waitToReconnect(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}
