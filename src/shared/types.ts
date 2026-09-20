/**
 * 跨进程共享的数据类型。
 *
 * 注意：本文件同时被渲染层（tsconfig.web，无 node 类型）引用，
 * 因此不得使用 NodeJS.* 等仅在主进程可用的类型。
 */

/** SQLite 驱动名称。node:sqlite 为 Electron 内置 Node 自带，无需原生模块。 */
export type SqliteDriverName = 'node:sqlite' | 'better-sqlite3'

/** device.json 的内容：设备身份与创建时间。 */
export interface DeviceIdFile {
  readonly deviceId: string
  readonly createdAt: string
}

/** 图库根目录的选择状态。 */
export interface LibraryRootState {
  readonly root: string | null
  readonly selectedAt: string | null
}

/** 本机偏好。首版通过共享 SQLite 同步的设置一律不放这里。 */
export interface Settings {
  /** 自动收集新增截图；工程基础阶段 仅为占位项，默认关闭 */
  readonly autoCollect: boolean
  /** 图库根目录；未选择时为 null */
  readonly libraryRoot: string | null
}

/** app:getInfo 的返回内容。 */
export interface AppInfo {
  readonly version: string
  readonly platform: string
  /** 应用数据目录（Electron 用户数据目录） */
  readonly dataDir: string
  readonly deviceId: string
  readonly sqliteDriver: SqliteDriverName
  readonly libraryRoot: string | null
}

/** db:health 的返回内容：写入一条记录并读回，用于 启动自检。 */
export interface DbHealth {
  readonly driver: SqliteDriverName
  readonly writtenAt: string
  readonly readBack: string
  readonly totalRows: number
}

export const DEFAULT_SETTINGS: Settings = {
  autoCollect: false,
  libraryRoot: null
}
