import './Sidebar.css'

interface SidebarProps {
  userId: string
  channel: string
}

export function Sidebar({ userId, channel }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header"><h1>Ghost</h1></div>
      <div className="channels-list">
        <div className="channel-item active" aria-current="page">
          <div className="channel-title">{channel}</div>
          <div className="channel-description">对话历史自动保存</div>
        </div>
      </div>
      <div className="sidebar-user"><span aria-hidden="true">👤</span> {userId}</div>
    </aside>
  )
}
