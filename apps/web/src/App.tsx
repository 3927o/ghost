/** Submit business commands, then observe durable runs independently of the browser request. */
import { useState, useRef, useEffect } from 'react'
import { isTerminalRun, reduceRunEvent, type MessageResponse, type RunStreamEvent, type RunView } from '@ghost/contracts'
import { Chat, type SendResult } from './components/Chat'
import { AppHeader } from './components/AppHeader'
import { ConversationState } from './components/ConversationState'
import { Icon } from './components/Icon'
import { clientContext } from './client-context'
import { readMessageStream, waitToReconnect } from './lib/message-stream'
import type { Conversation } from './types'
import './App.css'

const query = new URLSearchParams({ ...clientContext })
async function loadConversation(signal?: AbortSignal): Promise<Conversation> {
  const response = await fetch(`/api/conversation?${query}`, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error('Failed to load conversation')
  return response.json()
}

function App() {
  const [conversation, setConversation] = useState<Conversation>()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [reload, setReload] = useState(0)
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState('')
  const pending = useRef(false)
  // A failed/ambiguous HTTP response can be retried with the same submission identity.
  const retrySubmission = useRef<{ content: string; requestId: string } | undefined>(undefined)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError(false)
    loadConversation(controller.signal).then(value => {
      if (!controller.signal.aborted) setConversation(value)
    }).catch(() => {
      if (!controller.signal.aborted) setLoadError(true)
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [reload])

  const activeRuns = conversation?.activeRunIds.join(',') ?? ''
  useEffect(() => {
    if (!activeRuns) return
    const controller = new AbortController()
    const { signal } = controller
    const cursors = new Map<string, number>()
    const views = new Map<string, RunView>()
    const update = (id: string, event: RunStreamEvent) => {
      if (signal.aborted) return
      const sequence = event.type === 'snapshot' ? event.run.lastEventSeq : event.sequence
      if (event.type === 'event' && event.runId !== id) throw new Error('Unexpected run event')
      if (sequence <= (cursors.get(id) ?? -1)) return
      if (event.type === 'event' && sequence !== (cursors.get(id) ?? 0) + 1) throw new Error('Run event sequence gap')
      const view = event.type === 'snapshot' ? event.run : reduceRunEvent(views.get(id)!, event.event)
      views.set(id, view)
      cursors.set(id, sequence)
      const updatedAt = event.type === 'snapshot' ? event.run.updatedAt : event.time
      setNotice('')
      setConversation(previous => previous && ({
        ...previous,
        updatedAt: Math.max(previous.updatedAt, updatedAt),
        activeRunIds: isTerminalRun(view.status) ? previous.activeRunIds.filter(runId => runId !== id) : previous.activeRunIds,
        messages: previous.messages.map(message => message.id === `assistant-${id}` ? {
          ...message, content: [view.text, view.error].filter(Boolean).join('\n\n'), parts: view.parts,
          failure: view.error ?? undefined,
          streaming: !isTerminalRun(view.status), error: view.status === 'failed',
        } : message),
      }))
    }
    const observe = async (id: string) => {
      let backoff = 500
      while (!signal.aborted) {
        try {
          const after = cursors.get(id)
          const response = await fetch(`/api/runs/${id}/events?${query}${after === undefined ? '' : `&after=${after}`}`, { signal, cache: 'no-store' })
          if (!response.ok || !response.body) throw new Error('Run observation unavailable')
          await readMessageStream(response.body, event => { update(id, event); backoff = 500 })
          return
        } catch {
          if (signal.aborted) return
          setNotice('连接中断，正在重新连接…')
          await waitToReconnect(backoff, signal)
          backoff = Math.min(backoff * 2, 5000)
        }
      }
    }
    for (const id of activeRuns.split(',')) {
      observe(id).catch(() => { /* Effect cleanup aborts pending reconnects. */ })
    }
    return () => controller.abort()
  }, [activeRuns])

  const handleSendMessage = async (content: string): Promise<SendResult> => {
    if (!conversation || loading || loadError || pending.current) return 'ignored'
    pending.current = true
    setSending(true)
    setNotice('')
    const submission = retrySubmission.current?.content === content
      ? retrySubmission.current : { content, requestId: crypto.randomUUID() }
    retrySubmission.current = submission
    try {
      const response = await fetch('/api/message', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...clientContext, ...submission }),
      })
      if (!response.ok) throw new Error('Failed to submit message')
      const result: MessageResponse = await response.json()
      retrySubmission.current = undefined
      const now = Date.now()
      // Use durable IDs immediately; history refresh can recover even if this tab closes here.
      setConversation(previous => previous && (previous.messages.some(message => message.runId === result.runId) ? previous : {
        ...previous, updatedAt: now, activeRunIds: [...previous.activeRunIds, result.runId],
        messages: [...previous.messages,
          { id: `user-${result.runId}`, runId: result.runId, role: 'user', content, timestamp: now },
          { id: `assistant-${result.runId}`, runId: result.runId, role: 'assistant', content: '', timestamp: now, streaming: true },
        ],
      }))
      return 'sent'
    } catch {
      // Shown by the composer in its 0.4 failed state (double underline + 错误 hint + 重试); same requestId on retry.
      return 'failed'
    } finally {
      pending.current = false
      setSending(false)
    }
  }

  return (
    <div className="app ghost-ui">
      <a className="g-skip-link" href="#conversation">跳到对话</a>
      <AppHeader userId={clientContext.userId} />
      <main className="chat-panel" id="conversation" tabIndex={-1} aria-label="对话">
        {notice && <div className="connection-notice">
          <div className="g-status" role="status">
            <Icon name="info" small />
            <p className="g-detail">{notice}</p>
          </div>
        </div>}
        {loading ? (
          <div className="chat" role="status" aria-busy="true"><ConversationState
            icon={<span className="g-spinner" aria-hidden="true" />}
            title="正在加载对话"
            description="稍等片刻，正在读取对话记录。"
          /></div>
        ) : loadError ? (
          <div className="chat" role="alert"><ConversationState
            icon={<Icon name="alert" />}
            title="暂时无法加载对话"
            description="请检查后端服务后重试。"
          >
            <button className="g-btn g-btn--primary" type="button" onClick={() => setReload(value => value + 1)}>重新加载</button>
          </ConversationState></div>
        ) : (
          <Chat conversation={conversation} onSendMessage={handleSendMessage} disabled={sending} />
        )}
      </main>
    </div>
  )
}
export default App
