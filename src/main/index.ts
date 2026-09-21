/**
 * 主进程入口。
 *
 * 安全基线：上下文隔离开启、渲染层无 Node 集成、sandbox 开启、单实例运行。
 * 数据库与设备身份初始化完成后才创建窗口。
 *
 * 支持 `--self-check`：初始化应用数据、写入并读回一条记录，
 * 把结果以 JSON 写到用户数据目录下的 self-check.json（同时打印到标准输出），然后退出。
 * 该入口用于在开发运行与打包产物中拿到机器可读的数据库读写证据，不创建窗口。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, app, shell } from 'electron'
import { readSettings } from '@core/settings/settings-store'
import { registerAssetProtocol, registerAssetScheme } from './asset-protocol'
import { disposeAppContext, getAppContext, initAppContext, type AppContext } from './app-context'
import { registerIpcHandlers } from './ipc'
import { readVerifyScanTarget, runVerifyScan } from './verify-scan'
import { readVerifyArchiveTarget, runVerifyArchive } from './verify-archive'
import { readVerifyUploadTarget, runVerifyUpload } from './verify-upload'
import { readVerifyRestoreTarget, runVerifyRestore } from './verify-restore'
import { readBuildPreviewsTarget, runBuildPreviews } from './build-previews'
import { createTray, destroyTray, refreshTray } from './tray'
import { rescheduleAutoCollect } from './auto-collect'
import { reconcileNow } from './archive-job'

const SELF_CHECK_FLAG = '--self-check'
const SELF_CHECK_TIMEOUT_MS = 30_000

let mainWindow: BrowserWindow | null = null

// 必须在 app ready 之前注册自定义协议的特权，否则 <img> 无法使用 ssm-asset://
registerAssetScheme()

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    show: false,
    title: 'Steam 截图管理器',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  window.on('ready-to-show', () => window.show())

  // 关闭到托盘：不退出进程，任务继续跑；真正的退出走托盘菜单或系统退出。
  window.on('close', (event) => {
    if (quitting) {
      return
    }
    const settings = readSettings(getAppContext().database.db)
    if (!settings.closeToTray) {
      return
    }
    event.preventDefault()
    window.hide()
    refreshTray()
  })

  window.on('closed', () => {
    mainWindow = null
  })

  // 外部链接交给系统浏览器，不在应用内打开；不做任意导航。
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

/** 是否正在真正退出（用于区分"关闭窗口"与"退出应用"）。 */
let quitting = false
let trayTimer: NodeJS.Timeout | null = null

/** 开机自启跟随设置。 */
export function applyLoginItem(enabled: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, args: [] })
  } catch (error) {
    console.warn('[启动项] 设置失败：', error instanceof Error ? error.message : String(error))
  }
}

function focusExistingWindow(): void {
  if (!mainWindow) {
    return
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.focus()
}

/** 收集 工程基础阶段的出口需要的运行环境与数据库事实。 */
function buildSelfCheckReport(context: AppContext, startedAt: number): Record<string, unknown> {
  const health = context.database.health()
  const settings = readSettings(context.database.db)

  return {
    mode: 'self-check',
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    },
    dataDir: context.paths.dataDir,
    databaseFile: context.paths.databaseFile,
    deviceIdFile: context.paths.deviceIdFile,
    sqliteDriver: context.database.driver,
    schemaVersion: context.database.schemaVersion,
    deviceId: context.device.deviceId,
    libraryRoot: settings.libraryRoot,
    healthCheck: {
      writtenAt: health.writtenAt,
      readBackMatches: health.readBack.length > 0,
      totalRows: health.totalRows
    },
    elapsedMs: Math.round(performance.now() - startedAt)
  }
}

/**
 * 渲染层能力边界探测。
 *
 * 用与产品完全相同的 webPreferences 打开一个隐藏窗口，加载真实渲染页面，
 * 在页面主世界（contextIsolation 之下）检查：
 * - require / process 是否不可见；
 * - 能否越过 IPC 直接读取文件系统；
 * - 白名单 API 是否能正常往返主进程。
 * 这条证据对应 工程基础阶段的出口的"界面无法任意访问硬盘"。
 */
async function probeRendererBoundary(): Promise<Record<string, unknown>> {
  const probeWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  try {
    await probeWindow.loadFile(join(__dirname, '../renderer/index.html'))

    const probe = await probeWindow.webContents.executeJavaScript(`(async () => {
      const result = {
        requireType: typeof require,
        processType: typeof process,
        globalApiType: typeof window.api,
        apiMethods: window.api ? Object.keys(window.api).sort() : []
      }
      try {
        const fs = require('node:fs')
        result.fsReachable = typeof fs?.readFileSync === 'function'
      } catch (error) {
        result.fsReachable = false
        result.fsError = String(error && error.message || error).slice(0, 120)
      }
      try {
        const info = await window.api.getAppInfo()
        result.ipcRoundTripOk = Boolean(info && info.ok)
        result.ipcReportedDriver = info && info.data ? info.data.sqliteDriver : null
      } catch (error) {
        result.ipcRoundTripOk = false
        result.ipcError = String(error && error.message || error).slice(0, 120)
      }
      return result
    })()`)

    return probe as Record<string, unknown>
  } finally {
    probeWindow.destroy()
  }
}

async function runSelfCheck(): Promise<void> {
  const startedAt = performance.now()
  const timeout = setTimeout(() => {
    console.error('[自检] 超过 30 秒未完成，按失败退出')
    app.exit(2)
  }, SELF_CHECK_TIMEOUT_MS)

  try {
    const context = await initAppContext()
    registerIpcHandlers()

    const report = buildSelfCheckReport(context, startedAt)
    report.rendererBoundary = await probeRendererBoundary()

    const reportFile = join(context.paths.dataDir, 'self-check.json')

    mkdirSync(context.paths.dataDir, { recursive: true })
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(`[自检] 报告已写入 ${reportFile}\n`)

    disposeAppContext()
    clearTimeout(timeout)
    app.exit(0)
  } catch (error) {
    clearTimeout(timeout)
    const detail = error instanceof Error ? error.message : String(error)
    console.error('[自检失败]', detail)
    app.exit(1)
  }
}

// 单实例：拿不到锁说明已有实例在运行，本次启动直接退出。
const isToolMode =
  readVerifyScanTarget(process.argv) !== null ||
  readVerifyArchiveTarget(process.argv) !== null ||
  readVerifyUploadTarget(process.argv) !== null ||
  readVerifyRestoreTarget(process.argv) !== null ||
  readBuildPreviewsTarget(process.argv) !== null ||
  process.argv.includes(SELF_CHECK_FLAG)

// 工具模式（自检 / 扫描验证）不参与单实例锁：它们不创建窗口，
// 也不应因为界面实例正在运行而无法执行。
const hasSingleInstanceLock = isToolMode ? true : app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    focusExistingWindow()
  })

  app.whenReady().then(async () => {
    // 真机扫描验证入口（工具模式，不创建窗口）
    const verifyTarget = readVerifyScanTarget(process.argv)
    if (verifyTarget) {
      await runVerifyScan(verifyTarget)
      return
    }

    // 真机归档验证入口（工具模式，不创建窗口）
    const verifyArchiveTarget = readVerifyArchiveTarget(process.argv)
    if (verifyArchiveTarget) {
      await runVerifyArchive(verifyArchiveTarget, process.argv)
      return
    }

    // 真机上传验证入口（工具模式，不创建窗口）
    const verifyUploadTarget = readVerifyUploadTarget(process.argv)
    if (verifyUploadTarget) {
      await runVerifyUpload(verifyUploadTarget, process.argv)
      return
    }

    // 真机恢复验证入口（工具模式，不创建窗口）
    const verifyRestoreTarget = readVerifyRestoreTarget(process.argv)
    if (verifyRestoreTarget) {
      await runVerifyRestore(verifyRestoreTarget, process.argv)
      return
    }

    // 批量生成预览缓存（工具模式，不创建窗口）
    const buildPreviewsTarget = readBuildPreviewsTarget(process.argv)
    if (buildPreviewsTarget) {
      await runBuildPreviews(buildPreviewsTarget)
      return
    }

    if (process.argv.includes(SELF_CHECK_FLAG)) {
      await runSelfCheck()
      return
    }

    let context: AppContext
    try {
      context = await initAppContext()
    } catch (error) {
      // 数据库初始化失败时保留原库、给出可读原因并退出，不自动重建数据库。
      const detail = error instanceof Error ? error.message : String(error)
      console.error('[启动失败] 无法初始化应用数据：', detail)
      app.exit(1)
      return
    }

    console.log(
      [
        '[启动] 数据目录=' + context.paths.dataDir,
        'SQLite驱动=' + context.database.driver,
        'schema=' + context.database.schemaVersion,
        '设备ID=' + context.device.deviceId,
        '打包运行=' + String(app.isPackaged)
      ].join('　')
    )

    // 启动对账：受管副本缺失则标记，清理 staging 残留；失败不影响启动
    try {
      const reconciled = reconcileNow()
      if (reconciled.missing > 0 || reconciled.stagingCleaned > 0) {
        console.log(
          `[对账] 受管副本缺失 ${reconciled.missing}，清理 staging ${reconciled.stagingCleaned}`
        )
      }
    } catch (error) {
      console.warn('[对账] 跳过：', error instanceof Error ? error.message : String(error))
    }

    registerIpcHandlers()
    registerAssetProtocol()
    mainWindow = createWindow()

    // 托盘：不打开窗口也能看到状态与触发收集
    createTray(() => {
      quitting = true
    })
    // 托盘状态每 10 秒刷新一次（任务状态是内存里的轻量读取）
    trayTimer = setInterval(() => refreshTray(), 10_000)

    // 开机自启跟随设置；自动收集按设置的间隔重新排期
    const startupSettings = readSettings(getAppContext().database.db)
    applyLoginItem(startupSettings.launchAtLogin)
    rescheduleAutoCollect()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow()
      } else {
        focusExistingWindow()
      }
    })
  })

  app.on('before-quit', () => {
  quitting = true
  if (trayTimer) {
    clearInterval(trayTimer)
    trayTimer = null
  }
  destroyTray()
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    disposeAppContext()
  })
}

