/**
 * 扫描任务编排。
 *
 * 同一时刻只允许一个扫描任务；进度通过事件推送给渲染层（渲染层不轮询）。
 * 扫描失败或取消都不删除已入库的数据；来源不可达时不更新文件存在状态。
 */

import { BrowserWindow } from 'electron'
import { AppError } from '@shared/errors'
import { IPC_EVENTS } from '@shared/ipc'
import type { ScanStatusDto, ScanSummaryDto } from '@shared/types'
import { inspectRoot } from '@core/steam/discovery'
import { scanSource } from '@core/steam/scanner'
import { loadKnownHashes, markSourceScan, writeScanOutcome } from '@core/library/index-writer'
import { listSources } from '@core/library/index-writer'
import { getAppContext } from './app-context'

interface RunningScan {
  readonly sourceId: string
  readonly startedAt: string
  cancelRequested: boolean
  status: ScanStatusDto
}

let running: RunningScan | null = null

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload)
    }
  }
}

function publish(status: ScanStatusDto): void {
  running = running ? { ...running, status } : null
  broadcast(IPC_EVENTS.scanProgress, status)
}

export function getScanStatus(): ScanStatusDto {
  if (running) {
    return running.status
  }
  return {
    running: false,
    sourceId: null,
    phase: null,
    processed: 0,
    total: null,
    currentFile: null,
    failed: 0,
    startedAt: null,
    finishedAt: null,
    cancelled: false,
    errorCode: null,
    errorMessage: null
  }
}

export function cancelScan(): ScanStatusDto {
  if (!running) {
    return getScanStatus()
  }
  running.cancelRequested = true
  const status: ScanStatusDto = { ...running.status, phase: running.status.phase }
  running.status = status
  return status
}

export async function startScan(input: {
  sourceId: string
  accountIds: readonly string[]
}): Promise<ScanSummaryDto> {
  if (running) {
    throw new AppError('JOB_RUNNING', '已有扫描任务在执行')
  }

  const { database } = getAppContext()
  const source = listSources(database.db).find((item) => item.sourceId === input.sourceId)
  if (!source) {
    throw new AppError('SRC_NOT_FOUND', '来源不存在')
  }

  const inspection = inspectRoot(source.rootPath, 'manual')
  if (!inspection.exists) {
    markSourceScan(database.db, {
      sourceId: source.sourceId,
      status: 'failed',
      error: '来源目录不存在或不可达',
      at: new Date().toISOString()
    })
    throw new AppError('SRC_NOT_FOUND', '来源目录不存在或不可达')
  }

  const startedAt = new Date().toISOString()
  const startedMs = Date.now()

  running = {
    sourceId: source.sourceId,
    startedAt,
    cancelRequested: false,
    status: {
      running: true,
      sourceId: source.sourceId,
      phase: 'enumerating',
      processed: 0,
      total: null,
      currentFile: null,
      failed: 0,
      startedAt,
      finishedAt: null,
      cancelled: false,
      errorCode: null,
      errorMessage: null
    }
  }
  broadcast(IPC_EVENTS.scanProgress, running.status)

  try {
    const knownHashes = loadKnownHashes(database.db, source.sourceId)

    const outcome = await scanSource({
      rootPath: source.rootPath,
      sourceId: source.sourceId,
      accountIds: input.accountIds,
      knownHashes,
      onProgress: (progress) => {
        if (!running) {
          return
        }
        const status: ScanStatusDto = {
          running: true,
          sourceId: source.sourceId,
          phase: progress.phase,
          processed: progress.processed,
          total: progress.total,
          currentFile: progress.currentFile,
          failed: progress.failed,
          startedAt,
          finishedAt: null,
          cancelled: running.cancelRequested,
          errorCode: null,
          errorMessage: null
        }
        publish(status)
      },
      shouldCancel: () => running?.cancelRequested === true
    })

    const seenAt = new Date().toISOString()
    const written = writeScanOutcome(database.db, {
      sourceId: source.sourceId,
      outcome,
      seenAt
    })

    const status = outcome.failures.length > 0 ? 'partial' : outcome.cancelled ? 'cancelled' : 'ok'
    markSourceScan(database.db, {
      sourceId: source.sourceId,
      status,
      error: outcome.failures.length > 0 ? `${outcome.failures.length} 个文件读取失败` : null,
      at: seenAt
    })

    const summary: ScanSummaryDto = {
      sourceId: source.sourceId,
      scannedAccounts: outcome.scannedAccounts,
      createdAssets: written.assets,
      sourceFiles: written.sourceFiles,
      failures: outcome.failures.length,
      missingMarked: written.missingMarked,
      cancelled: outcome.cancelled,
      durationMs: Date.now() - startedMs
    }

    const finalStatus: ScanStatusDto = {
      running: false,
      sourceId: source.sourceId,
      phase: null,
      processed: summary.sourceFiles,
      total: summary.sourceFiles,
      currentFile: null,
      failed: summary.failures,
      startedAt,
      finishedAt: seenAt,
      cancelled: summary.cancelled,
      errorCode: null,
      errorMessage: null
    }
    running = null
    broadcast(IPC_EVENTS.scanProgress, finalStatus)

    return summary
  } catch (error) {
    const finishedAt = new Date().toISOString()
    const code = error instanceof AppError ? error.code : 'APP_INTERNAL'
    const message = error instanceof Error ? error.message : String(error)

    markSourceScan(database.db, {
      sourceId: source.sourceId,
      status: 'failed',
      error: message,
      at: finishedAt
    })

    const failedStatus: ScanStatusDto = {
      running: false,
      sourceId: source.sourceId,
      phase: null,
      processed: 0,
      total: null,
      currentFile: null,
      failed: 0,
      startedAt,
      finishedAt,
      cancelled: false,
      errorCode: code,
      errorMessage: message
    }
    running = null
    broadcast(IPC_EVENTS.scanProgress, failedStatus)
    throw error
  }
}
