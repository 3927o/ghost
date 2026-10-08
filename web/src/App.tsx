import { useState, useRef, useEffect } from 'react'
import { Chat } from './components/Chat'
import { Sidebar } from './components/Sidebar'
import { clientContext } from './client-context'
import { readMessageStream } from './lib/message-stream'
import type { Conversation, Message } from './types'
import './App.css'

async function loadConversation(signal?: AbortSignal): Promise<Conversation> {
  const query = new URLSearchParams({ ...clientContext })
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
  const pending = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError(false)
    loadConversation(controller.signal).then(value => {
      if (!controller.signal.aborted) setConversation(value)
    }).catch(error => {
      if (!controller.signal.aborted) {
        console.error('Failed to load conversation:', error)
        setLoadError(true)
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [reload])

  const handleSendMessage = async (content: string) => {
    if (!conversation || loading || loadError || pending.current) return
    pending.current = true
    setSending(true)

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const assistantId = `assistant-${requestId}`
    const userMessage: Message = { id: `user-${requestId}`, role: 'user', content, timestamp: Date.now() }
    const assistantMessage: Message = { id: assistantId, role: 'assistant', content: '', timestamp: Date.now(), streaming: true }
    setConversation(previous => previous && ({
      ...previous,
      messages: [...previous.messages, userMessage, assistantMessage],
      updatedAt: Date.now(),
    }))

    const updateAssistant = (patch: Partial<Message>) => {
      setConversation(previous => previous && ({
        ...previous,
        messages: previous.messages.map(message => message.id === assistantId ? { ...message, ...patch } : message),
        updatedAt: Date.now(),
      }))
    }

    let assistantText = ''
    const markFailed = (message: string) => updateAssistant({
      content: assistantText ? `${assistantText}\n\n${message}` : message,
      streaming: false,
      error: true,
    })

    try {
      const response = await fetch('/api/message/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...clientContext, content }),
      })
      if (!response.ok) throw new Error('Failed to send message')
      if (!response.body) throw new Error('No response body')

      await readMessageStream(response.body, data => {
        if (data.type === 'text') {
          assistantText = data.text
          updateAssistant({ content: assistantText })
        } else if (data.type === 'event' && data.event.type === 'assistant/message') {
          const text = data.event.data.message.content
            .filter(block => block.type === 'text')
            .map(block => block.text).join('')
          if (text) {
            assistantText = text
            updateAssistant({ content: assistantText })
          }
        } else if (data.type === 'done') {
          updateAssistant({ streaming: false })
        } else if (data.type === 'error') {
          markFailed('生成失败，请重试')
        }
      })

      // Reconcile message ids and any messages sent through another client.
      try {
        setConversation(await loadConversation())
      } catch (error) {
        console.error('Failed to refresh saved history:', error)
      }
    } catch (error) {
      console.error('Failed to send message:', error)
      markFailed('连接中断，请重试')
    } finally {
      pending.current = false
      setSending(false)
    }
  }

  return (
    <div className="app">
      <Sidebar userId={clientContext.userId} channel={clientContext.channel} />
      {loading ? (
        <div className="chat empty"><div className="empty-state"><p>正在加载对话…</p></div></div>
      ) : loadError ? (
        <div className="chat empty">
          <div className="empty-state">
            <p>对话加载失败，请检查后端服务。</p>
            <button className="retry-button" onClick={() => setReload(value => value + 1)}>重新加载</button>
          </div>
        </div>
      ) : (
        <Chat conversation={conversation} onSendMessage={handleSendMessage} disabled={sending} />
      )}
    </div>
  )
}

export default App
