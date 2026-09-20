/**
 * 应用数据位置。
 *
 * 应用设置、设备身份与任务数据库全部位于 Electron 用户数据目录，
 * 不得放进安装目录或源码目录（docs/architecture.md 第 3 节）。
 */

import { join } from 'node:path'
import { app } from 'electron'

export interface AppPaths {
  readonly dataDir: string
  readonly databaseFile: string
  readonly deviceIdFile: string
  readonly logDir: string
}

export function resolveAppPaths(): AppPaths {
  const dataDir = app.getPath('userData')
  return {
    dataDir,
    databaseFile: join(dataDir, 'app.sqlite3'),
    deviceIdFile: join(dataDir, 'device.json'),
    logDir: join(dataDir, 'logs')
  }
}

/**
 * 受保护目录：图库根目录不得指向这些位置，也不得包含它们。
 * - 应用数据目录：混入数据库与凭据的目录；
 * - 应用根目录：开发时为源码目录，打包后为 app.asar 所在目录；
 * - 可执行文件目录：安装目录。
 */
export function resolveProtectedRoots(paths: AppPaths): string[] {
  const roots = new Set<string>([paths.dataDir, app.getAppPath(), app.getPath('exe')])
  return [...roots]
}
