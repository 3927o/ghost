import { useState, useRef, useEffect } from 'react'
import type { Conversation } from '../types'
import './Chat.css'
import { RunTimeline } from './RunTimeline'

interface ChatProps {
  conversation?: Conversation
  onSendMessage: (content: string) => void
  disabled?: boolean
}

export function Chat({ conversation, onSendMessage, disabled = false }: ChatProps) {
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const isStreaming = conversation?.messages.some(message => message.streaming) ?? false

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [conversation?.messages])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || isStreaming || disabled) return

    onSendMessage(input.trim())
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  if (!conversation) {
    return (
      <div className="chat empty">
        <div className="empty-state">
          <h2>👋 欢迎使用 Ghost</h2>
          <p>开始一个新对话吧</p>
        </div>
      </div>
    )
  }

  return (
    <div className="chat">
      <div className="messages">
        {conversation.messages.length === 0 && (
          <div className="empty-state"><h2>开始对话</h2><p>你的对话会保存在这里，下次回来可以继续。</p></div>
        )}
        {conversation.messages.map(msg => (
          <div key={msg.id} className={`message ${msg.role}`}>
            <div className="message-avatar">
              {msg.role === 'user' ? '👤' : '🤖'}
            </div>
            <div className="message-content">
              {msg.role === 'assistant' && !!msg.parts?.length ? <>
                <RunTimeline parts={msg.parts} />
                {msg.failure && <div className="message-text error">{msg.failure}</div>}
              </> : <div className={`message-text ${msg.error ? 'error' : ''}`}>
                {msg.content || (msg.streaming ? '思考中...' : '')}
                {msg.streaming && msg.content && <span className="cursor">▊</span>}
              </div>}
              <div className="message-time">
                {new Date(msg.timestamp).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <form className="input-area" onSubmit={handleSubmit}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息... (Enter 发送，Shift+Enter 换行)"
          rows={1}
        />
        <button type="submit" disabled={!input.trim() || isStreaming || disabled}>
          发送
        </button>
      </form>
    </div>
  )
}
