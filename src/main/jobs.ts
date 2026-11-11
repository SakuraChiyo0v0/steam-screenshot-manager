/**
 * 统一任务视图。
 *
 * 之前扫描、归档、备份、恢复各自有一套状态机，界面上也各显示各的：
 * 想知道"现在还有没有活没干完"得去四个地方看，取消也分散在四个按钮上。
 *
 * 这里把它们收成一份只读快照（`JobSummaryDto`）与一个统一入口：
 * - `listJobs()`：四个任务的当前状态，顺序固定为 扫描 → 归档 → 备份 → 恢复；
 * - `cancelJob(id)`：按 id 转给对应的取消函数。
 *
 * 各任务自己的执行逻辑与数据库不变，这里只是"同一个窗框"。
 */

import { AppError } from '@shared/errors'
import type { JobSummaryDto } from '@shared/types'
import { cancelArchive, getArchiveStatus } from './archive-job'
import { cancelRestore, getRestoreStatus } from './restore-job'
import { cancelScan, getScanStatus } from './scan-job'
import { cancelSteamScreenshotRestore, getSteamScreenshotState } from './steam-screenshot-job'
import { cancelUpload, getUploadStatus } from './sync-job'

export type JobId = 'scan' | 'archive' | 'upload' | 'restore' | 'steamRestore'

interface JobLike {
  readonly running: boolean
  readonly processed: number
  readonly total: number | null
  readonly currentFile: string | null
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly phase?: string | null
}

const TITLES: Record<JobId, string> = {
  scan: '扫描来源',
  archive: '归档到图库',
  upload: '备份到远端',
  restore: '从远端恢复',
  steamRestore: '写回 Steam'
}

function toSummary(id: JobId, status: JobLike): JobSummaryDto {
  return {
    id,
    title: TITLES[id],
    running: status.running,
    phase: status.phase ?? null,
    processed: status.processed,
    total: status.total,
    currentFile: status.currentFile,
    startedAt: status.startedAt,
    finishedAt: status.finishedAt,
    errorCode: status.errorCode,
    errorMessage: status.errorMessage
  }
}

export function listJobs(): JobSummaryDto[] {
  return [
    toSummary('scan', getScanStatus() as unknown as JobLike),
    toSummary('archive', getArchiveStatus() as unknown as JobLike),
    toSummary('upload', getUploadStatus() as unknown as JobLike),
    toSummary('restore', getRestoreStatus() as unknown as JobLike),
    toSummary('steamRestore', steamJobLike())
  ]
}

/** 正在跑的任务；没有就是空数组。 */
export function runningJobs(): JobSummaryDto[] {
  return listJobs().filter((job) => job.running)
}

/** 写回 Steam 的状态结构与其它任务不同，这里转成同一形状。 */
function steamJobLike(): JobLike {
  const state = getSteamScreenshotState()
  return {
    running: state.running,
    processed: state.processed,
    total: state.total,
    currentFile: null,
    startedAt: null,
    finishedAt: null,
    errorCode: state.error ? 'APP_INTERNAL' : null,
    errorMessage: state.error ?? null,
    phase: null
  }
}

const CANCELLERS: Record<JobId, () => unknown> = {
  scan: cancelScan,
  archive: cancelArchive,
  upload: cancelUpload,
  restore: cancelRestore,
  steamRestore: cancelSteamScreenshotRestore
}

export function cancelJob(id: string): JobSummaryDto[] {
  const key = id as JobId
  const cancel = CANCELLERS[key]
  if (!cancel) {
    throw new AppError('IPC_INVALID_INPUT', `没有这个任务：${id}`)
  }
  cancel()
  return listJobs()
}
