/**
 * 从远端图库恢复（docs/sync-protocol.md §7）。
 *
 * 恢复只读远端，不改写、不删除任何远端内容：
 *   1. 逐层列出 `records/<device>/<YYYY-MM>/*.json` 并读回校验；
 *   2. 按游戏汇总，先让用户选择要恢复哪些游戏；
 *   3. 逐条下载对象 → 流式校验 SHA-256 与字节数 → 通过后才发布进本地图库；
 *   4. 写入本地说明文件、资产行与受管副本记录，使恢复结果与归档结果等价。
 *
 * 幂等与续传：已存在且校验通过的资产直接跳过，因此中断后重跑只处理剩余项。
 * 同一内容在多个游戏下各存一份（与归档布局一致），按 (账号, 游戏, 指纹) 去重。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { AppError } from '@shared/errors'
import type { SqliteDatabase } from '../db/sqlite'
import { isInsideRoot } from '../library/asset-paths'
import {
  managedRelativePath,
  metadataRelativePath,
  upsertLocalCopy,
  writeLocalMetadata
} from '../library/archive'
import { libraryRootPath, validateRecord } from '../sync/library-remote'
import { DavClient } from '../sync/webdav'

export interface RemoteRecordEntry {
  readonly recordId: string
  readonly deviceId: string
  readonly accountKey: string
  readonly gameKey: string
  readonly gameName: string | null
  readonly originalFilename: string
  readonly sha256: string
  readonly bytes: number
  readonly ext: string
  readonly width: number | null
  readonly height: number | null
  readonly capturedAt: string | null
  readonly captureTimeSource: string
  readonly objectKey: string
  readonly recordKey: string
}

export interface ListRemoteRecordsResult {
  readonly records: RemoteRecordEntry[]
  readonly scannedRecords: number
  readonly invalidRecords: number
  readonly errors: readonly string[]
}

function segmentOf(href: string): string {
  const cleaned = href.replace(/\/+$/, '')
  return cleaned.slice(cleaned.lastIndexOf('/') + 1)
}

function extOf(objectKey: string): string {
  const name = objectKey.slice(objectKey.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot) : ''
}

/**
 * 列出远端全部记录。
 * 按 `records/<device>/<月>/` 逐层 PROPFIND，避免依赖服务端是否支持 Depth:infinity。
 */
export async function listRemoteRecords(
  client: DavClient,
  libraryId: string,
  options?: {
    readonly onProgress?: (scanned: number, valid: number) => void
    readonly shouldCancel?: () => boolean
  }
): Promise<ListRemoteRecordsResult> {
  const recordsRoot = `${libraryRootPath(libraryId)}/records`
  const records: RemoteRecordEntry[] = []
  const errors: string[] = []
  let scanned = 0
  let invalid = 0

  const deviceLevel = await client.list(recordsRoot)
  const deviceDirs = deviceLevel.hrefs
    .map((href) => segmentOf(href))
    .filter((name) => name.length > 0 && name !== 'records')

  for (const device of deviceDirs) {
    if (options?.shouldCancel?.()) break
    const monthLevel = await client.list(`${recordsRoot}/${device}`)
    const monthDirs = monthLevel.hrefs
      .map((href) => segmentOf(href))
      .filter((name) => name.length > 0 && name !== device && /^\d{4}-\d{2}$/.test(name))

    for (const month of monthDirs) {
      if (options?.shouldCancel?.()) break
      const monthLevelList = await client.list(`${recordsRoot}/${device}/${month}`)
      const files = monthLevelList.hrefs
        .map((href) => segmentOf(href))
        .filter((name) => name.endsWith('.json'))

      for (const file of files) {
        if (options?.shouldCancel?.()) break
        const recordKey = `${recordsRoot}/${device}/${month}/${file}`
        scanned += 1
        const text = await client.getText(recordKey)
        if (!text) {
          invalid += 1
          errors.push(`记录不可读：${file}`)
          continue
        }

        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(text) as Record<string, unknown>
        } catch {
          invalid += 1
          errors.push(`记录不是合法 JSON：${file}`)
          continue
        }

        const recordId = String(parsed['recordId'] ?? '')
        const objectKey = String(parsed['objectKey'] ?? '')
        const sha256 = String(parsed['sha256'] ?? '')
        const bytes = Number(parsed['bytes'] ?? 0)

        // 用记录自身的关键字段做一次结构校验（远端可能被第三方改动过）
        const validation = validateRecord(parsed, {
          libraryId,
          recordId,
          objectKey,
          sha256,
          bytes
        })
        if (!validation.ok) {
          invalid += 1
          errors.push(`记录校验失败（${file}）：${validation.reason}`)
          continue
        }

        records.push({
          recordId,
          deviceId: String(parsed['deviceId'] ?? device),
          accountKey: String(parsed['accountKey'] ?? ''),
          gameKey: String(parsed['gameKey'] ?? ''),
          gameName: typeof parsed['gameName'] === 'string' ? parsed['gameName'] : null,
          originalFilename: String(parsed['originalFilename'] ?? ''),
          sha256,
          bytes,
          ext: extOf(objectKey),
          width: typeof parsed['width'] === 'number' ? parsed['width'] : null,
          height: typeof parsed['height'] === 'number' ? parsed['height'] : null,
          capturedAt: typeof parsed['capturedAt'] === 'string' ? parsed['capturedAt'] : null,
          captureTimeSource:
            typeof parsed['captureTimeSource'] === 'string' ? parsed['captureTimeSource'] : 'remote-record',
          objectKey,
          recordKey
        })
        options?.onProgress?.(scanned, records.length)
      }
    }
  }

  return { records, scannedRecords: scanned, invalidRecords: invalid, errors: errors.slice(0, 20) }
}

export interface RestoreGamePlan {
  readonly gameKey: string
  readonly gameName: string
  readonly assets: number
  readonly bytes: number
  readonly alreadyLocal: number
}

/** 按游戏汇总可恢复内容；已在本机图库中的资产单独计数。 */
export function planRestoreGames(
  db: SqliteDatabase,
  records: readonly RemoteRecordEntry[],
  libraryRoot: string
): RestoreGamePlan[] {
  const root = resolve(libraryRoot)
  const hasLocal = db.prepare(
    `SELECT 1 AS ok FROM assets a
       JOIN local_copies lc ON lc.asset_id = a.asset_id AND lc.present = 1 AND lc.library_root = ?
      WHERE a.account_key = ? AND a.game_key = ? AND a.sha256 = ?
      LIMIT 1`
  )

  const seen = new Set<string>()
  const byGame = new Map<string, { gameName: string; assets: number; bytes: number; alreadyLocal: number }>()

  for (const record of records) {
    const logicalKey = `${record.accountKey}|${record.gameKey}|${record.sha256}`
    if (seen.has(logicalKey)) {
      continue
    }
    seen.add(logicalKey)

    const entry = byGame.get(record.gameKey) ?? {
      gameName: record.gameName ?? record.gameKey,
      assets: 0,
      bytes: 0,
      alreadyLocal: 0
    }
    entry.assets += 1
    entry.bytes += record.bytes
    if (hasLocal.get(root, record.accountKey, record.gameKey, record.sha256)) {
      entry.alreadyLocal += 1
    }
    byGame.set(record.gameKey, entry)
  }

  return [...byGame.entries()]
    .map(([gameKey, value]) => ({
      gameKey,
      gameName: value.gameName,
      assets: value.assets,
      bytes: value.bytes,
      alreadyLocal: value.alreadyLocal
    }))
    .sort((a, b) => b.assets - a.assets)
}

export interface RestoreProgress {
  readonly processed: number
  readonly total: number
  readonly restored: number
  readonly skipped: number
  readonly failed: number
  readonly currentFile: string | null
}

export interface RestoreFailure {
  readonly recordId: string
  readonly objectKey: string
  readonly code: string
  readonly message: string
}

export interface RestoreResult {
  readonly total: number
  readonly restored: number
  readonly skipped: number
  readonly failed: number
  readonly cancelled: boolean
  readonly abortedByAuth: boolean
  readonly failures: readonly RestoreFailure[]
  readonly durationMs: number
}

export interface RestoreOptions {
  readonly libraryRoot: string
  /** 远端标识：恢复成功后登记"该资产在此远端已存在"，避免换机后重复上传 */
  readonly remoteId?: string
  readonly libraryId: string
  readonly client: DavClient
  readonly records: readonly RemoteRecordEntry[]
  readonly gameKeys?: readonly string[]
  readonly onProgress?: (progress: RestoreProgress) => void
  readonly shouldCancel?: () => boolean
}

function upsertGame(
  db: SqliteDatabase,
  input: { gameKey: string; gameName: string | null; now: string }
): void {
  const appId = input.gameKey.startsWith('steam-') ? input.gameKey.slice('steam-'.length) : null
  const kind = input.gameKey.startsWith('shortcut-') ? 'shortcut' : 'steam'
  db.prepare(
    `INSERT INTO games (game_key, app_id, kind, name, name_source, installed, updated_at)
     VALUES (?, ?, ?, ?, 'remote-record', 0, ?)
     ON CONFLICT(game_key) DO UPDATE SET
       name = CASE WHEN games.name_source = 'remote-record' THEN excluded.name ELSE games.name END,
       updated_at = excluded.updated_at`
  ).run(input.gameKey, appId, kind, input.gameName ?? input.gameKey, input.now)
}

function upsertAsset(
  db: SqliteDatabase,
  record: RemoteRecordEntry,
  now: string
): string {
  const existing = db
    .prepare('SELECT asset_id AS assetId FROM assets WHERE account_key = ? AND game_key = ? AND sha256 = ?')
    .get(record.accountKey, record.gameKey, record.sha256) as { assetId: string } | undefined

  if (existing) {
    db.prepare(
      `UPDATE assets SET bytes = ?, ext = ?, width = COALESCE(width, ?), height = COALESCE(height, ?),
              captured_at = COALESCE(captured_at, ?),
              capture_time_source = CASE WHEN captured_at IS NULL THEN ? ELSE capture_time_source END,
              original_filename = COALESCE(original_filename, ?)
        WHERE asset_id = ?`
    ).run(
      record.bytes,
      record.ext,
      record.width,
      record.height,
      record.capturedAt,
      record.captureTimeSource,
      record.originalFilename,
      existing.assetId
    )
    return existing.assetId
  }

  const assetId = randomUUID()
  db.prepare(
    `INSERT INTO assets (asset_id, account_key, game_key, sha256, bytes, ext, width, height, captured_at, capture_time_source, created_at, original_filename)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    assetId,
    record.accountKey,
    record.gameKey,
    record.sha256,
    record.bytes,
    record.ext,
    record.width,
    record.height,
    record.capturedAt,
    record.captureTimeSource,
    now,
    record.originalFilename
  )
  return assetId
}

function alreadyRestored(
  db: SqliteDatabase,
  record: RemoteRecordEntry,
  libraryRoot: string
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM assets a
         JOIN local_copies lc ON lc.asset_id = a.asset_id AND lc.present = 1 AND lc.library_root = ?
        WHERE a.account_key = ? AND a.game_key = ? AND a.sha256 = ?
        LIMIT 1`
    )
    .get(resolve(libraryRoot), record.accountKey, record.gameKey, record.sha256)
  return Boolean(row)
}

/**
 * 登记"该资产在这个远端已存在"。
 *
 * 依据：本机副本的指纹与远端记录一致，而记录是上传端在**读回校验对象之后**才发布的，
 * 因此这条链路等价于"对象已在远端且内容一致"。没有这条登记，换机恢复后再次备份
 * 会把整个图库重传一遍（实测触发过一次，多占约 1.6 GB）。
 */
function markRemoteVerified(
  db: SqliteDatabase,
  input: {
    remoteId: string
    assetId: string
    objectKey: string
    recordId: string
    now: string
  }
): void {
  const segments = input.objectKey.split('/').filter((segment) => segment.length > 0)
  const uploadId = segments.length >= 2 ? segments[segments.length - 2]! : 'restored'
  db.prepare(
    `INSERT INTO remote_objects
       (remote_object_id, remote_id, asset_id, object_key, record_id, upload_id, publish_status,
        verified_at, last_error, attempt_count, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, NULL, 0, NULL, ?, ?)
     ON CONFLICT(remote_id, asset_id) DO UPDATE SET
       object_key = excluded.object_key,
       record_id = excluded.record_id,
       publish_status = 'verified',
       verified_at = excluded.verified_at,
       updated_at = excluded.updated_at`
  ).run(
    randomUUID(),
    input.remoteId,
    input.assetId,
    input.objectKey,
    input.recordId,
    uploadId,
    input.now,
    input.now,
    input.now
  )
}

function isAuthFailure(code: string): boolean {
  return code === 'DAV_AUTH' || code === 'DAV_FORBIDDEN'
}

export async function restoreAssets(
  db: SqliteDatabase,
  options: RestoreOptions
): Promise<RestoreResult> {
  const startedAt = Date.now()
  const libraryRoot = resolve(options.libraryRoot)

  // 按逻辑资产去重（同一指纹在同一游戏下只恢复一次）
  const seen = new Set<string>()
  const pendingAll: RemoteRecordEntry[] = []
  for (const record of options.records) {
    const logicalKey = `${record.accountKey}|${record.gameKey}|${record.sha256}`
    if (seen.has(logicalKey)) continue
    seen.add(logicalKey)
    if (options.gameKeys && options.gameKeys.length > 0 && !options.gameKeys.includes(record.gameKey)) {
      continue
    }
    pendingAll.push(record)
  }

  const stagingDir = join(libraryRoot, 'staging')
  mkdirSync(stagingDir, { recursive: true })

  let processed = 0
  let restored = 0
  let skipped = 0
  let abortedByAuth = false
  const failures: RestoreFailure[] = []

  const report = (currentFile: string | null): void => {
    options.onProgress?.({
      processed,
      total: pendingAll.length,
      restored,
      skipped,
      failed: failures.length,
      currentFile
    })
  }
  report(null)

  for (const record of pendingAll) {
    if (options.shouldCancel?.() || abortedByAuth) {
      break
    }

    try {
      if (alreadyRestored(db, record, libraryRoot)) {
        skipped += 1
        if (options.remoteId) {
          const localAsset = db
            .prepare(
              'SELECT asset_id AS assetId FROM assets WHERE account_key = ? AND game_key = ? AND sha256 = ?'
            )
            .get(record.accountKey, record.gameKey, record.sha256) as { assetId: string } | undefined
          if (localAsset) {
            markRemoteVerified(db, {
              remoteId: options.remoteId,
              assetId: localAsset.assetId,
              objectKey: record.objectKey,
              recordId: record.recordId,
              now: new Date().toISOString()
            })
          }
        }
      } else {
        const relativePath = managedRelativePath({
          accountKey: record.accountKey,
          gameKey: record.gameKey,
          sha256: record.sha256,
          ext: record.ext
        })
        const absolutePath = join(libraryRoot, relativePath)
        const verifiedAt = new Date().toISOString()

        if (existsSync(absolutePath)) {
          // 文件已在但记录缺失：交给归档对账/下一次归档补记录，这里只补本地副本行
          const assetId = upsertAsset(db, record, verifiedAt)
          upsertGame(db, { gameKey: record.gameKey, gameName: record.gameName, now: verifiedAt })
          upsertLocalCopy(db, {
            assetId,
            libraryRoot,
            relativePath,
            bytes: record.bytes,
            sha256: record.sha256,
            verifiedAt
          })
          if (options.remoteId) {
            markRemoteVerified(db, {
              remoteId: options.remoteId,
              assetId,
              objectKey: record.objectKey,
              recordId: record.recordId,
              now: verifiedAt
            })
          }
          skipped += 1
        } else {
          const temporary = join(stagingDir, `${record.recordId}-${randomUUID()}.part`)
          try {
            const downloaded = await options.client.downloadToFile(record.objectKey, temporary)
            if (!downloaded) {
              throw new AppError('SRC_NOT_FOUND', '远端对象不存在')
            }
            if (downloaded.sha256 !== record.sha256 || downloaded.bytes !== record.bytes) {
              throw new AppError('LIB_HASH_MISMATCH', '下载内容与记录指纹不一致')
            }

            mkdirSync(dirname(absolutePath), { recursive: true })
            if (!isInsideRoot(libraryRoot, absolutePath)) {
              throw new AppError('LIB_PATH_INVALID', '恢复路径越出图库目录')
            }
            renameSync(temporary, absolutePath)

            upsertGame(db, { gameKey: record.gameKey, gameName: record.gameName, now: verifiedAt })
            const assetId = upsertAsset(db, record, verifiedAt)

            writeLocalMetadata(libraryRoot, metadataRelativePath(record), {
              schemaVersion: 1,
              assetId,
              accountKey: record.accountKey,
              gameKey: record.gameKey,
              gameName: record.gameName,
              originalFilename: record.originalFilename,
              sha256: record.sha256,
              bytes: record.bytes,
              ext: record.ext,
              width: record.width,
              height: record.height,
              capturedAt: record.capturedAt,
              captureTimeSource: record.captureTimeSource,
              archivedAt: verifiedAt,
              restoredFrom: {
                libraryId: options.libraryId,
                recordId: record.recordId,
                objectKey: record.objectKey
              }
            })

            upsertLocalCopy(db, {
              assetId,
              libraryRoot,
              relativePath,
              bytes: record.bytes,
              sha256: record.sha256,
              verifiedAt
            })
            if (options.remoteId) {
              markRemoteVerified(db, {
                remoteId: options.remoteId,
                assetId,
                objectKey: record.objectKey,
                recordId: record.recordId,
                now: verifiedAt
              })
            }
            restored += 1
          } catch (error) {
            rmSync(temporary, { force: true })
            throw error
          }
        }
      }
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'APP_INTERNAL'
      failures.push({
        recordId: record.recordId,
        objectKey: record.objectKey,
        code,
        message: error instanceof Error ? error.message : String(error)
      })
      if (isAuthFailure(code)) {
        abortedByAuth = true
      }
    }

    processed += 1
    report(record.originalFilename)
  }

  return {
    total: pendingAll.length,
    restored,
    skipped,
    failed: failures.length,
    cancelled: options.shouldCancel?.() === true && !abortedByAuth,
    abortedByAuth,
    failures: failures.slice(0, 20),
    durationMs: Date.now() - startedAt
  }
}
