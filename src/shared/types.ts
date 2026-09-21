/**
 * 跨进程共享的数据类型。
 *
 * 注意：本文件同时被渲染层（tsconfig.web，无 node 类型）引用，
 * 因此不得使用 NodeJS.* 等仅在主进程可用的类型。
 *
 * 路径约束：图库查询（游戏/资产）**不返回任何文件系统路径**，
 * 图片一律通过 assetId 对应的 `ssm-asset` 地址获取；
 * 只有来源管理相关的类型才包含用户自己选择的来源根路径。
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
  /** 后台自动收集新增截图（扫描 + 归档） */
  readonly autoCollect: boolean
  /** 自动收集间隔（分钟） */
  readonly autoCollectIntervalMinutes: number
  /** 自动收集后顺带上传到远端（需要已连接远端存储） */
  readonly autoBackup: boolean
  /** 关闭窗口时隐藏到托盘而不是退出 */
  readonly closeToTray: boolean
  /**
   * 图片优先原图：宁可占用高一点也直接给高清原图，不用来源自带的约 200px 缩略图。
   * 关闭后先给来源缩略图（省内存与解码），适合图库很大、以流畅为先的场景。
   */
  readonly preferOriginalImages: boolean
  /** 开机自动启动 */
  readonly launchAtLogin: boolean
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
  autoCollectIntervalMinutes: 60,
  autoBackup: false,
  closeToTray: true,
  preferOriginalImages: true,
  launchAtLogin: false,
  libraryRoot: null
}

/* ------------------------------------------------------------------ *
 * 来源发现与登记
 * ------------------------------------------------------------------ */

export interface DiscoveredAccountDto {
  readonly accountId: string
  readonly steamId64: string
  readonly accountName: string | null
  readonly personaName: string | null
  readonly hasScreenshotDir: boolean
  readonly gameDirectoryCount: number
}

export interface DiscoveredRootDto {
  readonly rootPath: string
  readonly kind: 'registry' | 'manual' | 'common'
  readonly exists: boolean
  readonly readable: boolean
  /** 已登记为来源时的 sourceId，未登记为 null */
  readonly registeredSourceId: string | null
  readonly accounts: readonly DiscoveredAccountDto[]
}

export interface RegisteredSourceDto {
  readonly sourceId: string
  readonly rootPath: string
  readonly kind: string
  readonly accountKeys: readonly string[]
  readonly lastScanAt: string | null
  readonly lastScanStatus: string | null
}

export interface AccountSummaryDto {
  readonly accountKey: string
  readonly displayName: string | null
  readonly assetCount: number
}

/* ------------------------------------------------------------------ *
 * 扫描
 * ------------------------------------------------------------------ */

export interface ScanProgressDto {
  readonly sourceId: string
  readonly phase: 'enumerating' | 'hashing'
  readonly processed: number
  /** 总量未知时为 null，界面不得伪造百分比 */
  readonly total: number | null
  readonly currentFile: string | null
  readonly failed: number
}

export interface ScanStatusDto {
  readonly running: boolean
  readonly sourceId: string | null
  readonly phase: 'enumerating' | 'hashing' | null
  readonly processed: number
  readonly total: number | null
  readonly currentFile: string | null
  readonly failed: number
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly cancelled: boolean
  readonly errorCode: string | null
  readonly errorMessage: string | null
}

export interface ScanSummaryDto {
  readonly sourceId: string
  readonly scannedAccounts: readonly string[]
  readonly createdAssets: number
  readonly sourceFiles: number
  readonly failures: number
  readonly missingMarked: number
  readonly cancelled: boolean
  readonly durationMs: number
}

/* ------------------------------------------------------------------ *
 * 图库查询（不含任何文件系统路径）
 * ------------------------------------------------------------------ */

export type AssetSortType = 'captured-desc' | 'captured-asc' | 'imported-desc'
export type CaptureTimeSourceType = 'screenshot-index' | 'file-time' | 'unknown'

export interface GalleryGameDto {
  readonly gameKey: string
  readonly name: string
  /** 副标题：Steam 游戏显示 steam-<AppID>，非 Steam 显示 shortcut-<gameID> */
  readonly appKeyLabel: string
  readonly kind: string
  readonly installed: boolean
  readonly assetCount: number
  readonly bytes: number
  readonly latestCapturedAt: string | null
  /** 封面地址：该游戏最近一张真实截图；无可用截图时为 null */
  readonly coverUrl: string | null
  readonly accounts: readonly string[]
}

export interface GalleryAssetDto {
  readonly assetId: string
  readonly gameKey: string
  readonly gameName: string
  readonly accountKey: string
  readonly fileName: string
  readonly bytes: number
  readonly width: number | null
  readonly height: number | null
  readonly capturedAt: string | null
  readonly captureTimeSource: CaptureTimeSourceType
  /** 来源文件当前是否存在；false 时界面必须显示缺失状态 */
  readonly available: boolean
  /** 是否已有受管的图库副本 */
  readonly archived: boolean
  /** 原文件名（来源与图库副本都记录） */
  readonly originalFilename: string | null
  /** 是否已在某个远端通过读回校验 */
  readonly remoteVerified: boolean
  readonly imageUrl: string
  readonly thumbnailUrl: string
  /** 查看器底部缩略图带用的更小尺寸地址 */
  readonly miniUrl: string
}

export interface GalleryPageDto {
  readonly items: readonly GalleryAssetDto[]
  readonly nextCursor: string | null
}

export interface LibraryStatsDto {
  readonly games: number
  readonly assets: number
  readonly bytes: number
  readonly accounts: number
  readonly missingFiles: number
}

/* ------------------------------------------------------------------ *
 * 归档（本地收集）与导出
 * ------------------------------------------------------------------ */

export type ExportLayoutType = 'game' | 'game-year' | 'game-appid' | 'flat'

export interface ArchiveStatusDto {
  readonly running: boolean
  readonly phase: 'planning' | 'copying' | null
  readonly processed: number
  readonly total: number | null
  readonly currentFile: string | null
  readonly copied: number
  readonly skipped: number
  readonly failed: number
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
}

export interface ArchiveSummaryDto {
  readonly total: number
  readonly copied: number
  readonly skipped: number
  readonly failed: number
  readonly cancelled: boolean
  readonly durationMs: number
  readonly libraryRoot: string
}

export interface ExportStatusDto {
  readonly running: boolean
  readonly processed: number
  readonly total: number | null
  readonly currentFile: string | null
  readonly written: number
  readonly skipped: number
  readonly failed: number
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
}

export interface ExportSummaryDto {
  readonly total: number
  readonly written: number
  readonly skipped: number
  readonly failed: number
  readonly conflictsRenamed: number
  readonly cancelled: boolean
  readonly durationMs: number
  readonly targetDir: string
}

export interface LibraryCopyStateDto {
  readonly libraryRoot: string | null
  readonly archived: number
  readonly missing: number
  readonly assets: number
}

/* ------------------------------------------------------------------ *
 * 远端备份（WebDAV）
 * ------------------------------------------------------------------ */

export interface CapabilityItemDto {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

export interface RemoteConnectionDto {
  readonly remoteId: string
  readonly libraryId: string
  readonly baseUrl: string
  readonly lastCheckStatus: string
  readonly capabilities: readonly CapabilityItemDto[]
}

export interface RemoteStateDto {
  readonly connected: boolean
  readonly baseUrl: string | null
  readonly libraryId: string | null
  readonly lastCheckAt: string | null
  readonly lastCheckStatus: string | null
  readonly credentialStored: boolean
  readonly credentialStorageAvailable: boolean
  readonly assets: number
  readonly verified: number
  readonly pending: number
  readonly failed: number
  readonly libraryRoot: string | null
}

export interface UploadStatusDto {
  readonly running: boolean
  readonly processed: number
  readonly total: number | null
  readonly currentFile: string | null
  readonly verified: number
  readonly uploaded: number
  readonly failed: number
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
}

export interface UploadSummaryDto {
  readonly total: number
  readonly verified: number
  readonly uploaded: number
  readonly failed: number
  readonly cancelled: boolean
  readonly abortedByAuth: boolean
  readonly durationMs: number
  readonly libraryId: string
}

/* ------------------------------------------------------------------ *
 * 从远端恢复
 * ------------------------------------------------------------------ */

export interface RestoreGamePlanDto {
  readonly gameKey: string
  readonly gameName: string
  readonly assets: number
  readonly bytes: number
  readonly alreadyLocal: number
}

export interface RemoteCatalogDto {
  readonly libraryId: string
  readonly records: number
  readonly invalidRecords?: number
  readonly games: readonly RestoreGamePlanDto[]
  readonly errors?: readonly string[]
}

export interface RestoreStatusDto {
  readonly running: boolean
  readonly phase: 'scanning' | 'restoring' | null
  readonly processed: number
  readonly total: number | null
  readonly restored: number
  readonly skipped: number
  readonly failed: number
  readonly currentFile: string | null
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
}

export interface RestoreFailureDto {
  readonly recordId: string
  readonly objectKey: string
  readonly code: string
  readonly message: string
}

export interface RestoreSummaryDto {
  readonly total: number
  readonly restored: number
  readonly skipped: number
  readonly failed: number
  readonly cancelled: boolean
  readonly abortedByAuth: boolean
  readonly durationMs: number
  readonly failures: readonly RestoreFailureDto[]
}

export interface PreviewStatsDto {
  readonly count: number
  readonly bytes: number
  readonly pending: number
  readonly generated: number
}
