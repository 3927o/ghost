import type { RunPart } from '@ghost/contracts'

const toolLabels = { pending: '准备调用', running: '执行中', completed: '已完成', failed: '失败', interrupted: '已中断' }

export function RunTimeline({ parts }: { parts: RunPart[] }) {
  return <div className="run-timeline">{parts.map(part => part.type === 'assistant'
    ? <div key={part.id} className={`assistant-part ${part.status}`}>
      {part.blocks.map(block => block.kind === 'reasoning'
        ? <details key={block.index} className="reasoning-block"><summary>思考过程</summary><div>{block.text}</div></details>
        : <div key={block.index} className="message-text">{block.text}{part.status === 'streaming' && <span className="cursor">▊</span>}</div>)}
      {part.status === 'abandoned' && <span className="part-notice">此次生成未采用</span>}
    </div>
    : <details key={part.id} className={`tool-card ${part.status}`}>
      <summary><span className="tool-name">{part.name || '工具调用'}</span><span className="tool-status">{toolLabels[part.status]}</span></summary>
      <div className="tool-detail"><span className="detail-label">参数</span><pre>{formatArguments(part.arguments)}</pre></div>
      {part.result && <div className="tool-detail"><span className="detail-label">结果</span><pre>{part.result}</pre></div>}
      {part.error && <div className="tool-error">{part.error}</div>}
    </details>)}</div>
}

function formatArguments(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value || '正在接收参数…' }
}
