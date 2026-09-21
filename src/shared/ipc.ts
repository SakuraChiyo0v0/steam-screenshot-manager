/**
 * IPC 通道与渲染层可见接口的唯一事实来源。
 *
 * 渲染层拿不到 ipcRenderer，只能调用 preload 通过 contextBridge 暴露的方法；
 * 方法清单与通道名都在这里定义，新增通道必须同时加入白名单与主进程的输入校验。
 */

import type { Err, Ok } from './errors'
import type {
  AccountSummaryDto,
  ArchiveStatusDto,
  ArchiveSummaryDto,
  ExportLayoutType,
  ExportStatusDto,
  ExportSummaryDto,
  LibraryCopyStateDto,
  RemoteConnectionDto,
  RemoteStateDto,
  UploadStatusDto,
  RemoteCatalogDto,
  PreviewStatsDto,
  SteamKeyStatusDto,
  CompleteNamesResultDto,
  RenameGamePayload,
  RestoreStatusDto,
  RestoreSummaryDto,
  UploadSummaryDto,
  AppInfo,
  AssetSortType,
  DbHealth,
  DiscoveredRootDto,
  GalleryAssetDto,
  GalleryGameDto,
  GalleryPageDto,
  LibraryRootState,
  LibraryStatsDto,
  RegisteredSourceDto,
  ScanProgressDto,
  ScanStatusDto,
  ScanSummaryDto,
  Settings
} from './types'

export const IPC_CHANNELS = {
  // 应用与设置（工程基础阶段）
  appGetInfo: 'app:getInfo',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  libraryPreviewStats: 'library:previewStats',
  libraryPickRoot: 'library:pickRoot',
  dbHealth: 'db:health',
  // 来源
  sourcesDiscover: 'sources:discover',
  sourcesList: 'sources:list',
  sourcesAdd: 'sources:add',
  sourcesRemove: 'sources:remove',
  // 扫描
  scanStart: 'scan:start',
  scanCancel: 'scan:cancel',
  scanStatus: 'scan:status',
  // 图库查询
  libraryStats: 'library:stats',
  libraryListGames: 'library:listGames',
  libraryListAccounts: 'library:listAccounts',
  libraryListAssets: 'library:listAssets',
  libraryGetAsset: 'library:getAsset',
  // 归档（本地收集）与导出
  archiveStart: 'archive:start',
  archiveCancel: 'archive:cancel',
  archiveStatus: 'archive:status',
  archiveReconcile: 'archive:reconcile',
  libraryCopyState: 'library:copyState',
  exportPickDir: 'export:pickDir',
  exportStart: 'export:start',
  exportCancel: 'export:cancel',
  exportStatus: 'export:status',
  // 远端备份（WebDAV）
  syncConnect: 'sync:connect',
  syncDisconnect: 'sync:disconnect',
  syncState: 'sync:state',
  uploadStart: 'upload:start',
  uploadCancel: 'upload:cancel',
  uploadStatus: 'upload:status',
  // 从远端恢复
  syncCatalog: 'sync:catalog',
  restoreStart: 'restore:start',
  restoreCancel: 'restore:cancel',
  restoreStatus: 'restore:status',
  // 游戏信息补全（Steam Web API 名称）
  steamKeyStatus: 'steam:keyStatus',
  steamSaveKey: 'steam:saveKey',
  steamCompleteNames: 'steam:completeNames',
  libraryRenameGame: 'library:renameGame'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

/** 主进程主动推送的通道（不参与 invoke 白名单）。 */
export const IPC_EVENTS = {
  scanProgress: 'scan:progress',
  archiveProgress: 'archive:progress',
  exportProgress: 'export:progress',
  uploadProgress: 'upload:progress',
  restoreProgress: 'restore:progress',
  previewReady: 'preview:ready'
} as const

/** 暴露给渲染层的方法名白名单（invoke 型）。 */
export const EXPOSED_METHODS = [
  'getAppInfo',
  'getSettings',
  'updateSettings',
  'getPreviewStats',
  'pickLibraryRoot',
  'runDbHealth',
  'discoverSources',
  'listSources',
  'addSource',
  'removeSource',
  'startScan',
  'cancelScan',
  'getScanStatus',
  'getLibraryStats',
  'listGames',
  'listAccounts',
  'listAssets',
  'getAsset',
  'startArchive',
  'cancelArchive',
  'getArchiveStatus',
  'reconcileLibrary',
  'getLibraryCopyState',
  'pickExportDir',
  'startExport',
  'cancelExport',
  'getExportStatus',
  'connectRemote',
  'disconnectRemote',
  'getRemoteState',
  'startUpload',
  'cancelUpload',
  'getUploadStatus',
  'scanRemoteCatalog',
  'startRestore',
  'cancelRestore',
  'getRestoreStatus',
  'getSteamKeyStatus',
  'saveSteamApiKey',
  'completeGameNames',
  'renameGame'
] as const

export type ExposedMethod = (typeof EXPOSED_METHODS)[number]

/** 事件型方法单独列出：它们不走 invoke，也不需要通道映射校验。 */
export const EVENT_METHODS = [
  'onScanProgress',
  'offScanProgress',
  'onArchiveProgress',
  'offArchiveProgress',
  'onExportProgress',
  'offExportProgress',
  'onUploadProgress',
  'offUploadProgress',
  'onRestoreProgress',
  'offRestoreProgress',
  'onPreviewReady',
  'offPreviewReady'
] as const

/** 方法名到通道的映射：preload 与主进程共用，避免两处清单漂移。 */
export const METHOD_TO_CHANNEL: Readonly<Record<ExposedMethod, IpcChannel>> = {
  getAppInfo: IPC_CHANNELS.appGetInfo,
  getSettings: IPC_CHANNELS.settingsGet,
  updateSettings: IPC_CHANNELS.settingsUpdate,
  getPreviewStats: IPC_CHANNELS.libraryPreviewStats,
  pickLibraryRoot: IPC_CHANNELS.libraryPickRoot,
  runDbHealth: IPC_CHANNELS.dbHealth,
  discoverSources: IPC_CHANNELS.sourcesDiscover,
  listSources: IPC_CHANNELS.sourcesList,
  addSource: IPC_CHANNELS.sourcesAdd,
  removeSource: IPC_CHANNELS.sourcesRemove,
  startScan: IPC_CHANNELS.scanStart,
  cancelScan: IPC_CHANNELS.scanCancel,
  getScanStatus: IPC_CHANNELS.scanStatus,
  getLibraryStats: IPC_CHANNELS.libraryStats,
  listGames: IPC_CHANNELS.libraryListGames,
  listAccounts: IPC_CHANNELS.libraryListAccounts,
  listAssets: IPC_CHANNELS.libraryListAssets,
  getAsset: IPC_CHANNELS.libraryGetAsset,
  startArchive: IPC_CHANNELS.archiveStart,
  cancelArchive: IPC_CHANNELS.archiveCancel,
  getArchiveStatus: IPC_CHANNELS.archiveStatus,
  reconcileLibrary: IPC_CHANNELS.archiveReconcile,
  getLibraryCopyState: IPC_CHANNELS.libraryCopyState,
  pickExportDir: IPC_CHANNELS.exportPickDir,
  startExport: IPC_CHANNELS.exportStart,
  cancelExport: IPC_CHANNELS.exportCancel,
  getExportStatus: IPC_CHANNELS.exportStatus,
  connectRemote: IPC_CHANNELS.syncConnect,
  disconnectRemote: IPC_CHANNELS.syncDisconnect,
  getRemoteState: IPC_CHANNELS.syncState,
  startUpload: IPC_CHANNELS.uploadStart,
  cancelUpload: IPC_CHANNELS.uploadCancel,
  getUploadStatus: IPC_CHANNELS.uploadStatus,
  scanRemoteCatalog: IPC_CHANNELS.syncCatalog,
  startRestore: IPC_CHANNELS.restoreStart,
  cancelRestore: IPC_CHANNELS.restoreCancel,
  getRestoreStatus: IPC_CHANNELS.restoreStatus,
  getSteamKeyStatus: IPC_CHANNELS.steamKeyStatus,
  saveSteamApiKey: IPC_CHANNELS.steamSaveKey,
  completeGameNames: IPC_CHANNELS.steamCompleteNames,
  renameGame: IPC_CHANNELS.libraryRenameGame
}

export type IpcResult<T> = Ok<T> | Err

export interface ScanStartPayload {
  readonly sourceId: string
  /** 为空表示扫描该来源下全部有截图的账号 */
  readonly accountIds?: readonly string[]
}

export interface ListGamesPayload {
  readonly query?: string | null
  readonly installed?: boolean | null
  readonly accountKey?: string | null
}

export interface ListAssetsPayload {
  readonly gameKey?: string | null
  readonly accountKey?: string | null
  readonly installed?: boolean | null
  readonly query?: string | null
  readonly sort?: AssetSortType
  readonly cursor?: string | null
  readonly limit?: number
}

export interface RemoveSourcePayload {
  readonly sourceId: string
}

export interface AssetIdPayload {
  readonly assetId: string
}

export interface ArchiveStartPayload {
  readonly gameKeys?: readonly string[]
  readonly assetIds?: readonly string[]
}

export interface ExportStartPayload {
  readonly targetDir: string
  readonly layout: ExportLayoutType
  readonly gameKeys?: readonly string[]
  readonly assetIds?: readonly string[]
}

export interface ReconcileResultDto {
  readonly checked: number
  readonly missing: number
  readonly stagingCleaned: number
}

export interface ExportDirStateDto {
  readonly targetDir: string | null
}

export interface ConnectRemotePayload {
  readonly baseUrl: string
  readonly username: string
  readonly password: string
  readonly libraryId?: string | null
}

export interface PreviewReadyPayload {
  readonly assetId: string
  readonly size: 'preview' | 'mini'
}

export interface RestoreStartPayload {
  /** 只恢复这些游戏；为空表示全部 */
  readonly gameKeys?: readonly string[]
}

export interface UploadStartPayload {
  /** 忽略退避窗口，立刻重试失败项 */
  readonly forceRetry?: boolean
}

/** 渲染层可用的接口，由 preload 注入到 window.api。 */
export interface RendererApi {
  getAppInfo(): Promise<IpcResult<AppInfo>>
  getSettings(): Promise<IpcResult<Settings>>
  updateSettings(patch: Partial<Settings>): Promise<IpcResult<Settings>>
  getPreviewStats(): Promise<IpcResult<PreviewStatsDto>>
  pickLibraryRoot(): Promise<IpcResult<LibraryRootState>>
  /** Steam Web API Key 是否已配置（密钥只存加密文件，不回传渲染层） */
  getSteamKeyStatus(): Promise<IpcResult<SteamKeyStatusDto>>
  /** 保存或清除（传空串）Steam Web API Key */
  saveSteamApiKey(apiKey: string): Promise<IpcResult<SteamKeyStatusDto>>
  /** 联网抓取商店应用目录并补全缺失的游戏名 */
  completeGameNames(): Promise<IpcResult<CompleteNamesResultDto>>
  /** 手动给游戏起别名（优先级最高，自动补全不会覆盖） */
  renameGame(payload: RenameGamePayload): Promise<IpcResult<GalleryGameDto[]>>
  runDbHealth(): Promise<IpcResult<DbHealth>>

  discoverSources(): Promise<IpcResult<DiscoveredRootDto[]>>
  listSources(): Promise<IpcResult<RegisteredSourceDto[]>>
  /** 打开目录选择并登记来源；取消时返回当前来源列表状态 */
  addSource(): Promise<IpcResult<RegisteredSourceDto[]>>
  removeSource(payload: RemoveSourcePayload): Promise<IpcResult<RegisteredSourceDto[]>>

  startScan(payload: ScanStartPayload): Promise<IpcResult<ScanSummaryDto>>
  cancelScan(): Promise<IpcResult<ScanStatusDto>>
  getScanStatus(): Promise<IpcResult<ScanStatusDto>>

  getLibraryStats(): Promise<IpcResult<LibraryStatsDto>>
  listGames(payload?: ListGamesPayload): Promise<IpcResult<GalleryGameDto[]>>
  listAccounts(): Promise<IpcResult<AccountSummaryDto[]>>
  listAssets(payload?: ListAssetsPayload): Promise<IpcResult<GalleryPageDto>>
  getAsset(payload: AssetIdPayload): Promise<IpcResult<GalleryAssetDto>>

  startArchive(payload?: ArchiveStartPayload): Promise<IpcResult<ArchiveSummaryDto>>
  cancelArchive(): Promise<IpcResult<ArchiveStatusDto>>
  getArchiveStatus(): Promise<IpcResult<ArchiveStatusDto>>
  reconcileLibrary(): Promise<IpcResult<ReconcileResultDto>>
  getLibraryCopyState(): Promise<IpcResult<LibraryCopyStateDto>>

  pickExportDir(): Promise<IpcResult<ExportDirStateDto>>
  startExport(payload: ExportStartPayload): Promise<IpcResult<ExportSummaryDto>>
  cancelExport(): Promise<IpcResult<ExportStatusDto>>
  getExportStatus(): Promise<IpcResult<ExportStatusDto>>

  connectRemote(payload: ConnectRemotePayload): Promise<IpcResult<RemoteConnectionDto>>
  disconnectRemote(): Promise<IpcResult<RemoteStateDto>>
  getRemoteState(): Promise<IpcResult<RemoteStateDto>>
  startUpload(payload?: UploadStartPayload): Promise<IpcResult<UploadSummaryDto>>
  cancelUpload(): Promise<IpcResult<UploadStatusDto>>
  getUploadStatus(): Promise<IpcResult<UploadStatusDto>>

  scanRemoteCatalog(): Promise<IpcResult<RemoteCatalogDto>>
  startRestore(payload?: RestoreStartPayload): Promise<IpcResult<RestoreSummaryDto>>
  cancelRestore(): Promise<IpcResult<RestoreStatusDto>>
  getRestoreStatus(): Promise<IpcResult<RestoreStatusDto>>

  /** 订阅进度事件；同一时刻只保留一个监听器 */
  onScanProgress(listener: (progress: ScanProgressDto) => void): void
  offScanProgress(): void
  onArchiveProgress(listener: (status: ArchiveStatusDto) => void): void
  offArchiveProgress(): void
  onExportProgress(listener: (status: ExportStatusDto) => void): void
  offExportProgress(): void
  onUploadProgress(listener: (status: UploadStatusDto) => void): void
  offUploadProgress(): void
  onRestoreProgress(listener: (status: RestoreStatusDto) => void): void
  offRestoreProgress(): void
  /** 某张图的预览已生成，界面可以换成更清晰也更轻的预览 */
  onPreviewReady(listener: (payload: PreviewReadyPayload) => void): void
  offPreviewReady(): void
}
