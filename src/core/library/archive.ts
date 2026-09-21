/**
 * 归档：把来源截图复制进独立图库。
 *
 * 可靠性规则（docs/architecture.md §5、docs/product-plan.md §5）：
 * - 来源只读：只读取源文件，绝不在来源目录写入或改名；
 * - 流式复制同时计算 SHA-256，与索引指纹核对，不一致就不发布；
 * - 同一文件系统内先写 `staging/*.part`，再改名发布（不可覆盖）；
 * - 目标已存在时校验内容：一致则直接补记录（支持中断后重跑），不一致则报错且不覆盖；
 * - 写 `metadata/...json` 说明文件，只含展示与重建所需字段，不含绝对路径与凭据；
 * - 全部动作幂等：重复执行不重复复制、不重复计数。
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AppError } from '@shared/errors'
import { isInsideRoot } from './asset-paths'
import { resolveExistingAssetPath } from './asset-paths'
import type { SqliteDatabase } from '../db/sqlite'

export interface ArchiveCandidate {
  readonly assetId: string
  readonly accountKey: string
  readonly gameKey: string
  readonly gameName: string
  readonly sha256: string
  readonly bytes: number
  readonly ext: string
  readonly width: number | null
  readonly height: number | null
  readonly capturedAt: string | null
  readonly captureTimeSource: string
  readonly sourceRoot: string
  readonly sourceRelativePath: string
  readonly originalFilename: string
}

export interface ArchiveProgress {
  readonly phase: 'planning' | 'copying' | 'verifying'
  readonly processed: number
  /** 总量未知时为 null */
  readonly total: number | null
  readonly currentFile: string | null
  readonly copied: number
  readonly skipped: number
  readonly failed: number
}

export interface ArchiveFailure {
  readonly assetId: string
  readonly relativePath: string
  readonly message: string
}

export interface ArchiveResult {
  readonly total: number
  readonly copied: number
  readonly skipped: number
  readonly failed: number
  readonly cancelled: boolean
  readonly failures: readonly ArchiveFailure[]
  readonly durationMs: number
}

export interface ArchiveOptions {
  readonly libraryRoot: string
  readonly gameKeys?: readonly string[]
  readonly assetIds?: readonly string[]
  readonly limit?: number
  readonly onProgress?: (progress: ArchiveProgress) => void
  readonly shouldCancel?: () => boolean
}

export interface ReconcileResult {
  readonly checked: number
  readonly missing: number
  readonly stagingCleaned: number
}

function baseNameOf(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

/** 归档候选：还没有受管副本（或副本已丢失）的资产。 */
export function planArchive(db: SqliteDatabase, options: ArchiveOptions): ArchiveCandidate[] {
  const conditions = ['(lc.local_copy_id IS NULL OR lc.present = 0)']
  const params: (string | number)[] = [resolve(options.libraryRoot)]

  if (options.gameKeys && options.gameKeys.length > 0) {
    conditions.push(`a.game_key IN (${options.gameKeys.map(() => '?').join(', ')})`)
    params.push(...options.gameKeys)
  }
  if (options.assetIds && options.assetIds.length > 0) {
    conditions.push(`a.asset_id IN (${options.assetIds.map(() => '?').join(', ')})`)
    params.push(...options.assetIds)
  }

  const limitClause = options.limit && options.limit > 0 ? `LIMIT ${Math.floor(options.limit)}` : ''

  const rows = db
    .prepare(
      `SELECT
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
         s.root_path           AS sourceRoot,
         sf.relative_path      AS sourceRelativePath
       FROM assets a
       JOIN games g ON g.game_key = a.game_key
       LEFT JOIN local_copies lc
              ON lc.asset_id = a.asset_id AND lc.library_root = ?
       JOIN source_files sf
              ON sf.source_file_id = (
                   SELECT sf2.source_file_id FROM source_files sf2
                    WHERE sf2.asset_id = a.asset_id AND sf2.present = 1
                    ORDER BY sf2.last_seen_at DESC, sf2.relative_path
                    LIMIT 1
                 )
       JOIN sources s ON s.source_id = sf.source_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY a.game_key, a.asset_id
      ${limitClause}`
    )
    .all(...params)

  return rows.map((row) => {
    const sourceRelativePath = String(row.sourceRelativePath)
    return {
      assetId: String(row.assetId),
      accountKey: String(row.accountKey),
      gameKey: String(row.gameKey),
      gameName: String(row.gameName),
      sha256: String(row.sha256),
      bytes: Number(row.bytes),
      ext: String(row.ext),
      width: row.width === null || row.width === undefined ? null : Number(row.width),
      height: row.height === null || row.height === undefined ? null : Number(row.height),
      capturedAt: row.capturedAt === null ? null : String(row.capturedAt),
      captureTimeSource: String(row.captureTimeSource),
      sourceRoot: String(row.sourceRoot),
      sourceRelativePath,
      originalFilename: baseNameOf(sourceRelativePath)
    }
  })
}

/** 受管相对路径：originals/<accountKey>/<gameKey>/<sha256><ext>。 */
export function managedRelativePath(candidate: {
  accountKey: string
  gameKey: string
  sha256: string
  ext: string
}): string {
  const ext = candidate.ext.startsWith('.') ? candidate.ext : `.${candidate.ext}`
  return `originals/${candidate.accountKey}/${candidate.gameKey}/${candidate.sha256}${ext}`
}

export function metadataRelativePath(candidate: {
  accountKey: string
  gameKey: string
  sha256: string
}): string {
  return `metadata/${candidate.accountKey}/${candidate.gameKey}/${candidate.sha256}.json`
}

/**
 * 流式复制并同时计算 SHA-256；不把整文件读入内存。
 *
 * 用 `stream/promises.pipeline` 串起来：它从建立流的那一刻就接管错误，
 * 失败时销毁所有流、关闭句柄，并把错误变成 Promise 拒绝交给调用方。
 * （手工 write/drain 的写法曾经在"目标不可写"时抛出未捕获的 'error' 事件，
 * 外层 try/catch 抓不到，会直接打断整个任务。）
 */
export async function copyWithHash(
  sourcePath: string,
  targetPath: string
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256')
  let bytes = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      bytes += chunk.length
      callback(null, chunk)
    }
  })

  await pipeline(
    createReadStream(sourcePath, { highWaterMark: 1024 * 1024 }),
    meter,
    createWriteStream(targetPath)
  )

  return { sha256: hash.digest('hex'), bytes }
}

export async function hashExistingFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 })
  for await (const chunk of stream) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/** 写入本地说明文件（临时文件 + 改名）。归档与恢复共用。 */
export function writeLocalMetadata(
  libraryRoot: string,
  relativePath: string,
  payload: Record<string, unknown>
): void {
  const absolutePath = join(libraryRoot, relativePath)
  mkdirSync(dirname(absolutePath), { recursive: true })
  const temporary = `${absolutePath}.tmp`
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  renameSync(temporary, absolutePath)
}

function writeMetadata(
  libraryRoot: string,
  candidate: ArchiveCandidate,
  archivedAt: string
): string {
  const relativePath = metadataRelativePath(candidate)
  const absolutePath = join(libraryRoot, relativePath)
  mkdirSync(dirname(absolutePath), { recursive: true })

  const payload = {
    schemaVersion: 1,
    assetId: candidate.assetId,
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
    archivedAt
  }

  writeLocalMetadata(libraryRoot, relativePath, payload)
  return relativePath
}

export function upsertLocalCopy(
  db: SqliteDatabase,
  input: {
    assetId: string
    libraryRoot: string
    relativePath: string
    bytes: number
    sha256: string
    verifiedAt: string
  }
): void {
  db.prepare(
    `INSERT INTO local_copies (local_copy_id, asset_id, library_root, relative_path, bytes, sha256, verified_at, present, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(asset_id, library_root) DO UPDATE SET
       relative_path = excluded.relative_path,
       bytes = excluded.bytes,
       sha256 = excluded.sha256,
       verified_at = excluded.verified_at,
       present = 1`
  ).run(
    randomUUID(),
    input.assetId,
    input.libraryRoot,
    input.relativePath,
    input.bytes,
    input.sha256,
    input.verifiedAt,
    input.verifiedAt
  )
}

function markSourceFileMissing(db: SqliteDatabase, assetId: string): void {
  db.prepare('UPDATE source_files SET present = 0 WHERE asset_id = ?').run(assetId)
}

/**
 * 执行归档。逐项处理，单张失败不影响其余；
 * 中断（shouldCancel）时保留已完成的部分，重跑会跳过已完成项。
 */
export async function archiveAssets(
  db: SqliteDatabase,
  options: ArchiveOptions
): Promise<ArchiveResult> {
  const startedAt = Date.now()
  const libraryRoot = resolve(options.libraryRoot)

  const report = (progress: ArchiveProgress): void => {
    options.onProgress?.(progress)
  }

  report({
    phase: 'planning',
    processed: 0,
    total: null,
    currentFile: null,
    copied: 0,
    skipped: 0,
    failed: 0
  })

  if (!existsSync(libraryRoot)) {
    mkdirSync(libraryRoot, { recursive: true })
  }
  const stagingDir = join(libraryRoot, 'staging')
  mkdirSync(stagingDir, { recursive: true })

  const candidates = planArchive(db, { ...options, libraryRoot })
  const failures: ArchiveFailure[] = []
  let copied = 0
  let skipped = 0

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!
    if (options.shouldCancel?.()) {
      return {
        total: candidates.length,
        copied,
        skipped,
        failed: failures.length,
        cancelled: true,
        failures,
        durationMs: Date.now() - startedAt
      }
    }

    const relativePath = managedRelativePath(candidate)
    const absolutePath = join(libraryRoot, relativePath)
    const verifiedAt = new Date().toISOString()

    try {
      if (existsSync(absolutePath)) {
        // 已存在：校验内容一致后直接补记录（覆盖"复制完成但记录未写入"的中断场景）
        const existingHash = await hashExistingFile(absolutePath)
        if (existingHash !== candidate.sha256) {
          throw new AppError('LIB_HASH_MISMATCH', '图库中同名文件内容与索引指纹不一致')
        }
        writeMetadata(libraryRoot, candidate, verifiedAt)
        upsertLocalCopy(db, {
          assetId: candidate.assetId,
          libraryRoot,
          relativePath,
          bytes: candidate.bytes,
          sha256: candidate.sha256,
          verifiedAt
        })
        skipped += 1
      } else {
        const sourcePath = await resolveExistingAssetPath(
          candidate.sourceRoot,
          candidate.sourceRelativePath
        )
        const temporary = join(stagingDir, `${candidate.assetId}-${randomUUID()}.part`)
        let copiedBytes = 0
        try {
          const result = await copyWithHash(sourcePath, temporary)
          copiedBytes = result.bytes
          if (result.sha256 !== candidate.sha256) {
            throw new AppError('LIB_HASH_MISMATCH', '复制后指纹与索引不一致，来源可能已变化')
          }
          mkdirSync(dirname(absolutePath), { recursive: true })
          try {
            renameSync(temporary, absolutePath)
          } catch (error) {
            // 目标可能被并发创建（或改名被系统暂时拒绝）：核对后决定是否算成功
            if (existsSync(absolutePath)) {
              const existingHash = await hashExistingFile(absolutePath)
              if (existingHash !== candidate.sha256) {
                throw new AppError('LIB_HASH_MISMATCH', '目标已存在且内容不同，拒绝覆盖')
              }
              rmSync(temporary, { force: true })
            } else {
              throw error
            }
          }
        } catch (error) {
          rmSync(temporary, { force: true })
          throw error
        }

        writeMetadata(libraryRoot, candidate, verifiedAt)
        upsertLocalCopy(db, {
          assetId: candidate.assetId,
          libraryRoot,
          relativePath,
          bytes: copiedBytes,
          sha256: candidate.sha256,
          verifiedAt
        })
        copied += 1
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'SRC_NOT_FOUND') {
        // 索引说来源存在但实际读不到：如实标记来源缺失，交由下次扫描补回
        markSourceFileMissing(db, candidate.assetId)
      }
      failures.push({
        assetId: candidate.assetId,
        relativePath,
        message: error instanceof Error ? error.message : String(error)
      })
    }

    report({
      phase: 'copying',
      processed: index + 1,
      total: candidates.length,
      currentFile: candidate.originalFilename,
      copied,
      skipped,
      failed: failures.length
    })
  }

  return {
    total: candidates.length,
    copied,
    skipped,
    failed: failures.length,
    cancelled: false,
    failures,
    durationMs: Date.now() - startedAt
  }
}

/**
 * 启动对账：受管文件缺失则标记 present=0；清理 staging 残留（它们按定义都是未完成的）。
 * 不删除任何已发布的原件，也不触碰来源。
 */
export function reconcileLibrary(db: SqliteDatabase, libraryRoot: string): ReconcileResult {
  const root = resolve(libraryRoot)
  const rows = db
    .prepare(
      `SELECT local_copy_id AS id, relative_path AS relativePath FROM local_copies
        WHERE library_root = ? AND present = 1`
    )
    .all(root)

  let missing = 0
  for (const row of rows) {
    const absolutePath = join(root, String(row.relativePath))
    if (!isInsideRoot(root, absolutePath) || !existsSync(absolutePath)) {
      db.prepare('UPDATE local_copies SET present = 0 WHERE local_copy_id = ?').run(String(row.id))
      missing += 1
    }
  }

  let stagingCleaned = 0
  const stagingDir = join(root, 'staging')
  if (existsSync(stagingDir)) {
    for (const entry of readdirSync(stagingDir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue
      }
      try {
        const info = statSync(join(stagingDir, entry.name))
        rmSync(join(stagingDir, entry.name), { force: true })
        if (info.isFile()) {
          stagingCleaned += 1
        }
      } catch {
        // 清理失败不影响对账结论
      }
    }
  }

  return { checked: rows.length, missing, stagingCleaned }
}

export interface LocalCopyState {
  readonly archived: number
  readonly missing: number
}

/** 图库副本概览，供界面显示。 */
export function localCopyState(db: SqliteDatabase, libraryRoot: string): LocalCopyState {
  const root = resolve(libraryRoot)
  const archived = Number(
    (
      db
        .prepare(
          'SELECT COUNT(*) AS total FROM local_copies WHERE library_root = ? AND present = 1'
        )
        .get(root) as { total: number }
    ).total
  )
  const missing = Number(
    (
      db
        .prepare(
          'SELECT COUNT(*) AS total FROM local_copies WHERE library_root = ? AND present = 0'
        )
        .get(root) as { total: number }
    ).total
  )
  return { archived, missing }
}
