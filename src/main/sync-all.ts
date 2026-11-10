
/**
 * 一键同步：扫描 → 备份，取并集。
 *
 * 用户的模型只有两件事：Steam 里有新截图，就把它推到所有备份地址。
 * 不做删除同步（本机删了不影响备份），也不需要用户理解"归档/图库/账本"。
 *
 * 流程（幂等，随时可重复点）：
 *   1. 对每个已登记来源做一次增量扫描（只读来源，指纹去重）；
 *   2. 对每个备份地址补齐还没备份成功的截图。
 * 中途任何一步失败都不影响其它步骤；返回值只做汇总，界面用任务条看进度。
 */
import { AppError } from '@shared/errors'
import { listSources } from '@core/library/index-writer'
import { getAppContext } from './app-context'
import { startScan, getScanStatus } from './scan-job'
import { runUpload, getUploadStatus, remoteTargets } from './sync-job'
import { readSettings } from '@core/settings/settings-store'

export interface SyncAllResult {
  readonly sources: number
  readonly failedSources: number
  /** 这一轮被备份/校验通过的张数 */
  readonly backedUp: number
  readonly failed: number
  readonly targets: number
  readonly scannedAssets: number
  readonly errors: readonly string[]
}

export async function syncAll(): Promise<SyncAllResult> {
  if (getScanStatus().running || getUploadStatus().running) {
    throw new AppError('JOB_RUNNING', '同步已经在跑了，等它结束再点')
  }

  const { database } = getAppContext()
  const sources = listSources(database.db)
  if (sources.length === 0) {
    throw new AppError('IPC_INVALID_INPUT', '还没有登记 Steam 来源')
  }
  const targets = remoteTargets().filter((target) => target.connected)
  if (targets.length === 0) {
    throw new AppError('IPC_INVALID_INPUT', '还没有可用的备份地址')
  }

  const errors: string[] = []
  let failedSources = 0
  let scannedAssets = 0

  // 1) 先把 Steam 来源扫一遍（增量；不会动任何文件）
  for (const source of sources) {
    try {
      const summary = await startScan({ sourceId: source.sourceId, accountIds: [] })
      scannedAssets += summary.createdAssets ?? 0
    } catch (error) {
      failedSources += 1
      errors.push(`${source.rootPath}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 2) 再补齐所有备份地址
  let backedUp = 0
  let failed = 0
  try {
    const summary = await runUpload({})
    backedUp = summary.verified
    failed = summary.failed
    for (const url of summary.unavailableTargets ?? []) {
      errors.push(`${url}：取不到，已跳过`)
    }
  } catch (error) {
    failed += 1
    errors.push(error instanceof Error ? error.message : String(error))
  }

  // 备份完顺手保证有一份本地缓存目录（下次读图更快），但不强求
  readSettings(database.db)

  return {
    sources: sources.length,
    failedSources,
    backedUp,
    failed,
    targets: targets.length,
    scannedAssets,
    errors
  }
}
