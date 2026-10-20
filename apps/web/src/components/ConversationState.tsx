import type { ReactNode } from 'react'

interface ConversationStateProps {
  icon: ReactNode
  title: string
  description: string
  children?: ReactNode
}

export function ConversationState({ icon, title, description, children }: ConversationStateProps) {
  return <div className="empty-state">
    <div className="g-content g-content--centered">
      {icon}
      <h2 className="g-page-title">{title}</h2>
      <p className="g-detail g-secondary">{description}</p>
      {children}
    </div>
  </div>
}
