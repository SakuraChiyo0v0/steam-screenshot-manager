/**
 * 自动更新（主进程）。
 *
 * 来源：electron-builder 打包时写进 resources/app-update.yml 的 GitHub Releases。
 * 客户端不需要 token：仓库公开，更新清单 latest.yml 与安装包都在 Release 里。
 *
 * 节奏：启动一分钟后查一次，之后每 6 小时一次；查到新版本就在后台下好，
 * 用户点「重启并安装」或下次正常退出时装上（autoInstallOnAppQuit）。
 * 关掉「自动检查更新」后定时器不再排，手动检查到了也只提示，下载由用户点。
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'electron-updater'
import type { UpdateProgressDto, UpdateStateDto } from '@shared/types'
import { friendlyUpdateError, isNoReleaseError, type UpdateSource } from '@shared/update'

/** 启动后多久第一次检查：避开启动时最忙的那一阵（建索引、对账、托盘） */
export const FIRST_CHECK_DELAY_MS = 60_000
export const CHECK_INTERVAL_MS = 6 * 60 * 60_000
/** 更新进度推送的最小间隔，避免下载时每块都往渲染层发一次 */
const PROGRESS_THROTTLE_MS = 200

export interface UpdaterLog {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
}

export interface Updater {
  getState(): UpdateStateDto
  check(): Promise<UpdateStateDto>
  download(): Promise<UpdateStateDto>
  /** 立刻退出并安装已下载的版本 */
  install(): void
  onChange(listener: (state: UpdateStateDto) => void): () => void
  dispose(): void
}

function idleState(currentVersion: string, enabled: boolean): UpdateStateDto {
  return {
    phase: enabled ? 'idle' : 'disabled',
    currentVersion,
    availableVersion: null,
    releaseNotes: null,
    progress: null,
    errorMessage: null,
    checkedAt: null
  }
}

/** Release 正文里的 Markdown 用中文原样显示即可，去掉首尾空白就够。 */
function notesOf(info: UpdateInfo): string | null {
  const notes = typeof info.releaseNotes === 'string' ? info.releaseNotes : null
  if (notes && notes.trim().length > 0) return notes.trim().slice(0, 20_000)
  if (Array.isArray(info.releaseNotes)) {
    const joined = info.releaseNotes
      .map((item) => (typeof item === 'object' && item && 'note' in item ? String(item.note ?? '') : ''))
      .join('\n')
      .trim()
    return joined.length > 0 ? joined.slice(0, 20_000) : null
  }
  return null
}

function toProgress(info: ProgressInfo): UpdateProgressDto {
  return {
    percent: Math.max(0, Math.min(100, Math.round(info.percent))),
    transferred: Math.max(0, Math.round(info.transferred)),
    total: Math.max(0, Math.round(info.total)),
    bytesPerSecond: Math.max(0, Math.round(info.bytesPerSecond))
  }
}

export interface CreateUpdaterOptions {
  readonly source: UpdateSource
  readonly log: UpdaterLog
  /** 状态变化时推给所有窗口（通道 update:progress） */
  readonly broadcast: (payload: UpdateStateDto) => void
  /** 演练用：开发模式下 generic 源需要一份 dev-app-update.yml */
  readonly userDataDir: string
}

/**
 * 建立更新器。source 为 off（开发运行且没有演练地址、或工具模式）时返回 null：
 * 这时界面上「检查更新」会明确显示为不可用，而不是点了没反应。
 */
export function createUpdater(options: CreateUpdaterOptions): Updater | null {
  const { source, log } = options
  if (source.kind === 'off') {
    return null
  }

  // 打包后不写日志会被 electron-updater 的默认 logger 打到 stdout；
  // 这里统一压成一行，错误只留第一条，避免整段堆栈刷屏。
  autoUpdater.logger = {
    info: (message?: unknown) => log.info('更新', { msg: String(message) }),
    warn: (message?: unknown) => log.warn('更新', { msg: String(message) }),
    error: (message?: unknown) => log.warn('更新', { msg: String(message).split('\n')[0] }),
    debug: () => undefined
  }
  // 下完了用户没点「重启并安装」：正常退出时静默装上（electron-updater 的默认值，这里写明）
  autoUpdater.autoInstallOnAppQuit = true

  if (source.kind === 'generic') {
    // 演练：没打包时 electron-updater 要读 dev-app-update.yml（下载阶段还要取缓存目录名）
    const config = join(options.userDataDir, 'dev-app-update.yml')
    writeFileSync(
      config,
      `provider: generic\nurl: ${JSON.stringify(source.url)}\nupdaterCacheDirName: steam-screenshot-manager-updater\n`
    )
    autoUpdater.updateConfigPath = config
    autoUpdater.forceDevUpdateConfig = true
    autoUpdater.setFeedURL({ provider: 'generic', url: source.url })
  }

  let state: UpdateStateDto = idleState(app.getVersion(), true)
  let lastProgressAt = 0
  const listeners = new Set<(state: UpdateStateDto) => void>()

  const publish = (patch: Partial<UpdateStateDto>): UpdateStateDto => {
    state = { ...state, ...patch }
    options.broadcast(state)
    for (const listener of listeners) listener(state)
    return state
  }

  const fail = (error: unknown): UpdateStateDto => {
    if (isNoReleaseError(error)) {
      log.info('更新源上还没有可用的版本')
      return publish({ phase: 'up-to-date', progress: null, errorMessage: null, checkedAt: new Date().toISOString() })
    }
    log.warn('更新失败', { err: error instanceof Error ? error.message.split('\n')[0] : String(error) })
    return publish({
      phase: 'error',
      progress: null,
      errorMessage: friendlyUpdateError(error),
      checkedAt: new Date().toISOString()
    })
  }

  autoUpdater.on('checking-for-update', () => {
    publish({ phase: 'checking', errorMessage: null })
  })
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    publish({
      phase: 'available',
      availableVersion: info.version,
      releaseNotes: notesOf(info),
      progress: null,
      errorMessage: null,
      checkedAt: new Date().toISOString()
    })
  })
  autoUpdater.on('update-not-available', () => {
    publish({
      phase: 'up-to-date',
      availableVersion: null,
      releaseNotes: null,
      progress: null,
      errorMessage: null,
      checkedAt: new Date().toISOString()
    })
  })
  autoUpdater.on('download-progress', (info: ProgressInfo) => {
    const now = Date.now()
    if (now - lastProgressAt < PROGRESS_THROTTLE_MS) return
    lastProgressAt = now
    publish({ phase: 'downloading', progress: toProgress(info) })
  })
  autoUpdater.on('update-downloaded', () => {
    log.info('新版本已下载，等待安装')
    publish({ phase: 'downloaded', progress: null, errorMessage: null })
  })
  autoUpdater.on('error', (error: Error) => {
    fail(error)
  })

  /** 读最新状态：await 之后 TS 不会把上面的收窄粘住（状态由事件异步改写） */
  const phase = (): UpdateStateDto['phase'] => state.phase
  const busy = (): boolean => phase() === 'checking' || phase() === 'downloading'

  return {
    getState: () => state,

    async check() {
      if (busy()) return state
      publish({ phase: 'checking', errorMessage: null })
      try {
        await autoUpdater.checkForUpdates()
      } catch (error) {
        // 事件里通常已经报过一次；这里兜住同步抛出的那类
        if (phase() === 'checking') fail(error)
      }
      return state
    },

    async download() {
      if (phase() === 'downloading' || phase() === 'downloaded') return state
      if (phase() !== 'available') {
        // 还没查到新版本：先查一次再决定要不要下
        await this.check()
        if (phase() !== 'available') return state
      }
      publish({ phase: 'downloading', progress: null })
      try {
        await autoUpdater.downloadUpdate()
      } catch (error) {
        if (phase() === 'downloading') fail(error)
      }
      return state
    },

    install() {
      if (phase() !== 'downloaded') return
      // isSilent / isForceRunAfter：静默装上并自动重开，别让用户以为应用被关掉了
      setImmediate(() => autoUpdater.quitAndInstall(true, true))
    },

    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    dispose() {
      listeners.clear()
      autoUpdater.removeAllListeners()
    }
  }
}

/** 主进程里只有一个更新器：index.ts 建好后登记，IPC 层按需取用。 */
let registered: Updater | null = null
let scheduler: UpdateScheduler | null = null

export function registerUpdater(updater: Updater | null): void {
  registered = updater
}

export function registerScheduler(next: UpdateScheduler | null): void {
  scheduler = next
}

/** 「自动检查更新」开关变了：立刻按新状态重排（开=按首检延迟再排，关=取消已排的）。 */
export function applyAutoCheckSetting(enabled: boolean): void {
  scheduler?.setEnabled(enabled)
}

export function getUpdater(): Updater | null {
  return registered
}

/** 更新源不可用时（开发运行、工具模式）给界面一个明确的「不可用」状态。 */
export function disabledUpdateState(): UpdateStateDto {
  return idleState(app.getVersion(), false)
}

/**
 * 自动检查的节奏：启动一分钟后查一次，之后每 6 小时一次。
 * 查到新版本时：开着「自动检查更新」就直接后台下载，否则只提示，等用户点。
 */
export class UpdateScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private lastPhase: UpdateStateDto['phase'] | null = null
  private readonly offChange: () => void

  constructor(
    private readonly options: {
      updater: Updater
      enabled: () => boolean
      log: UpdaterLog
    }
  ) {
    this.offChange = options.updater.onChange((state) => {
      if (state.phase === this.lastPhase && state.phase !== 'error') return
      this.lastPhase = state.phase
      if (state.phase === 'available' && options.enabled()) {
        options.log.info('发现新版本，开始后台下载', { version: state.availableVersion })
        void options.updater.download()
      }
    })
  }

  start(): void {
    this.schedule(FIRST_CHECK_DELAY_MS)
  }

  setEnabled(enabled: boolean): void {
    this.cancel()
    if (enabled) this.schedule(FIRST_CHECK_DELAY_MS)
  }

  stop(): void {
    this.stopped = true
    this.cancel()
    this.offChange()
  }

  private schedule(delay: number): void {
    if (this.stopped || !this.options.enabled()) return
    this.cancel()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, delay)
    // 定时器不该把进程钉住（托盘常驻时无所谓，但退出时别再等它）
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    const phase = this.options.updater.getState().phase
    // 已经在下载 / 下好了：没必要再问一遍
    if (phase !== 'downloading' && phase !== 'downloaded') {
      await this.options.updater.check()
    }
    this.schedule(CHECK_INTERVAL_MS)
  }

  private cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
