import type { RunPart } from '@ghost/contracts'
import { Icon } from './Icon'

const toolLabels = { pending: '准备调用', running: '执行中', completed: '已完成', failed: '失败', interrupted: '已中断' }

export function RunTimeline({ parts }: { parts: RunPart[] }) {
  return <div className="g-prose">{parts.map(part => part.type === 'assistant'
    ? <div key={part.id} className="g-assistant-part" data-status={part.status}>
      {/* 0.4: stopped / interrupted replies lead with a visible status line, not just lighter grey. */}
      {(part.status === 'abandoned' || part.status === 'interrupted') && <p className="g-assistant-status">
        <Icon name="stop" small />{part.status === 'abandoned' ? '已停止生成' : '已中断'}
      </p>}
      {part.blocks.map(block => block.kind === 'reasoning'
        ? <details key={block.index} className="g-disclosure">
          <summary><Icon name="chevron" small /><span>思考过程</span></summary>
          <div className="g-disclosure-body"><p className="g-detail g-secondary g-message-copy">{block.text}</p></div>
        </details>
        : <div key={block.index} className="g-text g-message-copy">{block.text}{part.status === 'streaming' && <span className="g-cursor" aria-hidden="true">▎</span>}</div>)}
    </div>
    : <details key={part.id} className="g-disclosure g-tool" data-status={part.status}>
      <summary>
        <Icon name="chevron" small />
        <Icon name="tool" small />
        <span className="g-tool-name">{part.name || '工具调用'}</span>
        <span className="g-tag">
          {part.status === 'pending' || part.status === 'running'
            ? <span className="g-spinner" aria-hidden="true" />
            : <Icon name={part.status === 'completed' ? 'check' : part.status === 'failed' ? 'alert' : 'stop'} small />}
          {toolLabels[part.status]}
        </span>
      </summary>
      <div className="g-disclosure-body">
        <div className="g-prose"><p className="g-label g-muted">参数</p><pre className="g-code">{formatArguments(part.arguments)}</pre></div>
        {part.result && <div className="g-prose"><p className="g-label g-muted">结果</p><pre className="g-code">{part.result}</pre></div>}
        {part.error && <p className="g-hint g-hint--error g-feedback"><Icon name="alert" small /><span className="g-message-copy"><strong>错误：</strong>{part.error}</span></p>}
      </div>
    </details>)}</div>
}

function formatArguments(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value || '正在接收参数…' }
}
