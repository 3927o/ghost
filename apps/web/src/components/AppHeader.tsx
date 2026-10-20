import { GhostMark, Icon } from './Icon'
import './AppHeader.css'

interface AppHeaderProps {
  userId: string
}

export function AppHeader({ userId }: AppHeaderProps) {
  return (
    <header className="app-header">
      <h1 className="g-brand app-brand"><GhostMark /><span className="g-wordmark">ghost</span></h1>
      <div className="app-user">
        <Icon name="user" small />
        <span className="g-label g-secondary">{userId}</span>
      </div>
    </header>
  )
}
