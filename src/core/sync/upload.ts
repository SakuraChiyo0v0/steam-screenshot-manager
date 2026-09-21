/**
 * 上传管线（docs/sync-protocol.md §6）。
 *
 * 每个资产的顺序是固定的，**校验通过前不允许标记完成**：
 *   1. 先把 uploadId 与对象路径持久化；
 *   2. PUT 到设备独立路径（不做 MOVE、不覆盖别家对象）；
 *   3. GET 读回并流式计算 SHA-256，必须与本地原件一致；
 *   4. 对象校验通过后才发布不可变记录；
 *   5. GET 读回记录，逐字段校验通过后才标记"远端已校验"。
 *
 * 中断恢复靠"重新规划 + 已持久化的阶段状态"：重跑时先尝试读回已分配的对象/记录，
 * 判断上一次操作是否其实已经成功，再决定是否重传。
 */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError } from '@shared/errors'
import type { SqliteDatabase } from '../db/sqlite'
import { DavClient } from './webdav'
import {
  buildObjectKey,
  buildRecord,
  buildRecordKey,
  validateRecord
} from './library-remote'

export type PublishStatus = 'planned' | 'object-uploaded' | 'verified' | 'failed'

export interface UploadCandidate {
  readonly remoteObjectId: string | null
  readonly assetId: string
  readonly accountKey: string
  readonly gameKey: string
  readonly gameName: string | null
  readonly sha256: string
  readonly bytes: number
  readonly ext: string
  readonly width: number | null
  readonly height: number | null
  readonly capturedAt: string | null
  readonly captureTimeSource: string
  readonly originalFilename: string
  readonly localFilePath: string
  readonly uploadId: string
  readonly objectKey: string
  readonly recordId: string
  readonly publishStatus: PublishStatus | null
  readonly attemptCount: number
}

export interface UploadProgress {
  readonly processed: number
  readonly total: number | null
  readonly verified: number
  readonly uploaded: number
  readonly failed: number
  readonly currentFile: string | null
}

export interface UploadFailure {
  readonly assetId: string
  readonly code: string
  readonly message: string
}

export interface UploadResult {
  readonly total: number
  readonly verified: number
  readonly uploaded: number
  readonly failed: number
  readonly cancelled: boolean
  /** 认证/权限问题导致整轮暂停 */
  readonly abortedByAuth: boolean
  readonly failures: readonly UploadFailure[]
  readonly durationMs: number
}

export interface UploadOptions {
  readonly remoteId: string
  readonly libraryId: string
  readonly deviceId: string
  readonly libraryRoot: string
  readonly client: DavClient
  readonly concurrency?: number
  readonly maxAttempts?: number
  readonly forceRetry?: boolean
  /** 本轮最多处理多少个资产（用于分批验证与快速冒烟） */
  readonly maxItems?: number
  readonly onProgress?: (progress: UploadProgress) => void
  readonly shouldCancel?: () => boolean
  /** 供测试注入等待，避免真的睡很久 */
  readonly sleep?: (ms: number) => Promise<void>
}

function readCandidateRows(
  db: SqliteDatabase,
  input: { remoteId: string; libraryId: string; deviceId: string; libraryRoot: string; forceRetry: boolean }
): UploadCandidate[] {
  const rows = db
    .prepare(
      `SELECT
         ro.remote_object_id   AS remoteObjectId,
         ro.upload_id          AS uploadId,
         ro.object_key         AS objectKey,
         ro.record_id          AS recordId,
         ro.publish_status     AS publishStatus,
         ro.attempt_count      AS attemptCount,
         ro.next_attempt_at    AS nextAttemptAt,
         a.asset_id            AS assetId,
         a.account_key         AS accountKey,
         a.game_key            AS gameKey,
         g.name                AS gameName,
         a.sha256              AS sha256,
         a.bytes               AS bytes,
         a.ext                 AS ext,
         a.width               AS width,
         a.height              AS height,
         a.captured_at         AS capturedAt,
         a.capture_time_source AS captureTimeSource,
         lc.relative_path      AS localRelativePath,
         lc.library_root       AS libraryRoot
       FROM local_copies lc
       JOIN assets a ON a.asset_id = lc.asset_id
       JOIN games g ON g.game_key = a.game_key
       LEFT JOIN remote_objects ro
              ON ro.asset_id = a.asset_id AND ro.remote_id = ?
      WHERE lc.present = 1 AND lc.library_root = ?
        AND (ro.remote_object_id IS NULL OR ro.publish_status <> 'verified')
      ORDER BY a.game_key, COALESCE(a.captured_at, ''), a.asset_id`
    )
    .all(input.remoteId, input.libraryRoot)

  const now = Date.now()
  const candidates: UploadCandidate[] = []

  for (const row of rows) {
    if (!input.forceRetry) {
      const nextAttemptAt = row.nextAttemptAt === null ? null : String(row.nextAttemptAt)
      if (nextAttemptAt) {
        const next = Date.parse(nextAttemptAt)
        if (Number.isFinite(next) && next > now) {
          // 还在退避窗口内：本轮跳过，等下次重试
          continue
        }
      }
    }

    const localRelativePath = String(row.localRelativePath)
    const fileName = localRelativePath.slice(localRelativePath.lastIndexOf('/') + 1)
    const uploadId = row.uploadId === null || row.uploadId === undefined ? randomUUID() : String(row.uploadId)
    const recordId = row.recordId === null || row.recordId === undefined ? randomUUID() : String(row.recordId)
    const objectKey =
      row.objectKey === null || row.objectKey === undefined
        ? buildObjectKey(input.libraryId, {
            accountKey: String(row.accountKey),
            gameKey: String(row.gameKey),
            deviceId: input.deviceId,
            uploadId,
            sha256: String(row.sha256),
            ext: String(row.ext)
          })
        : String(row.objectKey)

    candidates.push({
      remoteObjectId: row.remoteObjectId === null ? null : String(row.remoteObjectId),
      assetId: String(row.assetId),
      accountKey: String(row.accountKey),
      gameKey: String(row.gameKey),
      gameName: row.gameName === null ? null : String(row.gameName),
      sha256: String(row.sha256),
      bytes: Number(row.bytes),
      ext: String(row.ext),
      width: row.width === null ? null : Number(row.width),
      height: row.height === null ? null : Number(row.height),
      capturedAt: row.capturedAt === null ? null : String(row.capturedAt),
      captureTimeSource: String(row.captureTimeSource),
      originalFilename: fileName,
      localFilePath: join(String(row.libraryRoot), ...localRelativePath.split('/')),
      uploadId,
      objectKey,
      recordId,
      publishStatus: row.publishStatus === null ? null : (String(row.publishStatus) as PublishStatus),
      attemptCount: Number(row.attemptCount ?? 0)
    })
  }

  return candidates
}

export function planUpload(
  db: SqliteDatabase,
  input: { remoteId: string; libraryId: string; deviceId: string; libraryRoot: string; forceRetry?: boolean }
): UploadCandidate[] {
  return readCandidateRows(db, { ...input, forceRetry: input.forceRetry === true })
}

function upsertRemoteObject(
  db: SqliteDatabase,
  input: {
    remoteObjectId: string | null
    remoteId: string
    assetId: string
    objectKey: string
    recordId: string
    uploadId: string
    publishStatus: PublishStatus
    verifiedAt: string | null
    lastError: string | null
    attemptCount: number
    nextAttemptAt: string | null
    now: string
  }
): string {
  if (input.remoteObjectId) {
    db.prepare(
      `UPDATE remote_objects
          SET object_key = ?, record_id = ?, upload_id = ?, publish_status = ?, verified_at = ?,
              last_error = ?, attempt_count = ?, next_attempt_at = ?, updated_at = ?
        WHERE remote_object_id = ?`
    ).run(
      input.objectKey,
      input.recordId,
      input.uploadId,
      input.publishStatus,
      input.verifiedAt,
      input.lastError,
      input.attemptCount,
      input.nextAttemptAt,
      input.now,
      input.remoteObjectId
    )
    return input.remoteObjectId
  }

  const created = randomUUID()
  db.prepare(
    `INSERT INTO remote_objects
       (remote_object_id, remote_id, asset_id, object_key, record_id, upload_id, publish_status,
        verified_at, last_error, attempt_count, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    created,
    input.remoteId,
    input.assetId,
    input.objectKey,
    input.recordId,
    input.uploadId,
    input.publishStatus,
    input.verifiedAt,
    input.lastError,
    input.attemptCount,
    input.nextAttemptAt,
    input.now,
    input.now
  )
  return created
}

function isAuthFailure(code: string): boolean {
  return code === 'DAV_AUTH' || code === 'DAV_FORBIDDEN'
}

function isRetriable(code: string): boolean {
  return code === 'DAV_TIMEOUT' || code === 'DAV_RATE_LIMIT' || code === 'DAV_CAPACITY'
}

/** 有上限的指数退避 + 抖动；429 优先用服务端给的等待时间。 */
export function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(retryAfterMs, 5 * 60 * 1000)
  }
  const base = Math.min(2_000 * 2 ** Math.max(0, attempt - 1), 60_000)
  const jitter = Math.floor(base * 0.1 * Math.random())
  return base + jitter
}

/** 把本地文件下载到临时目录并计算哈希，用于回读校验。 */
async function readBackAndHash(
  client: DavClient,
  relativePath: string
): Promise<{ sha256: string; bytes: number } | null> {
  const tempDir = mkdtempSync(join(tmpdir(), 'ssm-verify-'))
  const target = join(tempDir, 'payload.bin')
  try {
    const result = await client.downloadToFile(relativePath, target)
    if (!result) {
      return null
    }
    return { sha256: result.sha256, bytes: result.bytes }
  } finally {
    // 临时目录清理失败（Windows 下句柄/索引器偶发占用）不影响校验结论，
    // 更不能因此把一张已经校验通过的图判为失败。
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* 交给系统临时目录清理 */
    }
  }
}

async function processCandidate(
  db: SqliteDatabase,
  candidate: UploadCandidate,
  options: UploadOptions
): Promise<'verified' | 'uploaded' | 'failed'> {
  const now = (): string => new Date().toISOString()
  let remoteObjectId = candidate.remoteObjectId

  try {
    return await runCandidateSteps(db, candidate, options, () => remoteObjectId, (id) => {
      remoteObjectId = id
    })
  } catch (error) {
    // 失败也必须在"跟踪到的 id"上更新，否则会再插一行触发唯一键冲突，
    // 把真正的失败原因盖掉（真实发生过的缺陷）。
    const code = error instanceof AppError ? error.code : 'APP_INTERNAL'
    const message = error instanceof Error ? error.message : String(error)
    const attempt = candidate.attemptCount + 1
    const retryAfterMs = error instanceof AppError ? error.retryAfterMs : undefined
    upsertRemoteObject(db, {
      remoteObjectId,
      remoteId: options.remoteId,
      assetId: candidate.assetId,
      objectKey: candidate.objectKey,
      recordId: candidate.recordId,
      uploadId: candidate.uploadId,
      publishStatus: 'failed',
      verifiedAt: null,
      lastError: `[${code}] ${message}`.slice(0, 500),
      attemptCount: attempt,
      nextAttemptAt: isRetriable(code)
        ? new Date(Date.now() + backoffMs(attempt, retryAfterMs)).toISOString()
        : null,
      now: now()
    })
    throw error
  }
}

async function runCandidateSteps(
  db: SqliteDatabase,
  candidate: UploadCandidate,
  options: UploadOptions,
  getObjectId: () => string | null,
  setObjectId: (id: string) => void
): Promise<'verified' | 'uploaded'> {
  const now = (): string => new Date().toISOString()
  const base = {
    remoteId: options.remoteId,
    assetId: candidate.assetId,
    objectKey: candidate.objectKey,
    recordId: candidate.recordId,
    uploadId: candidate.uploadId,
    attemptCount: candidate.attemptCount
  }

  // 1) 先把对象路径与 uploadId 持久化（中断后下次能认出已分配的对象）
  setObjectId(
    upsertRemoteObject(db, {
      ...base,
      remoteObjectId: getObjectId(),
      publishStatus: 'planned',
      verifiedAt: null,
      lastError: null,
      nextAttemptAt: null,
      now: now()
    })
  )

  // 2) 对象：先尝试读回已分配的对象，避免重复传输
  let objectReady = false
  let didUpload = false
  if (candidate.publishStatus === 'object-uploaded' || candidate.publishStatus === 'planned') {
    const existing = await readBackAndHash(options.client, candidate.objectKey)
    if (existing && existing.sha256 === candidate.sha256 && existing.bytes === candidate.bytes) {
      objectReady = true
    }
  }

  if (!objectReady) {
    await options.client.putFile(candidate.objectKey, candidate.localFilePath)
    didUpload = true
    const verified = await readBackAndHash(options.client, candidate.objectKey)
    if (!verified) {
      throw new AppError('APP_INTERNAL', '上传后读回不到对象')
    }
    if (verified.sha256 !== candidate.sha256 || verified.bytes !== candidate.bytes) {
      throw new AppError('LIB_HASH_MISMATCH', '读回的远端对象与本地原件不一致')
    }
  }

  setObjectId(
    upsertRemoteObject(db, {
      ...base,
      remoteObjectId: getObjectId(),
      publishStatus: 'object-uploaded',
      verifiedAt: null,
      lastError: null,
      nextAttemptAt: null,
      now: now()
    })
  )

  // 3) 记录：先看是否已经发布过（上次中断在发布之后）
  const recordPath = buildRecordKey(options.libraryId, {
    deviceId: options.deviceId,
    recordId: candidate.recordId,
    at: candidate.capturedAt ? new Date(candidate.capturedAt) : new Date()
  })

  const expected = {
    libraryId: options.libraryId,
    recordId: candidate.recordId,
    objectKey: candidate.objectKey,
    sha256: candidate.sha256,
    bytes: candidate.bytes
  }

  let recordOk = false
  const existingRecordText = await options.client.getText(recordPath)
  if (existingRecordText) {
    try {
      const parsed: unknown = JSON.parse(existingRecordText)
      recordOk = validateRecord(parsed, expected).ok
    } catch {
      recordOk = false
    }
  }

  if (!recordOk) {
    const record = buildRecord({
      libraryId: options.libraryId,
      recordId: candidate.recordId,
      deviceId: options.deviceId,
      accountKey: candidate.accountKey,
      gameKey: candidate.gameKey,
      gameName: candidate.gameName,
      originalFilename: candidate.originalFilename,
      sha256: candidate.sha256,
      bytes: candidate.bytes,
      ext: candidate.ext,
      width: candidate.width,
      height: candidate.height,
      capturedAt: candidate.capturedAt,
      captureTimeSource: candidate.captureTimeSource,
      importedAt: now(),
      objectKey: candidate.objectKey
    })
    await options.client.putText(recordPath, `${JSON.stringify(record, null, 2)}\n`)

    const readBack = await options.client.getText(recordPath)
    if (!readBack) {
      throw new AppError('APP_INTERNAL', '发布后读回不到记录')
    }
    const validation = validateRecord(JSON.parse(readBack), expected)
    if (!validation.ok) {
      throw new AppError('APP_INTERNAL', `读回记录校验失败：${validation.reason}`)
    }
  }

  // 4) 到这里才算"远端已校验"
  setObjectId(
    upsertRemoteObject(db, {
      ...base,
      remoteObjectId: getObjectId(),
      publishStatus: 'verified',
      verifiedAt: now(),
      lastError: null,
      nextAttemptAt: null,
      now: now()
    })
  )

  return didUpload ? 'uploaded' : 'verified'
}

/**
 * 执行上传。并发默认 2（与协议建议一致）。
 * 认证/权限错误会让整轮停止，避免无限重试；可重试错误按退避安排下次。
 */
export async function uploadAssets(
  db: SqliteDatabase,
  options: UploadOptions
): Promise<UploadResult> {
  const startedAt = Date.now()
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const planned = planUpload(db, {
    remoteId: options.remoteId,
    libraryId: options.libraryId,
    deviceId: options.deviceId,
    libraryRoot: options.libraryRoot,
    forceRetry: options.forceRetry === true
  })
  const candidates =
    options.maxItems && options.maxItems > 0 ? planned.slice(0, options.maxItems) : planned

  const failures: UploadFailure[] = []
  let verified = 0
  let uploaded = 0
  let abortedByAuth = false
  let processed = 0
  const total = candidates.length
  let cursor = 0

  const report = (currentFile: string | null): void => {
    options.onProgress?.({
      processed,
      total,
      verified,
      uploaded,
      failed: failures.length,
      currentFile
    })
  }

  report(null)

  const worker = async (): Promise<void> => {
    for (;;) {
      if (abortedByAuth || options.shouldCancel?.()) {
        return
      }
      const index = cursor
      cursor += 1
      if (index >= candidates.length) {
        return
      }

      const candidate = candidates[index]!
      try {
        const outcome = await processCandidate(db, candidate, options)
        if (outcome === 'uploaded') {
          uploaded += 1
        }
        verified += 1
      } catch (error) {
        // 失败状态已在 processCandidate 内按跟踪到的 id 落库，这里只做分类与计数
        const code = error instanceof AppError ? error.code : 'APP_INTERNAL'
        const message = error instanceof Error ? error.message : String(error)
        const attempt = candidate.attemptCount + 1
        const retryAfterMs = error instanceof AppError ? error.retryAfterMs : undefined

        failures.push({ assetId: candidate.assetId, code, message })

        if (isAuthFailure(code)) {
          abortedByAuth = true
          return
        }
        if (isRetriable(code)) {
          // 让出一个退避窗口的四分之一，避免整轮立刻打满
          await sleep(Math.min(backoffMs(attempt, retryAfterMs), 5_000))
        }
      }

      processed += 1
      report(candidate.originalFilename)
    }
  }

  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 8))
  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  return {
    total,
    verified,
    uploaded,
    failed: failures.length,
    cancelled: options.shouldCancel?.() === true && !abortedByAuth,
    abortedByAuth,
    failures,
    durationMs: Date.now() - startedAt
  }
}

export interface RemoteStatusCounts {
  readonly verified: number
  readonly pending: number
  readonly failed: number
}

/** 远端备份状态概览，供界面显示。 */
export function remoteStatusCounts(db: SqliteDatabase, remoteId: string): RemoteStatusCounts {
  const rows = db
    .prepare('SELECT publish_status AS status, COUNT(*) AS total FROM remote_objects WHERE remote_id = ? GROUP BY publish_status')
    .all(remoteId)

  let verified = 0
  let failed = 0
  let pending = 0
  for (const row of rows) {
    const status = String(row.status)
    const total = Number(row.total)
    if (status === 'verified') {
      verified += total
    } else if (status === 'failed') {
      failed += total
    } else {
      pending += total
    }
  }
  return { verified, pending, failed }
}

/** 读取本地文件哈希，供验证脚本与测试使用。 */
export async function hashLocalFile(filePath: string): Promise<string> {
  if (!existsSync(filePath)) {
    throw new AppError('SRC_NOT_FOUND', `文件不存在：${filePath}`)
  }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}
