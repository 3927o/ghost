import { useState, useRef, useEffect } from 'react'
import type { Conversation } from '../types'
import './Chat.css'
import { RunTimeline } from './RunTimeline'
import { ConversationState } from './ConversationState'
import { GhostMark, Icon } from './Icon'

export type SendResult = 'sent' | 'failed' | 'ignored'

interface ChatProps {
  conversation?: Conversation
  onSendMessage: (content: string) => Promise<SendResult>
  disabled?: boolean
}

export function Chat({ conversation, onSendMessage, disabled = false }: ChatProps) {
  const [input, setInput] = useState('')
  // 0.4 composer failed state: double underline + aria-invalid + .g-hint--error with 重试; the text stays in the field.
  const [sendFailed, setSendFailed] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const isStreaming = conversation?.messages.some(message => message.streaming) ?? false

  useEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    messagesEndRef.current?.scrollIntoView({ behavior: reduceMotion ? 'instant' : 'smooth', block: 'end' })
  }, [conversation?.messages])

  useEffect(() => {
    const textarea = inputRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [input])

  const send = async () => {
    const content = input.trim()
    if (!content || isStreaming || disabled) return
    setSendFailed(false)
    const result = await onSendMessage(content)
    if (result === 'failed') setSendFailed(true)
    // Clear only if the user has not started editing in the meantime.
    else if (result === 'sent') setInput(current => current.trim() === content ? '' : current)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    void send()
  }

  const handleRetry = () => {
    void send()
    inputRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  if (!conversation) {
    return (
      <div className="chat">
        <ConversationState icon={<GhostMark />} title="欢迎使用 Ghost" description="你的对话会保存在这里。" />
      </div>
    )
  }

  return (
    <div className="chat">
      <section className="messages" aria-label="对话消息">
        {conversation.messages.length === 0 ? (
          <ConversationState
            icon={<GhostMark />}
            title="说说看，我在。"
            description="把想法、问题，或需要帮忙的事告诉我。"
          />
        ) : <div className="g-thread messages-thread">{conversation.messages.map(msg => (
          <article key={msg.id} className={`g-message${msg.role === 'user' ? ' g-message--user' : ''}`} aria-label={msg.role === 'user' ? '你的消息' : 'Ghost 的回复'}>
            <div className="g-byline">
              {msg.role === 'assistant' && <GhostMark />}
              <span>{msg.role === 'user' ? '你' : 'Ghost'}</span>
              <time dateTime={new Date(msg.timestamp).toISOString()}>
                {new Date(msg.timestamp).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            </div>
            <div className="g-content message-content">
              {msg.role === 'assistant' && !!msg.parts?.length ? <>
                <RunTimeline parts={msg.parts} />
                {msg.failure && <div className="g-status" data-tone="error"><Icon name="alert" small /><p className="g-detail g-message-copy"><strong>错误：</strong>{msg.failure}</p></div>}
              </> : msg.content && (msg.error
                ? <div className="g-status" data-tone="error"><Icon name="alert" small /><p className="g-detail g-message-copy"><strong>错误：</strong>{msg.content}</p></div>
                : <div className={`g-message-copy ${msg.role === 'user' ? 'g-detail g-secondary' : 'g-text'}`}>
                  {msg.content}
                  {msg.streaming && <span className="g-cursor" aria-hidden="true">▎</span>}
                </div>)}
              {msg.streaming && <span className="g-tag" role="status"><span className="g-spinner" aria-hidden="true" />正在回复…</span>}
            </div>
          </article>
        ))}</div>}
        <div ref={messagesEndRef} />
      </section>
      <div className="composer-area">
        <form className="g-composer g-composer--text" onSubmit={handleSubmit} aria-label="发送消息" data-state={disabled ? 'sending' : sendFailed ? 'failed' : undefined}>
          <label className="g-sr-only" htmlFor="message-input">消息内容</label>
          <textarea
            id="message-input"
            className="g-composer-input"
            ref={inputRef}
            value={input}
            onChange={e => { setInput(e.target.value); if (sendFailed) setSendFailed(false) }}
            onKeyDown={handleKeyDown}
            placeholder="说说看，我在。"
            rows={1}
            aria-invalid={sendFailed || undefined}
            aria-describedby={sendFailed ? 'composer-error' : undefined}
          />
          <button className="g-icon-button" type="submit" disabled={!input.trim() || isStreaming || disabled} aria-label={disabled ? '正在发送' : '发送消息'} aria-busy={disabled || undefined} title="发送消息">
            {disabled ? <span className="g-spinner" aria-hidden="true" /> : <Icon name="arrow" small />}
          </button>
        </form>
        {sendFailed && <div className="g-composer-feedback">
          <p id="composer-error" className="g-hint g-hint--error g-feedback" role="alert"><Icon name="alert" small /><span><strong>错误：</strong>消息提交未确认，内容已保留。</span></p>
          <button className="g-btn g-btn--primary" type="button" onClick={handleRetry} disabled={disabled}>重试</button>
        </div>}
      </div>
    </div>
  )
}
