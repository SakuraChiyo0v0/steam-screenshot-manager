/**
 * IPC 处理器注册。
 *
 * 每个通道都在这里做输入运行时校验，并返回统一的 { ok, data } / { ok, code, message } 结构。
 * 渲染层没有通用文件读写或命令执行通道，所有能力都必须显式列在这里。
 */

import { app, dialog, ipcMain } from 'electron'
import { AppError, ok, toErr } from '@shared/errors'
import { IPC_CHANNELS } from '@shared/ipc'
import type { AppInfo, DbHealth, LibraryRootState, Settings } from '@shared/types'
import { checkLibraryRoot } from '@core/settings/library-root'
import { isSettingsPatch, readSettings, writeSettings } from '@core/settings/settings-store'
import { getAppContext } from './app-context'
import { resolveProtectedRoots } from './paths'

function handle(channel: string, handler: (payload: unknown) => unknown): void {
  ipcMain.handle(channel, async (_event, payload: unknown) => {
    try {
      return ok(await handler(payload))
    } catch (error) {
      return toErr(error)
    }
  })
}

/** 当前图库根目录状态，供 pickRoot 与 getSettings 共用。 */
function readLibraryRootState(): LibraryRootState {
  const { database } = getAppContext()
  const settings = readSettings(database.db)
  return { root: settings.libraryRoot, selectedAt: null }
}

export function registerIpcHandlers(): void {
  handle(IPC_CHANNELS.appGetInfo, (): AppInfo => {
    const context = getAppContext()
    const settings = readSettings(context.database.db)
    return {
      version: app.getVersion(),
      platform: process.platform,
      dataDir: context.paths.dataDir,
      deviceId: context.device.deviceId,
      sqliteDriver: context.database.driver,
      libraryRoot: settings.libraryRoot
    }
  })

  handle(IPC_CHANNELS.settingsGet, (): Settings => {
    const { database } = getAppContext()
    return readSettings(database.db)
  })

  handle(IPC_CHANNELS.settingsUpdate, (payload): Settings => {
    if (!isSettingsPatch(payload)) {
      throw new AppError('IPC_INVALID_INPUT', '设置项或类型不受支持')
    }
    const { database } = getAppContext()

    if (payload.libraryRoot !== undefined && payload.libraryRoot !== null) {
      const check = checkLibraryRoot({
        candidate: payload.libraryRoot,
        protectedRoots: resolveProtectedRoots(getAppContext().paths),
        sourceRoots: []
      })
      if (!check.ok) {
        throw new AppError('LIB_PATH_INVALID', check.reason)
      }
    }

    return writeSettings(database.db, payload)
  })

  handle(IPC_CHANNELS.libraryPickRoot, async (): Promise<LibraryRootState> => {
    const { paths, database } = getAppContext()
    const picked = await dialog.showOpenDialog({
      title: '选择图库根目录',
      properties: ['openDirectory', 'createDirectory']
    })

    if (picked.canceled || picked.filePaths.length === 0) {
      return readLibraryRootState()
    }

    const candidate = picked.filePaths[0]
    const check = checkLibraryRoot({
      candidate,
      protectedRoots: resolveProtectedRoots(paths),
      // 工程基础阶段 尚未登记来源目录（离线采集与归档阶段 引入）；此处先保证不指向受保护目录。
      sourceRoots: []
    })
    if (!check.ok) {
      throw new AppError('LIB_PATH_INVALID', check.reason)
    }

    writeSettings(database.db, { libraryRoot: check.normalized })
    return { root: check.normalized, selectedAt: new Date().toISOString() }
  })

  handle(IPC_CHANNELS.dbHealth, (): DbHealth => {
    const { database } = getAppContext()
    return database.health()
  })
}
