/**
 * 一键同步（双向）。
 *
 * 用户的心智模型只有一句：**让 Steam 和备份地址互为并集**。
 *
 *   1. 推：扫描 Steam 来源 → 把本机有、备份没有的截图推到**每个**备份地址；
 *   2. 收：从备份地址读清单 → 把备份有、本机没有的截图取回本机；
 *   3. 写回：本机已有、但 Steam 里缺的图（换机/重装后常见）写回 Steam。
 *
 * 三条都不做删除：不会因为哪边少了就删另一边。
 * 第 3 步会改 Steam 的索引，因此**Steam 在运行时会跳过**并如实报告，不会偷偷动它。
 */
import { AppError } from '@shared/errors'
import { listSources } from '@core/library/index-writer'
import { getAppContext } from './app-context'
import { startScan, getScanStatus } from './scan-job'
import { runUpload, getUploadStatus, remoteTargets } from './sync-job'
import { scanRemoteCatalog, runRestore, getRestoreStatus } from './restore-job'
import {
  getSteamScreenshotTargets,
  previewSteamScreenshotRestore,
  runSteamScreenshotRestore
} from './steam-screenshot-job'

export interface SyncStepResult {
  readonly step: 'push' | 'pull' | 'writeback'
  readonly ok: boolean
  readonly count: number
  readonly detail: string
}

export interface SyncAllResult {
  readonly sources: number
  readonly targets: number
  /** 推到备份的张数（所有地址合计） */
  readonly backedUp: number
  readonly failed: number
  /** 从备份取回本机的张数 */
  readonly pulled: number
  /** 写回 Steam 的张数；-1 表示跳过 */
  readonly writtenBack: number
  readonly steps: readonly SyncStepResult[]
}

function steamRunning(): boolean {
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    const output = execFileSync('tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000
    })
    return output.split(/\r?\n/).some((line) => line.split(',')[0]?.trim().toLowerCase() === '"steam.exe"')
  } catch {
    // 检测不了就当作在运行：宁可不写，也不猜
    return true
  }
}

let background: { running: boolean; last: SyncAllResult | null; error: string | null } = {
  running: false,
  last: null,
  error: null
}

/**
 * 后台跑一次同步，立刻返回。
 *
 * 之前这个 IPC 会一直等到"扫描 + 上传 + 取回"全部做完才返回，动辄十几分钟，
 * 渲染层一直在等同一个 invoke，界面看起来就是卡死。现在只负责启动，
 * 进度交给任务条，界面靠轮询任务状态自然更新。
 */
export function startSyncAll(): { started: boolean; error?: string } {
  if (background.running) {
    return { started: false, error: '同步已经在跑了' }
  }
  background = { ...background, running: true, error: null }
  void (async () => {
    try {
      background = { running: true, last: background.last, error: null }
      const result = await runSyncAll()
      background = { running: false, last: result, error: null }
    } catch (error) {
      background = {
        running: false,
        last: background.last,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })()
  return { started: true }
}

export function getSyncAllState(): { running: boolean; last: SyncAllResult | null; error: string | null } {
  return background
}

async function runSyncAll(): Promise<SyncAllResult> {
  if (getScanStatus().running || getUploadStatus().running || getRestoreStatus().running) {
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

  const steps: SyncStepResult[] = []

  // ---- 1) 推：扫描 → 上传 ----
  let failedSources = 0
  for (const source of sources) {
    try {
      await startScan({ sourceId: source.sourceId, accountIds: [] })
    } catch {
      failedSources += 1
    }
  }
  let backedUp = 0
  let failed = 0
  try {
    const summary = await runUpload({})
    backedUp = summary.verified
    failed = summary.failed + (summary.unavailableTargets?.length ?? 0)
    steps.push({
      step: 'push',
      ok: failed === 0,
      count: backedUp,
      detail:
        failed === 0
          ? `已推到 ${targets.length} 个备份地址`
          : `有 ${failed} 项没推成功：${(summary.unavailableTargets ?? []).join('、') || '看任务条'}`
    })
  } catch (error) {
    steps.push({ step: 'push', ok: false, count: 0, detail: error instanceof Error ? error.message : String(error) })
  }

  // ---- 2) 收：备份有、本机没有的取回来 ----
  let pulled = 0
  try {
    const catalog = await scanRemoteCatalog()
    // 只取「备份里有、本机没有」的那部分：本机已经有的游戏不进入恢复计划，
    // 否则会为了核对哈希把几千张图重新下载一遍（点一次同步要跑十几分钟，纯浪费）。
    const missing = catalog.games.filter((game) => game.assets > game.alreadyLocal)
    const gameKeys = missing.map((game) => game.gameKey)
    const missingCount = missing.reduce((sum, game) => sum + (game.assets - game.alreadyLocal), 0)
    if (catalog.games.length === 0) {
      steps.push({ step: 'pull', ok: true, count: 0, detail: '备份里还没有可取的截图' })
    } else if (gameKeys.length === 0) {
      steps.push({
        step: 'pull',
        ok: true,
        count: 0,
        detail: `备份里的 ${catalog.games.length} 款游戏本机都已有，无需取回`
      })
    } else {
      const result = await runRestore({ gameKeys })
      pulled = result.restored
      steps.push({
        step: 'pull',
        ok: result.failed === 0,
        count: result.restored,
        detail:
          result.restored === 0
            ? '备份里没有本机缺的截图'
            : `取回 ${result.restored} 张（本机缺 ${missingCount} 张，跳过 ${result.skipped}）`
      })
    }
  } catch (error) {
    steps.push({ step: 'pull', ok: false, count: 0, detail: error instanceof Error ? error.message : String(error) })
  }

  // ---- 3) 写回：本机有、Steam 里缺的 ----
  let writtenBack = -1
  try {
    const candidates = getSteamScreenshotTargets()
    if (candidates.length === 0) {
      steps.push({ step: 'writeback', ok: true, count: 0, detail: '没找到本机 Steam，跳过写回' })
    } else if (steamRunning()) {
      steps.push({ step: 'writeback', ok: true, count: 0, detail: 'Steam 正在运行，为安全起见跳过写回；退出 Steam 后再点一次即可' })
    } else {
      const target = candidates[0]!
      const accountId = target.accounts[0]?.accountId
      if (!accountId) {
        steps.push({ step: 'writeback', ok: true, count: 0, detail: '这个 Steam 没有可用账号，跳过写回' })
      } else {
        const catalog = await scanRemoteCatalog()
        // 写回只看「备份里有的游戏」太窄；用本机全部游戏，preview 会自己算 Steam 里缺哪些
        const gameKeys = catalog.games.map((game) => game.gameKey)
        const preview = await previewSteamScreenshotRestore({ targetId: target.id, accountId, gameKeys })
        if (preview.added === 0) {
          steps.push({ step: 'writeback', ok: true, count: 0, detail: 'Steam 里已经是最新的，不用写回' })
          writtenBack = 0
        } else {
          const result = await runSteamScreenshotRestore(preview.planId)
          writtenBack = result.restored
          steps.push({
            step: 'writeback',
            ok: true,
            count: result.restored,
            detail: `写回 Steam ${result.restored} 张`
          })
        }
      }
    }
  } catch (error) {
    steps.push({ step: 'writeback', ok: false, count: 0, detail: error instanceof Error ? error.message : String(error) })
  }

  return {
    sources: sources.length - failedSources,
    targets: targets.length,
    backedUp,
    failed,
    pulled,
    writtenBack,
    steps
  }
}
