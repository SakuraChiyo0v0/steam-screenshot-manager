/**
 * 系统托盘（主进程）。
 *
 * 提供"不打开窗口也能用"的入口：显示主窗口、立即收集、立即备份、退出。
 * 菜单里的状态文字来自各任务的实时状态，避免用户猜"它在不在跑"。
 */

import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { join } from 'node:path'
import { getScanStatus } from './scan-job'
import { getArchiveStatus } from './archive-job'
import { getUploadStatus } from './sync-job'
import { getAutoCollectState, runAutoCollectNow } from './auto-collect'

let tray: Tray | null = null

/** 开发运行与打包运行的图标位置不同。 */
function trayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'tray.png')
    : join(app.getAppPath(), 'resources', 'tray.png')
}

function statusLine(): string {
  const scan = getScanStatus()
  const archive = getArchiveStatus()
  const upload = getUploadStatus()
  if (scan.running) {
    return `正在扫描：${scan.processed}${scan.total === null ? '' : `/${scan.total}`}`
  }
  if (archive.running) {
    return `正在归档：${archive.processed}${archive.total === null ? '' : `/${archive.total}`}`
  }
  if (upload.running) {
    return `正在备份：${upload.processed}${upload.total === null ? '' : `/${upload.total}`}`
  }
  const auto = getAutoCollectState()
  if (auto.lastResult) {
    return `上次自动收集：${auto.lastResult}`
  }
  return '空闲'
}

export function refreshTray(): void {
  if (!tray) {
    return
  }
  const auto = getAutoCollectState()
  const window = BrowserWindow.getAllWindows()[0]
  const busy = getScanStatus().running || getArchiveStatus().running || getUploadStatus().running

  tray.setToolTip(`拾光 · Steam 截图管理器\n${statusLine()}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: window && !window.isDestroyed() ? '显示主窗口' : '打开主窗口',
        click: () => {
          const target = BrowserWindow.getAllWindows()[0]
          if (!target) {
            return
          }
          if (target.isMinimized()) {
            target.restore()
          }
          target.show()
          target.focus()
        }
      },
      { type: 'separator' },
      { label: statusLine(), enabled: false },
      {
        label: auto.enabled
          ? `自动收集：每 ${auto.intervalMinutes} 分钟`
          : '自动收集：已关闭（可在设置里开启）',
        enabled: false
      },
      {
        label: '立即收集一次',
        enabled: !busy && auto.enabled,
        click: () => {
          void runAutoCollectNow().then(() => refreshTray())
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.exit(0)
        }
      }
    ])
  )
}

export function createTray(onQuit: () => void): void {
  if (tray) {
    return
  }
  const iconPath = trayIconPath()
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    console.warn(`[托盘] 图标读取失败：${iconPath}`)
    return
  }
  try {
    tray = new Tray(image)
    console.log('[托盘] 已创建')
  } catch (error) {
    console.warn('[托盘] 创建失败：', error instanceof Error ? error.message : String(error))
    tray = null
    return
  }
  tray.on('click', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) {
      return
    }
    if (window.isVisible() && !window.isMinimized()) {
      window.hide()
    } else {
      window.show()
      window.focus()
    }
  })
  tray.on('right-click', () => refreshTray())
  void onQuit
  refreshTray()
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
