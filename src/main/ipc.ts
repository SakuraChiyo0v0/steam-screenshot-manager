/**
 * IPC 处理器注册。
 *
 * 每个通道都在这里做输入运行时校验，并返回统一的 { ok, data } / { ok, code, message } 结构。
 * 渲染层没有通用文件读写或命令执行通道，所有能力都必须显式列在这里。
 * 图库查询的结果不含任何文件系统路径，图片一律走 `ssm-asset` 协议。
 */

import { randomUUID } from 'node:crypto'
import { app, dialog, ipcMain } from 'electron'
import { AppError, ok, toErr } from '@shared/errors'
import { IPC_CHANNELS } from '@shared/ipc'
import type {
  AccountSummaryDto,
  AppInfo,
  DbHealth,
  DiscoveredRootDto,
  GalleryAssetDto,
  GalleryGameDto,
  GalleryPageDto,
  LibraryRootState,
  LibraryStatsDto,
  RegisteredSourceDto,
  ScanStatusDto,
  ScanSummaryDto,
  Settings
} from '@shared/types'
import { checkLibraryRoot } from '@core/settings/library-root'
import { isSettingsPatch, readSettings, writeSettings } from '@core/settings/settings-store'
import { discoverSteamRoots, inspectRoot, validateManualRoot } from '@core/steam/discovery'
import { accountKeyFor } from '@core/steam/scanner'
import {
  deleteSource,
  insertSource,
  listSources,
  type SourceRow
} from '@core/library/index-writer'
import {
  getAsset,
  libraryStats,
  listAccounts,
  listAssets,
  listGames,
} from '@core/library/queries'
import type { AssetSummary } from '@core/library/queries'
import { assetUrl, thumbnailUrl } from './asset-protocol'
import { getAppContext } from './app-context'
import {
  parseAssetId,
  parseListAssets,
  parseListGames,
  parseRemoveSource,
  parseScanStart
} from './payloads'
import { resolveProtectedRoots } from './paths'
import { cancelScan, getScanStatus, startScan } from './scan-job'

function handle(channel: string, handler: (payload: unknown) => unknown): void {
  ipcMain.handle(channel, async (_event, payload: unknown) => {
    try {
      return ok(await handler(payload))
    } catch (error) {
      return toErr(error)
    }
  })
}

function toRegisteredSource(row: SourceRow): RegisteredSourceDto {
  const inspection = inspectRoot(row.rootPath, 'manual')
  return {
    sourceId: row.sourceId,
    rootPath: row.rootPath,
    kind: row.kind,
    accountKeys: inspection.accounts.map((account) => accountKeyFor(account.accountId)),
    lastScanAt: row.lastScanAt,
    lastScanStatus: row.lastScanStatus
  }
}

function currentSources(): RegisteredSourceDto[] {
  const { database } = getAppContext()
  return listSources(database.db).map(toRegisteredSource)
}

function readLibraryRootState(): LibraryRootState {
  const { database } = getAppContext()
  const settings = readSettings(database.db)
  return { root: settings.libraryRoot, selectedAt: null }
}

function toGalleryGame(row: {
  gameKey: string
  name: string
  kind: string
  installed: boolean
  assetCount: number
  bytes: number
  latestCapturedAt: string | null
  coverAssetId: string | null
  accounts: readonly string[]
}): GalleryGameDto {
  return {
    gameKey: row.gameKey,
    name: row.name,
    appKeyLabel: row.gameKey,
    kind: row.kind,
    installed: row.installed,
    assetCount: row.assetCount,
    bytes: row.bytes,
    latestCapturedAt: row.latestCapturedAt,
    coverUrl: row.coverAssetId ? assetUrl(row.coverAssetId) : null,
    accounts: row.accounts
  }
}

function toGalleryAsset(detail: AssetSummary): GalleryAssetDto {
  return {
    assetId: detail.assetId,
    gameKey: detail.gameKey,
    gameName: detail.gameName,
    accountKey: detail.accountKey,
    fileName: detail.fileName,
    bytes: detail.bytes,
    width: detail.width,
    height: detail.height,
    capturedAt: detail.capturedAt,
    captureTimeSource: detail.captureTimeSource as GalleryAssetDto['captureTimeSource'],
    available: detail.available,
    imageUrl: assetUrl(detail.assetId),
    thumbnailUrl: thumbnailUrl(detail.assetId)
  }
}

export function registerIpcHandlers(): void {
  /* ---------------- 应用与设置（工程基础阶段 既有） ---------------- */

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

  /* ---------------- 来源发现与登记 ---------------- */

  handle(IPC_CHANNELS.sourcesDiscover, (): DiscoveredRootDto[] => {
    const { database } = getAppContext()
    const registered = listSources(database.db)
    const manualRoots = registered.filter((row) => row.kind === 'manual').map((row) => row.rootPath)

    const byRoot = new Map(registered.map((row) => [row.rootPath.toLowerCase(), row.sourceId]))

    return discoverSteamRoots(manualRoots).map((root) => ({
      rootPath: root.rootPath,
      kind: root.kind,
      exists: root.exists,
      readable: root.readable,
      registeredSourceId: byRoot.get(root.rootPath.toLowerCase()) ?? null,
      accounts: root.accounts.map((account) => ({
        accountId: account.accountId,
        steamId64: account.steamId64,
        accountName: account.accountName,
        personaName: account.personaName,
        hasScreenshotDir: account.hasScreenshotDir,
        gameDirectoryCount: account.gameDirectoryCount
      }))
    }))
  })

  handle(IPC_CHANNELS.sourcesList, (): RegisteredSourceDto[] => currentSources())

  handle(IPC_CHANNELS.sourcesAdd, async (): Promise<RegisteredSourceDto[]> => {
    const { database } = getAppContext()
    const picked = await dialog.showOpenDialog({
      title: '选择 Steam 数据根目录',
      properties: ['openDirectory']
    })

    if (picked.canceled || picked.filePaths.length === 0) {
      return currentSources()
    }

    const rootPath = validateManualRoot(picked.filePaths[0])
    const existing = listSources(database.db).find(
      (row) => row.rootPath.toLowerCase() === rootPath.toLowerCase()
    )
    if (!existing) {
      insertSource(database.db, {
        sourceId: randomUUID(),
        rootPath,
        kind: 'manual',
        createdAt: new Date().toISOString()
      })
    }

    return currentSources()
  })

  handle(IPC_CHANNELS.sourcesRemove, (payload): RegisteredSourceDto[] => {
    const { sourceId } = parseRemoveSource(payload)
    const { database } = getAppContext()
    deleteSource(database.db, sourceId)
    return currentSources()
  })

  /* ---------------- 扫描 ---------------- */

  handle(IPC_CHANNELS.scanStart, async (payload): Promise<ScanSummaryDto> => {
    const parsed = parseScanStart(payload)
    return startScan({ sourceId: parsed.sourceId, accountIds: parsed.accountIds })
  })

  handle(IPC_CHANNELS.scanCancel, (): ScanStatusDto => cancelScan())

  handle(IPC_CHANNELS.scanStatus, (): ScanStatusDto => getScanStatus())

  /* ---------------- 图库查询 ---------------- */

  handle(IPC_CHANNELS.libraryStats, (): LibraryStatsDto => {
    const { database } = getAppContext()
    return libraryStats(database.db)
  })

  handle(IPC_CHANNELS.libraryListGames, (payload): GalleryGameDto[] => {
    const { database } = getAppContext()
    const options = parseListGames(payload)
    return listGames(database.db, options).map(toGalleryGame)
  })

  handle(IPC_CHANNELS.libraryListAccounts, (): AccountSummaryDto[] => {
    const { database } = getAppContext()
    return listAccounts(database.db)
  })

  handle(IPC_CHANNELS.libraryListAssets, (payload): GalleryPageDto => {
    const { database } = getAppContext()
    const options = parseListAssets(payload)
    const page = listAssets(database.db, options)
    return { items: page.items.map(toGalleryAsset), nextCursor: page.nextCursor }
  })

  handle(IPC_CHANNELS.libraryGetAsset, (payload): GalleryAssetDto => {
    const { assetId } = parseAssetId(payload)
    const { database } = getAppContext()
    const detail = getAsset(database.db, assetId)
    if (!detail) {
      throw new AppError('IPC_INVALID_INPUT', '资产不存在')
    }
    return toGalleryAsset(detail)
  })
}
