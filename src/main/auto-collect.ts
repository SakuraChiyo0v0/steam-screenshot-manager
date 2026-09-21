/**
 * 后台自动收集（主进程）。
 *
 * 目标：日常不需要反复手动操作。启动后延迟一段时间跑一次，之后按设置的间隔重复：
 *   增量扫描（只处理新增/变化的文件）→ 归档（幂等，只补缺的）→ 可选上传（幂等）。
 *
 * 约束：
 * - 任何一步失败都只记录并继续，不打断用户操作；
 * - 已有同类任务在跑时跳过本轮（不排队、不叠加）；
 * - 自动收集关闭时完全不启动定时器；
 * - 工具模式（--verify-*）下不启用。
 */

import { readSettings } from '@core/settings/settings-store'
import { listSources } from '@core/library/index-writer'
import { getAppContext } from './app-context'
import { getScanStatus, startScan } from './scan-job'
import { getArchiveStatus, runArchive } from './archive-job'
import { getUploadStatus, runUpload } from './sync-job'
import { getRemoteState } from './sync-job'

export interface AutoCollectState {
  readonly enabled: boolean
  readonly intervalMinutes: number
  readonly lastRunAt: string | null
  readonly lastResult: string | null
  readonly nextRunAt: string | null
  readonly running: boolean
}

let timer: NodeJS.Timeout | null = null
let state: AutoCollectState = {
  enabled: false,
  intervalMinutes: 60,
  lastRunAt: null,
  lastResult: null,
  nextRunAt: null,
  running: false
}
let started = false

export function getAutoCollectState(): AutoCollectState {
  return state
}

function log(message: string): void {
  console.log(`[自动收集] ${message}`)
}

/** 串行执行一轮：扫描 → 归档 →（可选）上传。 */
async function runOnce(reason: string): Promise<void> {
  if (state.running) {
    return
  }
  const { database } = getAppContext()
  const settings = readSettings(database.db)
  if (!settings.autoCollect) {
    return
  }
  if (getScanStatus().running || getArchiveStatus().running || getUploadStatus().running) {
    log(`跳过本轮（${reason}）：已有任务在执行`)
    return
  }

  state = { ...state, running: true }
  const startedAt = Date.now()
  const parts: string[] = []

  try {
    const sources = listSources(database.db)
    if (sources.length === 0) {
      state = { ...state, running: false, lastRunAt: new Date().toISOString(), lastResult: '没有登记来源' }
      return
    }

    let scannedFiles = 0
    for (const source of sources) {
      try {
        const summary = await startScan({ sourceId: source.sourceId, accountIds: [] })
        scannedFiles += summary.sourceFiles
      } catch (error) {
        if (error instanceof Error && error.message.includes('已有扫描任务')) {
          break
        }
        log(`扫描来源失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    parts.push(`扫描 ${scannedFiles} 个文件`)

    if (settings.libraryRoot) {
      try {
        const archived = await runArchive({})
        parts.push(`新归档 ${archived.copied}`)
      } catch (error) {
        log(`归档失败：${error instanceof Error ? error.message : String(error)}`)
      }

      if (settings.autoBackup) {
        const remote = getRemoteState()
        if (remote.connected) {
          try {
            const uploaded = await runUpload({})
            parts.push(`新备份 ${uploaded.uploaded}`)
          } catch (error) {
            log(`备份失败：${error instanceof Error ? error.message : String(error)}`)
          }
        } else {
          parts.push('未连接远端，跳过备份')
        }
      }
    }
  } finally {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    state = {
      ...state,
      running: false,
      lastRunAt: new Date().toISOString(),
      lastResult: `${parts.join(' · ')}（${seconds}s）`
    }
    log(state.lastResult ?? '')
  }
}

/** 重新安排定时器（设置变化后调用）。 */
export function rescheduleAutoCollect(): void {
  const { database } = getAppContext()
  const settings = readSettings(database.db)

  if (timer) {
    clearInterval(timer)
    timer = null
  }

  state = {
    ...state,
    enabled: settings.autoCollect,
    intervalMinutes: settings.autoCollectIntervalMinutes
  }

  if (!settings.autoCollect) {
    state = { ...state, nextRunAt: null }
    return
  }

  const intervalMs = Math.max(5, settings.autoCollectIntervalMinutes) * 60 * 1000
  // 启动后先等 2 分钟再跑第一轮，避免和启动时的窗口加载抢资源
  const firstDelayMs = started ? intervalMs : 2 * 60 * 1000
  state = { ...state, nextRunAt: new Date(Date.now() + firstDelayMs).toISOString() }

  timer = setInterval(() => {
    state = { ...state, nextRunAt: new Date(Date.now() + intervalMs).toISOString() }
    void runOnce('定时')
  }, intervalMs)

  if (!started) {
    setTimeout(() => {
      void runOnce('启动后首轮')
    }, firstDelayMs)
  }
  started = true
}

/** 手动触发一轮（“立即收集”菜单项）。 */
export async function runAutoCollectNow(): Promise<void> {
  await runOnce('手动')
}
