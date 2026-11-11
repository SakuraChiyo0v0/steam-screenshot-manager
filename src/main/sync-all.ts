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
import { appendFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '@shared/errors'
import { listSources } from '@core/library/index-writer'
import { readSettings } from '@core/settings/settings-store'
import { completeGameNamesFromCache } from '@core/steam/app-names'
import { getAppContext } from './app-context'
import { cancelScan, startScan, getScanStatus } from './scan-job'
import { cancelUpload, getUploadStatus, remoteTargets, runUpload } from './sync-job'
import { cancelRestore, getRestoreStatus, runRestore, scanRemoteCatalog } from './restore-job'
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
/** 进度卡住多久算"网络挂了"：超过这个时间没变化就主动停掉，别让它无限等。 */
const STALL_LIMIT_MS = 3 * 60 * 1000

function makeWatchdog(): { check: () => boolean; stop: () => void } {
  let lastSignature = ''
  let lastChangeAt = Date.now()
  const timer = setInterval(() => {
    const scan = getScanStatus()
    const upload = getUploadStatus()
    const restore = getRestoreStatus()
    const signature = [
      scan.running ? `s:${scan.processed}` : 's:-',
      upload.running ? `u:${upload.processed}` : 'u:-',
      restore.running ? `r:${restore.processed}` : 'r:-'
    ].join('|')
    if (signature !== lastSignature) {
      lastSignature = signature
      lastChangeAt = Date.now()
      return
    }
    if (Date.now() - lastChangeAt < STALL_LIMIT_MS) return
    // 卡住：把还在跑的任务都请求停止，交给上层如实报告
    if (scan.running) cancelScan()
    if (upload.running) cancelUpload()
    if (restore.running) cancelRestore()
  }, 10_000)
  timer.unref?.()
  return {
    check: () => Date.now() - lastChangeAt >= STALL_LIMIT_MS,
    stop: () => clearInterval(timer)
  }
}

export function startSyncAll(): { started: boolean; error?: string } {
  if (background.running) {
    return { started: false, error: '同步已经在跑了' }
  }
  background = { ...background, running: true, error: null }
  void (async () => {
    const watchdog = makeWatchdog()
    try {
      background = { running: true, last: background.last, error: null }
      const result = await runSyncAll()
      const stalled = watchdog.check()
      background = {
        running: false,
        last: {
          ...result,
          steps: stalled
            ? [
                ...result.steps,
                { step: 'push', ok: false, count: 0, detail: '有几步长时间没有进展，已停止；检查网络或备份盘是否掉线' }
              ]
            : result.steps
        },
        error: null
      }
    } catch (error) {
      background = {
        running: false,
        last: background.last,
        error: error instanceof Error ? error.message : String(error)
      }
    } finally {
      watchdog.stop()
    }
  })()
  return { started: true }
}

export function getSyncAllState(): { running: boolean; last: SyncAllResult | null; error: string | null } {
  return background
}

/**
 * 删掉「Steam 来源里已经有同一张图」的内部副本。
 *
 * 恢复流程以前会把下载下来的原图长期留在用户数据目录；写回 Steam 之后那份就是重复的，
 * 这里按「来源里已存在同指纹文件」精确删除，只动副本记录与它指向的文件。
 */
function cleanupRedundantCopies(): number {
  const { database } = getAppContext()
  const settings = readSettings(database.db)
  const libraryRoot = settings.libraryRoot
  if (!libraryRoot) return 0

  const rows = database.db
    .prepare(
      `SELECT lc.local_copy_id AS id, lc.relative_path AS relativePath, lc.bytes AS bytes,
              s.root_path AS sourceRoot, sf.relative_path AS sourceRel
         FROM local_copies lc
         JOIN assets a ON a.asset_id = lc.asset_id
         JOIN source_files sf ON sf.asset_id = a.asset_id AND sf.present = 1
         JOIN sources s ON s.source_id = sf.source_id
        WHERE lc.library_root = ?
        GROUP BY lc.local_copy_id`
    )
    .all(libraryRoot) as {
    id: string
    relativePath: string
    bytes: number
    sourceRoot: string
    sourceRel: string
  }[]

  if (rows.length === 0) return 0
  const remove = database.db.prepare('DELETE FROM local_copies WHERE local_copy_id = ?')
  let cleaned = 0
  const log: string[] = []
  for (const row of rows) {
    try {
      // 硬性安全条件：Steam 来源里必须真的存在这份原图，且大小与副本一致。
      // 任何一条对不上就不删——宁可多占一份空间，也不能只剩一份还被删掉。
      const sourcePath = join(row.sourceRoot, ...String(row.sourceRel).split(/[\\/]/))
      const info = statSync(sourcePath)
      if (!info.isFile() || info.size !== Number(row.bytes)) {
        continue
      }
      rmSync(join(libraryRoot, ...row.relativePath.split('/')), { force: true })
      remove.run(row.id)
      log.push(row.relativePath)
      cleaned += 1
    } catch {
      // 单个失败不影响其余
    }
  }
  if (log.length > 0) {
    try {
      const { paths } = getAppContext()
      const logDir = join(paths.dataDir, 'logs')
      mkdirSync(logDir, { recursive: true })
      appendFileSync(join(logDir, 'cleanup-copies.log'), `${new Date().toISOString()} 清理 ${log.length} 份临时副本\n${log.join('\n')}\n`)
    } catch {
      // 日志失败不影响主流程
    }
  }
  return cleaned
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
    } else if (missingCount > 200) {
      // 一次要下几百上千张时不要"偷偷"开始：先告诉用户，让他决定
      steps.push({
        step: 'pull',
        ok: true,
        count: 0,
        detail: `备份里比本机多 ${missingCount} 张，已跳过自动取回（避免长时间下载）；需要时点「从备份取回」`
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

  // 写回 Steam 之后，内部分缓存里的原图已经"搬进" Steam 来源目录了：
  // 重新扫一次来源让索引认得它们，然后把这些临时副本删掉，别让它长期占着用户数据目录。
  if ((writtenBack ?? 0) > 0) {
    try {
      for (const source of sources) {
        await startScan({ sourceId: source.sourceId, accountIds: [] }).catch(() => undefined)
      }
      const cleaned = cleanupRedundantCopies()
      if (cleaned > 0) {
        steps.push({
          step: 'writeback',
          ok: true,
          count: writtenBack ?? 0,
          detail: `写回 Steam ${writtenBack} 张；已清理临时副本 ${cleaned} 份`
        })
      }
    } catch {
      // 清理失败不影响主流程
    }
  }

  // 同步完成后用本地名称缓存补一次名字（离线可用，不会联网）
  try {
    completeGameNamesFromCache(database.db, new Date().toISOString())
  } catch {
    // 忽略
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
