import { ArrowRightIcon, CloudArrowUpIcon, GameControllerIcon } from '@phosphor-icons/react'
import type { SyncSummaryDto } from '@shared/types'

/**
 * 同步链路图：一眼看清"哪边到哪边"。
 *
 * 三份数据各有各的数字，以前散在三个页面里，谁也说不清某个数属于哪一边。
 * 这里把它们按数据流向排成一条线，箭头下面写明这一步在做什么。
 */
export function SyncOverview({ summary }: { summary: SyncSummaryDto | null }) {
  const verified = summary?.verified ?? 0
  const pending = summary?.pending ?? 0
  const indexed = summary?.indexedCount ?? 0

  return (
    <section className="sync-overview" aria-label="同步链路">
      <div className="flow">
        <div className="flow-node">
          <GameControllerIcon size={22} />
          <strong>Steam 来源</strong>
          <span className="flow-count">{indexed} 张</span>
          <small className="muted">只读，不会改动</small>
        </div>
        <div className="flow-link">
          <span>{pending > 0 ? `待备份 ${pending} 张 →` : '备份 →'}</span>
          <ArrowRightIcon size={18} />
        </div>
        <div className="flow-node">
          <CloudArrowUpIcon size={22} />
          <strong>备份地址</strong>
          <span className="flow-count">{verified} 张</span>
          <small className="muted">
            {summary?.targetCount ? `${summary.targetCount} 个地址` : '未配置'}
          </small>
        </div>
      </div>
      <p className="flow-note muted">
        备份把 Steam 里的原图直接写到备份地址；恢复是反方向：备份地址 → Steam。本机删除不会传播到备份。
        {summary?.lastBackupAt
          ? ` 最近一次成功备份：${new Date(summary.lastBackupAt).toLocaleString()}`
          : ' 还没有成功备份过。'}
      </p>
    </section>
  )
}
