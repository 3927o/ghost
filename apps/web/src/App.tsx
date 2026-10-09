/** Submit business commands, then observe durable runs independently of the browser request. */
import { useState, useRef, useEffect } from 'react'
import { isTerminalRun, type MessageResponse, type RunSnapshot } from '@ghost/contracts'
import { Chat } from './components/Chat'
import { Sidebar } from './components/Sidebar'
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
    const revisions = new Map<string, number>()
    const update = (run: RunSnapshot) => {
      if (signal.aborted || run.revision <= (revisions.get(run.id) ?? -1)) return
      revisions.set(run.id, run.revision)
      setNotice('')
      setConversation(previous => previous && ({
        ...previous,
        updatedAt: Math.max(previous.updatedAt, run.updatedAt),
        activeRunIds: isTerminalRun(run.status) ? previous.activeRunIds.filter(id => id !== run.id) : previous.activeRunIds,
        messages: previous.messages.map(message => message.id === run.assistantMessageId ? {
          ...message, content: [run.text, run.error].filter(Boolean).join('\n\n'),
          streaming: !isTerminalRun(run.status), error: run.status === 'failed',
        } : message),
      }))
    }
    const observe = async (id: string) => {
      let backoff = 500
      while (!signal.aborted) {
        try {
          const response = await fetch(`/api/runs/${id}/events?${query}`, { signal, cache: 'no-store' })
          if (!response.ok || !response.body) throw new Error('Run observation unavailable')
          await readMessageStream(response.body, event => update(event.run))
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

  const handleSendMessage = async (content: string) => {
    if (!conversation || loading || loadError || pending.current) return
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
    } catch {
      setNotice('消息提交未确认，请重试。')
    } finally {
      pending.current = false
      setSending(false)
    }
  }

  return (
    <div className="app">
      <Sidebar userId={clientContext.userId} channel={clientContext.channel} />
      <div className="chat-panel">
        {notice && <div className="connection-notice" role="status">
          {notice}
          {retrySubmission.current && <button onClick={() => handleSendMessage(retrySubmission.current!.content)} disabled={sending}>重试提交</button>}
        </div>}
        {loading ? (
          <div className="chat empty"><div className="empty-state"><p>正在加载对话…</p></div></div>
        ) : loadError ? (
          <div className="chat empty"><div className="empty-state">
            <p>对话加载失败，请检查后端服务。</p>
            <button className="retry-button" onClick={() => setReload(value => value + 1)}>重新加载</button>
          </div></div>
        ) : (
          <Chat conversation={conversation} onSendMessage={handleSendMessage} disabled={sending} />
        )}
      </div>
    </div>
  )
}
export default App
