/**
 * 远端恢复任务编排（主进程）。
 *
 * 读远端清单与执行恢复都走真实 WebDAV；同一时刻只允许一个恢复任务。
 * 清单缓存在内存中，界面选完游戏后再执行，避免每次点击都重新遍历远端。
 */

import { BrowserWindow } from 'electron'
import { AppError } from '@shared/errors'
import { IPC_EVENTS } from '@shared/ipc'
import type {
  RemoteCatalogDto,
  RestoreGamePlanDto,
  RestoreStatusDto,
  RestoreSummaryDto
} from '@shared/types'
import { readSettings } from '@core/settings/settings-store'
import { loadCredential } from '@core/sync/credentials'
import { listRemoteRecords, planRestoreGames, restoreAssets } from '@core/sync/restore'
import type { RemoteRecordEntry } from '@core/sync/restore'
import { DavClient } from '@core/sync/webdav'
import { getAppContext } from './app-context'

let restoreJob: { cancelRequested: boolean } | null = null
let restoreStatus: RestoreStatusDto = idleRestoreStatus()
let cachedRecords: RemoteRecordEntry[] = []
let cachedLibraryId: string | null = null

function idleRestoreStatus(): RestoreStatusDto {
  return {
    running: false,
    phase: null,
    processed: 0,
    total: null,
    restored: 0,
    skipped: 0,
    failed: 0,
    currentFile: null,
    startedAt: null,
    finishedAt: null,
    errorCode: null,
    errorMessage: null
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload)
    }
  }
}

interface RemoteContext {
  client: DavClient
  libraryId: string
  libraryRoot: string
}

function buildRemoteContext(): RemoteContext {
  const { database, paths } = getAppContext()
  const settings = readSettings(database.db)
  if (!settings.libraryRoot) {
    throw new AppError('LIB_PATH_INVALID', '尚未选择图库目录，恢复需要先确定本地图库位置')
  }

  const row = database.db
    .prepare(
      `SELECT remote_id AS remoteId, library_id AS libraryId, base_url AS baseUrl, root_path AS rootPath,
              credential_ref AS credentialRef
         FROM remotes ORDER BY created_at LIMIT 1`
    )
    .get() as
    | { remoteId: string; libraryId: string; baseUrl: string; rootPath: string; credentialRef: string }
    | undefined

  if (!row || row.credentialRef.length === 0) {
    throw new AppError('IPC_INVALID_INPUT', '尚未连接远端存储')
  }
  const credential = loadCredential(paths.dataDir, row.credentialRef)
  if (!credential) {
    throw new AppError('DAV_AUTH', '本机没有可用凭据，请重新连接远端存储')
  }

  return {
    client: new DavClient({ baseUrl: row.baseUrl, rootPath: row.rootPath, credential }),
    libraryId: row.libraryId,
    libraryRoot: settings.libraryRoot
  }
}

export function getRestoreStatus(): RestoreStatusDto {
  return restoreStatus
}

export function cancelRestore(): RestoreStatusDto {
  if (restoreJob) {
    restoreJob.cancelRequested = true
  }
  return restoreStatus
}

export function getCachedCatalog(): RemoteCatalogDto | null {
  if (!cachedLibraryId) {
    return null
  }
  const { database } = getAppContext()
  const settings = readSettings(database.db)
  return {
    libraryId: cachedLibraryId,
    records: cachedRecords.length,
    games: settings.libraryRoot
      ? planRestoreGames(database.db, cachedRecords, settings.libraryRoot)
      : []
  }
}

/** 读取远端记录清单并汇总成按游戏的恢复计划。 */
export async function scanRemoteCatalog(): Promise<RemoteCatalogDto> {
  const { database } = getAppContext()
  const context = buildRemoteContext()

  restoreStatus = {
    ...idleRestoreStatus(),
    running: true,
    phase: 'scanning',
    startedAt: new Date().toISOString()
  }
  broadcast(IPC_EVENTS.restoreProgress, restoreStatus)

  try {
    const result = await listRemoteRecords(context.client, context.libraryId, {
      onProgress: (scanned, valid) => {
        restoreStatus = {
          ...restoreStatus,
          processed: scanned,
          total: null,
          restored: valid
        }
        broadcast(IPC_EVENTS.restoreProgress, restoreStatus)
      }
    })

    cachedRecords = result.records
    cachedLibraryId = context.libraryId

    restoreStatus = {
      ...idleRestoreStatus(),
      processed: result.records.length,
      total: result.records.length,
      finishedAt: new Date().toISOString()
    }
    broadcast(IPC_EVENTS.restoreProgress, restoreStatus)

    const games: RestoreGamePlanDto[] = planRestoreGames(
      database.db,
      result.records,
      context.libraryRoot
    )
    return {
      libraryId: context.libraryId,
      records: result.records.length,
      invalidRecords: result.invalidRecords,
      games,
      errors: result.errors
    }
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'APP_INTERNAL'
    restoreStatus = {
      ...restoreStatus,
      running: false,
      finishedAt: new Date().toISOString(),
      errorCode: code,
      errorMessage: error instanceof Error ? error.message : String(error)
    }
    broadcast(IPC_EVENTS.restoreProgress, restoreStatus)
    throw error
  }
}

export async function runRestore(input: { gameKeys?: readonly string[] }): Promise<RestoreSummaryDto> {
  if (restoreJob) {
    throw new AppError('JOB_RUNNING', '已有恢复任务在执行')
  }
  if (cachedRecords.length === 0 || !cachedLibraryId) {
    throw new AppError('IPC_INVALID_INPUT', '请先读取远端清单')
  }

  const { database } = getAppContext()
  const context = buildRemoteContext()
  const remoteRow = database.db
    .prepare('SELECT remote_id AS remoteId FROM remotes ORDER BY created_at LIMIT 1')
    .get() as { remoteId: string } | undefined
  const startedAt = new Date().toISOString()
  const job = { cancelRequested: false }
  restoreJob = job

  restoreStatus = {
    ...idleRestoreStatus(),
    running: true,
    phase: 'restoring',
    total: cachedRecords.length,
    startedAt
  }
  broadcast(IPC_EVENTS.restoreProgress, restoreStatus)

  try {
    const result = await restoreAssets(database.db, {
      libraryRoot: context.libraryRoot,
      remoteId: remoteRow?.remoteId,
      libraryId: context.libraryId,
      client: context.client,
      records: cachedRecords,
      gameKeys: input.gameKeys,
      onProgress: (progress) => {
        restoreStatus = {
          running: true,
          phase: 'restoring',
          processed: progress.processed,
          total: progress.total,
          restored: progress.restored,
          skipped: progress.skipped,
          failed: progress.failed,
          currentFile: progress.currentFile,
          startedAt,
          finishedAt: null,
          errorCode: null,
          errorMessage: null
        }
        broadcast(IPC_EVENTS.restoreProgress, restoreStatus)
      },
      shouldCancel: () => job.cancelRequested
    })

    restoreStatus = {
      ...restoreStatus,
      running: false,
      processed: result.restored + result.skipped + result.failed,
      finishedAt: new Date().toISOString(),
      restored: result.restored,
      skipped: result.skipped,
      failed: result.failed,
      errorCode: result.abortedByAuth ? 'DAV_AUTH' : null,
      errorMessage: result.abortedByAuth ? '远端拒绝认证，恢复已停止' : null
    }
    broadcast(IPC_EVENTS.restoreProgress, restoreStatus)

    return {
      total: result.total,
      restored: result.restored,
      skipped: result.skipped,
      failed: result.failed,
      cancelled: result.cancelled,
      abortedByAuth: result.abortedByAuth,
      durationMs: result.durationMs,
      failures: result.failures
    }
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'APP_INTERNAL'
    const message = error instanceof Error ? error.message : String(error)
    restoreStatus = {
      ...restoreStatus,
      running: false,
      finishedAt: new Date().toISOString(),
      errorCode: code,
      errorMessage: message
    }
    broadcast(IPC_EVENTS.restoreProgress, restoreStatus)
    throw error
  } finally {
    restoreJob = null
  }
}
