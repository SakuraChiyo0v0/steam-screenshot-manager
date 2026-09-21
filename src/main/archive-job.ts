/**
 * 归档与导出任务编排（主进程）。
 *
 * 与扫描任务一样：同一时刻只允许一个同类任务，进度通过事件推送，取消是协作式的，
 * 已完成的成果在取消后保留，重跑继续。
 */

import { BrowserWindow } from 'electron'
import { AppError } from '@shared/errors'
import { IPC_EVENTS } from '@shared/ipc'
import type {
  ArchiveStatusDto,
  ArchiveSummaryDto,
  ExportLayoutType,
  ExportStatusDto,
  ExportSummaryDto,
  LibraryCopyStateDto
} from '@shared/types'
import { archiveAssets, localCopyState, reconcileLibrary } from '@core/library/archive'
import { exportAssets } from '@core/library/export'
import { checkLibraryRoot } from '@core/settings/library-root'
import { readSettings } from '@core/settings/settings-store'
import { listSources } from '@core/library/index-writer'
import { getAppContext } from './app-context'
import { resolveProtectedRoots } from './paths'

interface RunningJob {
  cancelRequested: boolean
}

let archiveJob: RunningJob | null = null
let exportJob: RunningJob | null = null
let archiveStatus: ArchiveStatusDto = idleArchiveStatus()
let exportStatus: ExportStatusDto = idleExportStatus()

function idleArchiveStatus(): ArchiveStatusDto {
  return {
    running: false,
    phase: null,
    processed: 0,
    total: null,
    currentFile: null,
    copied: 0,
    skipped: 0,
    failed: 0,
    startedAt: null,
    finishedAt: null,
    errorCode: null,
    errorMessage: null
  }
}

function idleExportStatus(): ExportStatusDto {
  return {
    running: false,
    processed: 0,
    total: null,
    currentFile: null,
    written: 0,
    skipped: 0,
    failed: 0,
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

/** 读取并校验图库根目录：必须已选择，且不与来源目录重叠。 */
export function requireLibraryRoot(): string {
  const { database, paths } = getAppContext()
  const settings = readSettings(database.db)
  if (!settings.libraryRoot) {
    throw new AppError('LIB_PATH_INVALID', '尚未选择图库目录，请先在设置里选择')
  }

  const sourceRoots = listSources(database.db).map((row) => row.rootPath)
  const check = checkLibraryRoot({
    candidate: settings.libraryRoot,
    protectedRoots: resolveProtectedRoots(paths),
    sourceRoots
  })
  if (!check.ok) {
    throw new AppError('LIB_PATH_INVALID', check.reason)
  }
  return check.normalized
}

export function getArchiveStatus(): ArchiveStatusDto {
  return archiveStatus
}

export function getExportStatus(): ExportStatusDto {
  return exportStatus
}

export function getLibraryCopyState(): LibraryCopyStateDto {
  const { database } = getAppContext()
  const settings = readSettings(database.db)
  const assets = Number(
    (database.db.prepare('SELECT COUNT(*) AS total FROM assets').get() as { total: number }).total
  )
  if (!settings.libraryRoot) {
    return { libraryRoot: null, archived: 0, missing: 0, assets }
  }
  const state = localCopyState(database.db, settings.libraryRoot)
  return { libraryRoot: settings.libraryRoot, archived: state.archived, missing: state.missing, assets }
}

export function reconcileNow(): {
  checked: number
  missing: number
  stagingCleaned: number
} {
  const { database } = getAppContext()
  const settings = readSettings(database.db)
  if (!settings.libraryRoot) {
    return { checked: 0, missing: 0, stagingCleaned: 0 }
  }
  return reconcileLibrary(database.db, settings.libraryRoot)
}

export function cancelArchive(): ArchiveStatusDto {
  if (archiveJob) {
    archiveJob.cancelRequested = true
  }
  return archiveStatus
}

export function cancelExport(): ExportStatusDto {
  if (exportJob) {
    exportJob.cancelRequested = true
  }
  return exportStatus
}

export async function runArchive(input: {
  gameKeys?: readonly string[]
  assetIds?: readonly string[]
}): Promise<ArchiveSummaryDto> {
  if (archiveJob) {
    throw new AppError('JOB_RUNNING', '已有归档任务在执行')
  }

  const libraryRoot = requireLibraryRoot()
  const { database } = getAppContext()
  const startedAt = new Date().toISOString()
  const job: RunningJob = { cancelRequested: false }
  archiveJob = job

  archiveStatus = {
    running: true,
    phase: 'planning',
    processed: 0,
    total: null,
    currentFile: null,
    copied: 0,
    skipped: 0,
    failed: 0,
    startedAt,
    finishedAt: null,
    errorCode: null,
    errorMessage: null
  }
  broadcast(IPC_EVENTS.archiveProgress, archiveStatus)

  try {
    const result = await archiveAssets(database.db, {
      libraryRoot,
      gameKeys: input.gameKeys,
      assetIds: input.assetIds,
      onProgress: (progress) => {
        archiveStatus = {
          running: true,
          phase: progress.phase === 'verifying' ? 'copying' : progress.phase,
          processed: progress.processed,
          total: progress.total,
          currentFile: progress.currentFile,
          copied: progress.copied,
          skipped: progress.skipped,
          failed: progress.failed,
          startedAt,
          finishedAt: null,
          errorCode: null,
          errorMessage: null
        }
        broadcast(IPC_EVENTS.archiveProgress, archiveStatus)
      },
      shouldCancel: () => job.cancelRequested
    })

    archiveStatus = {
      ...archiveStatus,
      running: false,
      finishedAt: new Date().toISOString(),
      total: result.total,
      processed: result.copied + result.skipped + result.failed,
      copied: result.copied,
      skipped: result.skipped,
      failed: result.failed
    }
    broadcast(IPC_EVENTS.archiveProgress, archiveStatus)

    return {
      total: result.total,
      copied: result.copied,
      skipped: result.skipped,
      failed: result.failed,
      cancelled: result.cancelled,
      durationMs: result.durationMs,
      libraryRoot
    }
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'APP_INTERNAL'
    const message = error instanceof Error ? error.message : String(error)
    archiveStatus = {
      ...archiveStatus,
      running: false,
      finishedAt: new Date().toISOString(),
      errorCode: code,
      errorMessage: message
    }
    broadcast(IPC_EVENTS.archiveProgress, archiveStatus)
    throw error
  } finally {
    archiveJob = null
  }
}

export async function runExport(input: {
  targetDir: string
  layout: ExportLayoutType
  gameKeys?: readonly string[]
  assetIds?: readonly string[]
}): Promise<ExportSummaryDto> {
  if (exportJob) {
    throw new AppError('JOB_RUNNING', '已有导出任务在执行')
  }

  const { database } = getAppContext()
  const settings = readSettings(database.db)
  const startedAt = new Date().toISOString()
  const job: RunningJob = { cancelRequested: false }
  exportJob = job

  exportStatus = {
    running: true,
    processed: 0,
    total: null,
    currentFile: null,
    written: 0,
    skipped: 0,
    failed: 0,
    startedAt,
    finishedAt: null,
    errorCode: null,
    errorMessage: null
  }
  broadcast(IPC_EVENTS.exportProgress, exportStatus)

  try {
    const result = await exportAssets(database.db, {
      targetDir: input.targetDir,
      layout: input.layout,
      libraryRoot: settings.libraryRoot,
      gameKeys: input.gameKeys,
      assetIds: input.assetIds,
      onProgress: (progress) => {
        exportStatus = {
          running: true,
          processed: progress.processed,
          total: progress.total,
          currentFile: progress.currentFile,
          written: progress.written,
          skipped: progress.skipped,
          failed: progress.failed,
          startedAt,
          finishedAt: null,
          errorCode: null,
          errorMessage: null
        }
        broadcast(IPC_EVENTS.exportProgress, exportStatus)
      },
      shouldCancel: () => job.cancelRequested
    })

    exportStatus = {
      ...exportStatus,
      running: false,
      finishedAt: new Date().toISOString(),
      total: result.total,
      processed: result.written + result.skipped + result.failed,
      written: result.written,
      skipped: result.skipped,
      failed: result.failed
    }
    broadcast(IPC_EVENTS.exportProgress, exportStatus)

    return {
      total: result.total,
      written: result.written,
      skipped: result.skipped,
      failed: result.failed,
      conflictsRenamed: result.conflictsRenamed,
      cancelled: result.cancelled,
      durationMs: result.durationMs,
      targetDir: result.targetDir
    }
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'APP_INTERNAL'
    const message = error instanceof Error ? error.message : String(error)
    exportStatus = {
      ...exportStatus,
      running: false,
      finishedAt: new Date().toISOString(),
      errorCode: code,
      errorMessage: message
    }
    broadcast(IPC_EVENTS.exportProgress, exportStatus)
    throw error
  } finally {
    exportJob = null
  }
}
