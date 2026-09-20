/**
 * 应用上下文：主进程持有的数据库与设备身份。
 *
 * 主进程是数据库的唯一拥有者，渲染层只能通过 IPC 触发读写。
 */

import { AppError } from '@shared/errors'
import type { DeviceIdFile } from '@shared/types'
import { openAppDatabase, type AppDatabase } from '@core/db/app-database'
import { loadNodeSqlite } from '@core/db/sqlite'
import { readOrCreateDeviceId } from '@core/settings/device-id'
import { resolveAppPaths, type AppPaths } from './paths'

export interface AppContext {
  readonly paths: AppPaths
  readonly database: AppDatabase
  readonly device: DeviceIdFile
}

let current: AppContext | null = null

/** 初始化数据库连接与设备身份。必须在创建窗口之前完成。 */
export async function initAppContext(): Promise<AppContext> {
  if (current) {
    return current
  }

  const paths = resolveAppPaths()
  const sqlite = await loadNodeSqlite()
  const database = openAppDatabase(paths.databaseFile, sqlite)
  const device = readOrCreateDeviceId(paths.deviceIdFile)

  current = { paths, database, device }
  return current
}

export function getAppContext(): AppContext {
  if (!current) {
    throw new AppError('APP_INTERNAL', '应用上下文尚未初始化')
  }
  return current
}

/** 退出前安全关闭数据库连接。 */
export function disposeAppContext(): void {
  current?.database.close()
  current = null
}
