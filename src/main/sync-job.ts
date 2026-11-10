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
  RemoteBrowseDto,
  SyncSummaryDto,
  RemoteConnectionDto,
  RemoteKind,
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
import {
  DavClient,
  describeRootCandidates,
  probeCapabilities,
  probeDavBases,
  splitDavUrl,
  type CapabilityItem
} from '@core/sync/webdav'
import { FolderRemoteClient, isUsableFolderRoot } from '@core/sync/folder-remote'
import { checkBackupTarget } from '@core/sync/remote-target'
import type { RemoteClient } from '@core/sync/remote-client'
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
  kind: RemoteKind
  formatVersion: number
  lastCheckAt: string | null
  lastCheckStatus: string | null
}

function readRemoteRow(): RemoteRow | null {
  const { database } = getAppContext()
  const row = database.db
    .prepare(
      `SELECT remote_id AS remoteId, library_id AS libraryId, base_url AS baseUrl, root_path AS rootPath,
              credential_ref AS credentialRef, kind, format_version AS formatVersion,
              last_check_at AS lastCheckAt, last_check_status AS lastCheckStatus
         FROM remotes ORDER BY created_at LIMIT 1`
    )
    .get() as RemoteRow | undefined
  return row ?? null
}

function requireRemote(): RemoteRow {
  const row = readRemoteRow()
  if (!row) {
    throw new AppError('IPC_INVALID_INPUT', '尚未连接远端存储')
  }
  // 文件夹远端没有凭据；WebDAV 断开后 credential_ref 会被清空，等于没连
  if (row.kind !== 'folder' && row.credentialRef.length === 0) {
    throw new AppError('IPC_INVALID_INPUT', '尚未连接远端存储')
  }
  return row
}

/** 按远端种类造客户端：WebDAV 走 HTTP + 凭据，文件夹远端直接读写目录。 */
function buildStore(row: RemoteRow): RemoteClient {
  if (row.kind === 'folder') {
    const usable = isUsableFolderRoot(row.baseUrl)
    if (!usable.ok) {
      throw new AppError('LIB_PATH_INVALID', `远端目录不可用：${usable.reason}`)
    }
    return new FolderRemoteClient(row.baseUrl)
  }
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

/** 上传与恢复共用的入口：取当前已连接的远端（WebDAV 或文件夹）。 */
export function openRemote(): { store: RemoteClient; remoteId: string; libraryId: string } {
  const row = requireRemote()
  return { store: buildStore(row), remoteId: row.remoteId, libraryId: row.libraryId }
}

/**
 * 连接**之前**就能用的远端浏览器。
 *
 * 之前要在设置里手拼 `https://host/webdav/home/xxx/yyyy`，拼错就只得到一个 404。
 * 这里用表单里填的地址造一个临时客户端，把目录列出来让人点进去选。
 */
export async function browseRemote(input: {
  kind: RemoteKind
  address: string
  username: string
  password: string
  path: string
}): Promise<RemoteBrowseDto> {
  let store: RemoteClient

  if (input.kind === 'folder') {
    const usable = isUsableFolderRoot(input.address)
    if (!usable.ok) {
      throw new AppError('LIB_PATH_INVALID', `远端目录不可用：${usable.reason}`)
    }
    store = new FolderRemoteClient(input.address)
  } else {
    const { baseUrl, rootPath } = splitDavUrl(input.address)
    const relative = input.path
    store = new DavClient({
      baseUrl,
      rootPath: relative.length === 0 ? rootPath : `${rootPath}/${relative}`,
      credential: { username: input.username, password: input.password },
      timeoutMs: 15_000
    })
  }

  const list = await store.listEntries('')
  const segments = input.path.length === 0 ? [] : input.path.split('/')
  const breadcrumbs = [{ name: input.kind === 'folder' ? input.address : '远端根', path: '' }]
  let accumulated = ''
  for (const segment of segments) {
    accumulated = accumulated.length === 0 ? segment : `${accumulated}/${segment}`
    breadcrumbs.push({ name: segment, path: accumulated })
  }
  const parent = segments.length === 0 ? null : segments.slice(0, -1).join('/')

  return {
    path: input.path,
    parent,
    breadcrumbs,
    entries: list.map((entry) => ({
      name: entry.name,
      path: entry.path,
      isDir: entry.isDir,
      size: entry.size,
      modifiedAt: entry.modifiedAt
    }))
  }
}


/**
 * 同步链路总览。
 *
 * 各表分别回答一个问题：assets=索引里有多少、local_copies=图库里有几张、
 * remote_objects=远端各状态有多少。界面按「来源 → 图库 → 远端」排开显示，
 * 用户不用再猜某个数字是哪一边的。
 */
export function syncSummary(): SyncSummaryDto {
  const { database } = getAppContext()
  const settings = readSettings(database.db)
  const row = readRemoteRow()

  const localRow = database.db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM local_copies WHERE present = 1')
    .get() as { n: number; bytes: number }
  const indexedRow = database.db.prepare('SELECT COUNT(*) AS n FROM assets').get() as { n: number }

  const counts = row ? remoteStatusCounts(database.db, row.remoteId) : { verified: 0, pending: 0, failed: 0 }
  const lastRow = database.db
    .prepare("SELECT MAX(updated_at) AS at FROM remote_objects WHERE publish_status = 'verified'")
    .get() as { at: string | null }

  return {
    localCount: Number(localRow.n),
    localBytes: Number(localRow.bytes),
    indexedCount: Number(indexedRow.n),
    verified: counts.verified,
    pending: counts.pending,
    failed: counts.failed,
    remoteCount: counts.verified,
    lastBackupAt: lastRow.at,
    libraryRoot: settings.libraryRoot,
    remoteKind: row?.kind ?? null,
    remoteBaseUrl: row?.baseUrl ?? null
  }
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
      kind: null,
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
  // 断开只清凭据、保留连接记录，因此"已连接"还要确认凭据仍绑定且可解密。
  // 文件夹远端没有凭据，只看连接记录是否被标记为断开。
  const credentialStored =
    row.credentialRef.length > 0 &&
    loadCredential(getAppContext().paths.dataDir, row.credentialRef) !== null
  const connected =
    row.kind === 'folder' ? row.lastCheckStatus !== 'disconnected' : credentialStored
  return {
    connected,
    kind: row.kind,
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

/**
 * 连接（或更新）远端存储：确认目标可用 → 探测能力 → 新建或加入图库 → 保存配置/凭据。
 *
 * 远端有两种：WebDAV 服务，或一个普通文件夹（本机盘、NAS 共享、已映射的网络盘）。
 * 之后的上传与恢复走同一套管线，区别只在客户端实现（`RemoteClient`）。
 */
export async function connectRemote(input: {
  kind: RemoteKind
  address: string
  username: string
  password: string
  libraryId?: string | null
}): Promise<RemoteConnectionDto> {
  const { database, paths } = getAppContext()

  let store: RemoteClient
  let address = input.address
  const notes: CapabilityItem[] = []

  if (input.kind === 'folder') {
    const usable = isUsableFolderRoot(address)
    if (!usable.ok) {
      throw new AppError('LIB_PATH_INVALID', `远端目录不可用：${usable.reason}`)
    }
    // 备份目标不能就是图库目录本身，否则会把原图复制进它自己的子目录
    const problem = checkBackupTarget({
      kind: 'folder',
      address,
      libraryRoot: readSettings(database.db).libraryRoot
    })
    if (problem) {
      throw new AppError('LIB_PATH_INVALID', problem)
    }
    store = new FolderRemoteClient(address)
    notes.push({ name: '远端类型', ok: true, detail: `文件夹：${address}` })
  } else {
    if (!isCredentialStorageAvailable()) {
      throw new AppError('APP_INTERNAL', '当前系统无法安全加密保存密码，已拒绝连接')
    }
    const credential = { username: input.username, password: input.password }

    // 1) 先确认这个地址真的是一个 WebDAV 入口。只填到网关/域名时，常见前缀（如 /webdav）自动试一遍：
    //    用户的地址少一段路径，表现出来就是后面 MKCOL 一路 404，光看 404 根本猜不到是前缀问题。
    const baseProbes = await probeDavBases(address, credential)
    const givenProbe = baseProbes[0]
    const authRejected = baseProbes.some(
      (item) => item.detail.includes('DAV_AUTH') || item.detail.includes('401')
    )
    if (authRejected) {
      throw new AppError('DAV_AUTH', '远端拒绝了这组账号密码')
    }
    if (!givenProbe?.ok) {
      const usable = baseProbes.slice(1).find((item) => item.ok)
      if (!usable) {
        const detail = baseProbes.map((item) => `${item.url} → ${item.detail}`).join('；')
        throw new AppError(
          'DAV_PATH_INVALID',
          `这些地址都不是可用的 WebDAV 入口：${detail}。地址要填到 WebDAV 的实际入口，例如 http://<NAS>:<端口>/webdav/<目录>`
        )
      }
      address = usable.url
      notes.push({ name: '地址前缀', ok: true, detail: `填写的地址不可用，已自动改用 ${usable.url}` })
    }

    const { baseUrl: davBaseUrl, rootPath: davRootPath } = splitDavUrl(address)
    const client = new DavClient({ baseUrl: davBaseUrl, rootPath: davRootPath, credential })
    // 2) 先确保基础路径存在，再探测能力（有些远端不会自动创建 URL 里的目录）
    await client.ensureBaseCollection()
    store = client
  }

  // 3) 明确测试认证与写权限：探测里的 MKCOL 先失败会最快暴露"能连上但写不进去"
  const probe: CapabilityItem[] = await probeCapabilities(store, '')
  const mkcolProbe = probe.find((item) => item.name.startsWith('创建目录'))
  if (mkcolProbe && !mkcolProbe.ok) {
    // 地址只填到 WebDAV 根、而远端不允许在根上建目录时，把根下已有目录列成可直接填的地址
    const isDavRoot = input.kind === 'webdav' && splitDavUrl(address).rootPath.length === 0
    if (isDavRoot) {
      const hint = await describeRootCandidates(store, address)
      if (hint) {
        throw new AppError('DAV_PATH_INVALID', hint)
      }
    }
    // 其余情况抛出探测时那个原始错误，不再二次包一层前缀
    if (mkcolProbe.error instanceof AppError) {
      throw mkcolProbe.error
    }
    throw new AppError('DAV_PATH_INVALID', mkcolProbe.detail)
  }
  const capabilities = [...notes, ...probe]
  const failed = capabilities.filter((item) => !item.ok)
  const authFailed = failed.some(
    (item) => item.detail.includes('401') || item.detail.includes('认证')
  )
  if (authFailed) {
    throw new AppError('DAV_AUTH', '远端拒绝了这组账号密码')
  }

  let libraryId = input.libraryId ?? ''
  let descriptor = null

  const list = await store.list('steam-gallery-v1')
  for (const href of list.hrefs) {
    const candidateId = href.split('/').filter((segment) => segment.length > 0).pop()
    if (!candidateId || candidateId === 'steam-gallery-v1') continue
    if (input.libraryId && candidateId !== input.libraryId) continue
    const text = await store.getText(libraryDescriptorPath(candidateId))
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
    await store.ensureCollection(libraryRootPath(libraryId))
    await store.putText(libraryDescriptorPath(libraryId), `${JSON.stringify(created, null, 2)}\n`)
    const readBack = await store.getText(libraryDescriptorPath(libraryId))
    const validation = validateLibraryDescriptor(readBack ? JSON.parse(readBack) : null, libraryId)
    if (!validation.ok) {
      throw new AppError('APP_INTERNAL', `library.json 读回校验失败：${validation.reason}`)
    }
    descriptor = validation.descriptor
  }

  const existing = database.db
    .prepare(
      'SELECT remote_id AS remoteId, credential_ref AS credentialRef FROM remotes WHERE base_url = ? AND library_id = ? LIMIT 1'
    )
    .get(address, libraryId) as { remoteId: string; credentialRef: string } | undefined

  const remoteId = existing?.remoteId ?? randomUUID()
  const now = new Date().toISOString()
  const status = failed.length === 0 ? 'ok' : 'partial'
  // 文件夹远端不需要凭据；credential_ref 留空，断开时也就没有可删的东西
  const credentialRef = input.kind === 'folder' ? '' : remoteId

  if (existing) {
    // 重新绑定凭据引用，恢复这台设备已有的备份历史
    database.db
      .prepare(
        'UPDATE remotes SET last_check_at = ?, last_check_status = ?, credential_ref = ?, kind = ? WHERE remote_id = ?'
      )
      .run(now, status, credentialRef, input.kind, remoteId)
  } else {
    database.db
      .prepare(
        `INSERT INTO remotes (remote_id, library_id, base_url, root_path, credential_ref, kind, format_version, created_at, last_check_at, last_check_status)
         VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?)`
      )
      .run(remoteId, libraryId, address, credentialRef, input.kind, descriptor.schemaVersion, now, now, status)
  }

  if (input.kind === 'webdav') {
    saveCredential(paths.dataDir, remoteId, { username: input.username, password: input.password })
  }

  return {
    remoteId,
    libraryId,
    baseUrl: address,
    kind: input.kind,
    lastCheckStatus: status,
    capabilities
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
  const client = buildStore(row)
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
