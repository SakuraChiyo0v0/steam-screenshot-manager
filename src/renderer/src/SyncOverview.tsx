import { ArrowRightIcon, CloudArrowUpIcon, FolderIcon, GameControllerIcon } from '@phosphor-icons/react'
import type { SyncSummaryDto } from '@shared/types'
import { formatBytes } from './view-model'

/**
 * 同步链路图：一眼看清"哪边到哪边"。
 *
 * 三份数据各有各的数字，以前散在三个页面里，谁也说不清某个数属于哪一边。
 * 这里把它们按数据流向排成一条线，箭头下面写明这一步在做什么。
 */
export function SyncOverview({ summary }: { summary: SyncSummaryDto | null }) {
  const local = summary?.localCount ?? 0
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
          <span>扫描 → 归档</span>
          <ArrowRightIcon size={18} />
        </div>
        <div className="flow-node">
          <FolderIcon size={22} />
          <strong>本机图库</strong>
          <span className="flow-count">{local} 张</span>
          <small className="muted">
            {summary?.localBytes ? formatBytes(summary.localBytes) : '独立副本'}
          </small>
        </div>
        <div className="flow-link">
          <span>{pending > 0 ? `待备份 ${pending} 张 →` : '备份 →'}</span>
          <ArrowRightIcon size={18} />
        </div>
        <div className="flow-node">
          <CloudArrowUpIcon size={22} />
          <strong>远端备份</strong>
          <span className="flow-count">{verified} 张</span>
          <small className="muted">
            {summary?.remoteKind === 'folder' ? '文件夹' : summary?.remoteKind === 'webdav' ? 'WebDAV' : '未连接'}
          </small>
        </div>
      </div>
      <p className="flow-note muted">
        备份把图库里的原图复制到远端；恢复是反方向：远端 → 本机图库 → Steam。本机删除不会传播到远端。
        {summary?.lastBackupAt
          ? ` 最近一次成功备份：${new Date(summary.lastBackupAt).toLocaleString()}`
          : ' 还没有成功备份过。'}
      </p>
    </section>
  )
}
