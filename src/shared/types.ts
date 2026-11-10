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
  /** 后台自动检查更新（启动一分钟后一次，之后每 6 小时一次） */
  readonly autoCheckUpdates: boolean
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
  libraryRoot: null,
  autoCheckUpdates: true
}

/* ------------------------------------------------------------------ *
 * 应用更新（GitHub Releases）
 * ------------------------------------------------------------------ */

/** 更新状态机。'disabled' 表示当前形态不接更新源（开发运行、工具模式）。 */
export type UpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateProgressDto {
  /** 0–100 */
  readonly percent: number
  readonly transferred: number
  readonly total: number
  readonly bytesPerSecond: number
}

export interface UpdateStateDto {
  readonly phase: UpdatePhase
  /** 当前运行的版本 */
  readonly currentVersion: string
  /** 查到的新版本；没有就是 null */
  readonly availableVersion: string | null
  /** 这一版更新日志的正文（来自 CHANGELOG，发布时写进 Release） */
  readonly releaseNotes: string | null
  readonly progress: UpdateProgressDto | null
  /** 已翻译成中文的失败原因；原文只进日志 */
  readonly errorMessage: string | null
  /** 最近一次检查完成的时间（ISO） */
  readonly checkedAt: string | null
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

/**
 * 同步链路总览：一眼看清"哪边到哪边"。
 *
 * 三份数据分别是：Steam 来源 → 本机图库 → 远端备份。
 * 恢复是反方向：远端 → 图库，图库 → Steam。
 */
export interface SyncSummaryDto {
  /** 本机图库里有副本的资产数 */
  readonly localCount: number
  readonly localBytes: number
  /** 索引里的资产总数（含尚未归档的） */
  readonly indexedCount: number
  /** 远端已校验通过 */
  readonly verified: number
  /** 待备份（含未尝试与上传中） */
  readonly pending: number
  readonly failed: number
  /** 远端记录里能读到的资产数（来自本机记录表，不实时扫描远端） */
  readonly remoteCount: number
  readonly lastBackupAt: string | null
  readonly libraryRoot: string | null
  readonly remoteKind: RemoteKind | null
  readonly remoteBaseUrl: string | null
}

/** 一个备份地址（可以配多个：本机盘 / NAS 共享 / WebDAV）。 */
export interface RemoteTargetDto {
  readonly remoteId: string
  readonly kind: RemoteKind
  readonly baseUrl: string
  readonly libraryId: string
  readonly lastCheckAt: string | null
  readonly lastCheckStatus: string | null
  readonly connected: boolean
  readonly verified: number
  readonly pending: number
  readonly failed: number
}

/** 统一任务视图里的一项（扫描 / 归档 / 备份 / 恢复）。 */
export interface JobSummaryDto {
  readonly id: string
  readonly title: string
  readonly running: boolean
  readonly phase: string | null
  readonly processed: number
  readonly total: number | null
  readonly currentFile: string | null
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
}

/** 远端目录浏览器里的一项。 */
export interface RemoteEntryDto {
  readonly name: string
  readonly path: string
  readonly isDir: boolean
  readonly size: number | null
  readonly modifiedAt: string | null
}

export interface RemoteBrowseDto {
  /** 相对浏览根的当前路径；根为空串 */
  readonly path: string
  /** 上一级；已经是根时为 null */
  readonly parent: string | null
  /** 从根到当前的每一层，供面包屑 */
  readonly breadcrumbs: readonly { readonly name: string; readonly path: string }[]
  readonly entries: readonly RemoteEntryDto[]
}

/** 远端种类：WebDAV 服务，或一个普通文件夹（本机盘 / NAS 共享 / 已映射的网络盘）。 */
export type RemoteKind = 'webdav' | 'folder'

export interface RemoteConnectionDto {
  readonly remoteId: string
  readonly libraryId: string
  /** WebDAV 是 URL；文件夹远端是绝对路径 */
  readonly baseUrl: string
  readonly kind: RemoteKind
  readonly lastCheckStatus: string
  readonly capabilities: readonly CapabilityItemDto[]
}

export interface RemoteStateDto {
  readonly connected: boolean
  readonly kind: RemoteKind | null
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
  /** 本轮取不到、被跳过的备份地址 */
  readonly unavailableTargets?: readonly string[]
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

/** Steam Web API Key 状态（密钥本身不回传渲染层）。 */
export interface SteamKeyStatusDto {
  readonly configured: boolean
  readonly storageAvailable: boolean
  /** 本地已缓存的商店应用名称条数 */
  readonly cachedNames: number
}

/** 名称补全结果。 */
export interface CompleteNamesResultDto {
  readonly fetched: number
  readonly written: number
  readonly updated: number
  readonly pages: number
  readonly exhausted: boolean
  readonly error: string | null
}

export interface RenameGamePayload {
  readonly gameKey: string
  /** 空串表示清除别名，回到自动命名 */
  readonly name: string
}

export interface PreviewStatsDto {
  readonly count: number
  readonly bytes: number
  readonly pending: number
  readonly generated: number
}

/** 从图库目录重建索引的结果。 */
export interface ImportLibrarySummaryDto {
  readonly libraryRoot: string
  /** 扫到的说明文件数 */
  readonly scanned: number
  /** 新写入索引的资产数 */
  readonly imported: number
  /** 索引里已有、只补副本记录的资产数 */
  readonly skipped: number
  readonly failed: number
  readonly games: number
  readonly accounts: number
  readonly durationMs: number
  readonly failures: readonly string[]
}

export interface ImportLibraryProgressDto {
  readonly processed: number
  readonly total: number
  readonly currentFile: string | null
  readonly imported: number
  readonly failed: number
}

export interface ImportLibraryPayload {
  /** 不传就用设置里的图库目录 */
  readonly rootPath?: string
}
