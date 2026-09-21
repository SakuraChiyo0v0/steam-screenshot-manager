/**
 * 远端备份任务编排（主进程）。
 *
 * 与扫描/归档一样：同类任务单实例、进度事件推送、取消是协作式的。
 * 连接配置只把非敏感信息写数据库，密码进 safeStorage。
 */

import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { AppError } from '@shared/errors'
import { IPC_EVENTS } from '@shared/ipc'
import type {
  RemoteConnectionDto,
  RemoteStateDto,
  UploadStatusDto,
  UploadSummaryDto
} from '@shared/types'
import { readSettings } from '@core/settings/settings-store'
import {
  deleteCredential,
  isCredentialStorageAvailable,
  loadCredential,
  saveCredential
} from '@core/sync/credentials'
import {
  buildLibraryDescriptor,
  libraryDescriptorPath,
  libraryRootPath,
  validateLibraryDescriptor
} from '@core/sync/library-remote'
import { DavClient, probeCapabilities, splitDavUrl, type CapabilityItem } from '@core/sync/webdav'
import { planUpload, remoteStatusCounts, uploadAssets } from '@core/sync/upload'
import { getAppContext } from './app-context'

let uploadJob: { cancelRequested: boolean } | null = null
let uploadStatus: UploadStatusDto = idleUploadStatus()

function idleUploadStatus(): UploadStatusDto {
  return {
    running: false,
    processed: 0,
    total: null,
    currentFile: null,
    verified: 0,
    uploaded: 0,
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

interface RemoteRow {
  remoteId: string
  libraryId: string
  baseUrl: string
  rootPath: string
  credentialRef: string
  formatVersion: number
  lastCheckAt: string | null
  lastCheckStatus: string | null
}

function readRemoteRow(): RemoteRow | null {
  const { database } = getAppContext()
  const row = database.db
    .prepare(
      `SELECT remote_id AS remoteId, library_id AS libraryId, base_url AS baseUrl, root_path AS rootPath,
              credential_ref AS credentialRef, format_version AS formatVersion,
              last_check_at AS lastCheckAt, last_check_status AS lastCheckStatus
         FROM remotes ORDER BY created_at LIMIT 1`
    )
    .get() as RemoteRow | undefined
  return row ?? null
}

function requireRemote(): RemoteRow {
  const row = readRemoteRow()
  if (!row || row.credentialRef.length === 0) {
    throw new AppError('IPC_INVALID_INPUT', '尚未连接远端存储')
  }
  return row
}

function buildClient(row: RemoteRow): DavClient {
  const { paths } = getAppContext()
  const credential = loadCredential(paths.dataDir, row.credentialRef)
  if (!credential) {
    throw new AppError('DAV_AUTH', '本机没有可用凭据，请重新连接远端存储')
  }
  return new DavClient({
    baseUrl: row.baseUrl,
    rootPath: row.rootPath,
    credential
  })
}

export function getRemoteState(): RemoteStateDto {
  const { database } = getAppContext()
  const settings = readSettings(database.db)
  const row = readRemoteRow()
  const assets = Number(
    (database.db.prepare('SELECT COUNT(*) AS total FROM local_copies WHERE present = 1').get() as {
      total: number
    }).total
  )

  if (!row) {
    return {
      connected: false,
      baseUrl: null,
      libraryId: null,
      lastCheckAt: null,
      lastCheckStatus: null,
      credentialStored: false,
      credentialStorageAvailable: isCredentialStorageAvailable(),
      assets,
      verified: 0,
      pending: 0,
      failed: 0,
      libraryRoot: settings.libraryRoot
    }
  }

  const counts = remoteStatusCounts(database.db, row.remoteId)
  // 断开只清凭据、保留连接记录，因此"已连接"还要确认凭据仍绑定且可解密
  const credentialStored =
    row.credentialRef.length > 0 &&
    loadCredential(getAppContext().paths.dataDir, row.credentialRef) !== null
  return {
    connected: credentialStored,
    baseUrl: row.baseUrl,
    libraryId: row.libraryId,
    lastCheckAt: row.lastCheckAt,
    lastCheckStatus: row.lastCheckStatus,
    credentialStored,
    credentialStorageAvailable: isCredentialStorageAvailable(),
    assets,
    verified: counts.verified,
    pending: counts.pending,
    failed: counts.failed,
    libraryRoot: settings.libraryRoot
  }
}

/** 连接（或更新）远端存储：探测能力 → 新建或加入图库 → 保存凭据。 */
export async function connectRemote(input: {
  baseUrl: string
  username: string
  password: string
  libraryId?: string | null
}): Promise<RemoteConnectionDto> {
  const { database, paths } = getAppContext()

  if (!isCredentialStorageAvailable()) {
    throw new AppError('APP_INTERNAL', '当前系统无法安全加密保存密码，已拒绝连接')
  }

  const { baseUrl: davBaseUrl, rootPath: davRootPath } = splitDavUrl(input.baseUrl)
  const client = new DavClient({
    baseUrl: davBaseUrl,
    rootPath: davRootPath,
    credential: { username: input.username, password: input.password }
  })

  // 先确保基础路径存在，再探测能力（有些远端不会自动创建 URL 里的目录）
  await client.ensureBaseCollection()

  // 明确测试认证是否可用：探测里的第一项失败会很快暴露问题
  const probe: CapabilityItem[] = await probeCapabilities(client, '')
  const failed = probe.filter((item) => !item.ok)
  const authFailed = failed.some(
    (item) => item.detail.includes('401') || item.detail.includes('认证')
  )
  if (authFailed) {
    throw new AppError('DAV_AUTH', '远端拒绝了这组账号密码')
  }

  let libraryId = input.libraryId ?? ''
  let descriptor = null

  const list = await client.list('steam-gallery-v1')
  for (const href of list.hrefs) {
    const candidateId = href.split('/').filter((segment) => segment.length > 0).pop()
    if (!candidateId || candidateId === 'steam-gallery-v1') continue
    if (input.libraryId && candidateId !== input.libraryId) continue
    const text = await client.getText(libraryDescriptorPath(candidateId))
    if (!text) continue
    try {
      const validation = validateLibraryDescriptor(JSON.parse(text), candidateId)
      if (validation.ok) {
        libraryId = candidateId
        descriptor = validation.descriptor
        break
      }
    } catch {
      // 单个描述文件损坏不影响其它图库
    }
  }

  if (!descriptor) {
    libraryId = input.libraryId ?? randomUUID()
    const created = buildLibraryDescriptor(libraryId, new Date().toISOString())
    await client.ensureCollection(libraryRootPath(libraryId))
    await client.putText(libraryDescriptorPath(libraryId), `${JSON.stringify(created, null, 2)}\n`)
    const readBack = await client.getText(libraryDescriptorPath(libraryId))
    const validation = validateLibraryDescriptor(readBack ? JSON.parse(readBack) : null, libraryId)
    if (!validation.ok) {
      throw new AppError('APP_INTERNAL', `library.json 读回校验失败：${validation.reason}`)
    }
    descriptor = validation.descriptor
  }

  const existing = database.db
    .prepare('SELECT remote_id AS remoteId, credential_ref AS credentialRef FROM remotes WHERE base_url = ? AND library_id = ? LIMIT 1')
    .get(input.baseUrl, libraryId) as { remoteId: string; credentialRef: string } | undefined

  const remoteId = existing?.remoteId ?? randomUUID()
  const now = new Date().toISOString()
  const status = failed.length === 0 ? 'ok' : 'partial'

  if (existing) {
    // 重新绑定凭据引用，恢复这台设备已有的备份历史
    database.db
      .prepare('UPDATE remotes SET last_check_at = ?, last_check_status = ?, credential_ref = ? WHERE remote_id = ?')
      .run(now, status, remoteId, remoteId)
  } else {
    database.db
      .prepare(
        `INSERT INTO remotes (remote_id, library_id, base_url, root_path, credential_ref, format_version, created_at, last_check_at, last_check_status)
         VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)`
      )
      .run(remoteId, libraryId, input.baseUrl, remoteId, descriptor.schemaVersion, now, now, status)
  }

  saveCredential(paths.dataDir, remoteId, { username: input.username, password: input.password })

  return {
    remoteId,
    libraryId,
    baseUrl: input.baseUrl,
    lastCheckStatus: status,
    capabilities: probe
  }
}

/**
 * 断开远端：只删除本机凭据并标记状态。
 *
 * 必须保留 remotes 行——remote_objects 以 remote_id 关联，
 * 删行会让"这台设备已经备份了哪些资产"的历史失联，重连后会被当成全部未备份而重复上传。
 */
export function disconnectRemote(): RemoteStateDto {
  const { database, paths } = getAppContext()
  const row = readRemoteRow()
  if (row) {
    deleteCredential(paths.dataDir, row.credentialRef)
    database.db
      .prepare("UPDATE remotes SET credential_ref = '', last_check_status = 'disconnected' WHERE remote_id = ?")
      .run(row.remoteId)
  }
  return getRemoteState()
}

export function getUploadStatus(): UploadStatusDto {
  return uploadStatus
}

export function cancelUpload(): UploadStatusDto {
  if (uploadJob) {
    uploadJob.cancelRequested = true
  }
  return uploadStatus
}

export function countPendingUploads(forceRetry: boolean): number {
  const { database } = getAppContext()
  const row = readRemoteRow()
  const settings = readSettings(database.db)
  if (!row || !settings.libraryRoot) {
    return 0
  }
  return planUpload(database.db, {
    remoteId: row.remoteId,
    libraryId: row.libraryId,
    deviceId: getAppContext().device.deviceId,
    libraryRoot: settings.libraryRoot,
    forceRetry
  }).length
}

export async function runUpload(input: { forceRetry?: boolean }): Promise<UploadSummaryDto> {
  if (uploadJob) {
    throw new AppError('JOB_RUNNING', '已有备份任务在执行')
  }

  const { database, device } = getAppContext()
  const settings = readSettings(database.db)
  if (!settings.libraryRoot) {
    throw new AppError('LIB_PATH_INVALID', '尚未选择图库目录，请先归档再上传')
  }

  const row = requireRemote()
  const client = buildClient(row)
  const startedAt = new Date().toISOString()
  const job = { cancelRequested: false }
  uploadJob = job

  uploadStatus = {
    running: true,
    processed: 0,
    total: null,
    currentFile: null,
    verified: 0,
    uploaded: 0,
    failed: 0,
    startedAt,
    finishedAt: null,
    errorCode: null,
    errorMessage: null
  }
  broadcast(IPC_EVENTS.uploadProgress, uploadStatus)

  try {
    const result = await uploadAssets(database.db, {
      remoteId: row.remoteId,
      libraryId: row.libraryId,
      deviceId: device.deviceId,
      libraryRoot: settings.libraryRoot,
      client,
      forceRetry: input.forceRetry === true,
      onProgress: (progress) => {
        uploadStatus = {
          running: true,
          processed: progress.processed,
          total: progress.total,
          currentFile: progress.currentFile,
          verified: progress.verified,
          uploaded: progress.uploaded,
          failed: progress.failed,
          startedAt,
          finishedAt: null,
          errorCode: null,
          errorMessage: null
        }
        broadcast(IPC_EVENTS.uploadProgress, uploadStatus)
      },
      shouldCancel: () => job.cancelRequested
    })

    uploadStatus = {
      ...uploadStatus,
      running: false,
      finishedAt: new Date().toISOString(),
      total: result.total,
      processed: result.verified + result.failed,
      verified: result.verified,
      uploaded: result.uploaded,
      failed: result.failed,
      errorCode: result.abortedByAuth ? 'DAV_AUTH' : null,
      errorMessage: result.abortedByAuth ? '远端拒绝认证，本轮已停止' : null
    }
    broadcast(IPC_EVENTS.uploadProgress, uploadStatus)

    return {
      total: result.total,
      verified: result.verified,
      uploaded: result.uploaded,
      failed: result.failed,
      cancelled: result.cancelled,
      abortedByAuth: result.abortedByAuth,
      durationMs: result.durationMs,
      libraryId: row.libraryId
    }
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'APP_INTERNAL'
    const message = error instanceof Error ? error.message : String(error)
    uploadStatus = {
      ...uploadStatus,
      running: false,
      finishedAt: new Date().toISOString(),
      errorCode: code,
      errorMessage: message
    }
    broadcast(IPC_EVENTS.uploadProgress, uploadStatus)
    throw error
  } finally {
    uploadJob = null
  }
}
