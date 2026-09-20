/**
 * 索引写入。
 *
 * 幂等：资产按 `(account_key, game_key, sha256)`、来源文件按 `(source_id, account_key, relative_path)`
 * 更新而不是新增；重复扫描不产生重复行与重复计数。
 *
 * 存在状态：一次成功扫描结束后，先把本次扫描账号下的来源文件标记为不存在，
 * 再由实际见到的文件置回存在。来源不可达时调用方不得进入这里（避免把不可达误判为删除）。
 */

import { randomUUID } from 'node:crypto'
import type { SqliteDatabase } from '../db/sqlite'
import { accountKeyFor, type KnownHash, type ScanOutcome } from '../steam/scanner'

export interface IndexWriteResult {
  readonly assets: number
  readonly sourceFiles: number
  readonly missingMarked: number
}

export interface WriteScanInput {
  readonly sourceId: string
  readonly outcome: ScanOutcome
  /** 本次写入时间（ISO） */
  readonly seenAt: string
}

interface AssetRow {
  asset_id: string
  captured_at: string | null
  capture_time_source: string
  width: number | null
  height: number | null
}

/** 读取已有哈希，供扫描复用（size 与 mtime 未变时不必重读文件）。 */
export function loadKnownHashes(db: SqliteDatabase, sourceId: string): Map<string, KnownHash> {
  const rows = db
    .prepare(
      `SELECT sf.relative_path AS relativePath, sf.size AS size, sf.mtime_ms AS mtimeMs, a.sha256 AS sha256
         FROM source_files sf
         JOIN assets a ON a.asset_id = sf.asset_id
        WHERE sf.source_id = ?`
    )
    .all(sourceId)

  const result = new Map<string, KnownHash>()
  for (const row of rows) {
    result.set(String(row.relativePath), {
      size: Number(row.size),
      mtimeMs: Number(row.mtimeMs),
      sha256: String(row.sha256)
    })
  }
  return result
}

export function writeScanOutcome(db: SqliteDatabase, input: WriteScanInput): IndexWriteResult {
  const { sourceId, outcome, seenAt } = input
  const accountKeys = outcome.scannedAccounts.map(accountKeyFor)

  return db.transaction(() => {
    // 1) 账号
    const upsertProfile = db.prepare(
      `INSERT INTO profiles (account_key, steam_account_id, steam_id64, account_name, persona_name, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_key) DO UPDATE SET
         steam_id64 = COALESCE(excluded.steam_id64, profiles.steam_id64),
         account_name = COALESCE(excluded.account_name, profiles.account_name),
         persona_name = COALESCE(excluded.persona_name, profiles.persona_name),
         updated_at = excluded.updated_at`
    )
    for (const profile of outcome.profiles) {
      upsertProfile.run(
        accountKeyFor(profile.accountId),
        profile.accountId,
        profile.steamId64,
        profile.accountName,
        profile.personaName,
        seenAt
      )
    }

    // 2) 游戏
    const upsertGame = db.prepare(
      `INSERT INTO games (game_key, app_id, kind, name, name_source, installed, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_key) DO UPDATE SET
         app_id = COALESCE(excluded.app_id, games.app_id),
         name = excluded.name,
         name_source = excluded.name_source,
         installed = excluded.installed,
         updated_at = excluded.updated_at`
    )
    for (const game of outcome.games) {
      upsertGame.run(
        game.gameKey,
        game.appId,
        game.kind,
        game.name,
        game.nameSource,
        game.installed ? 1 : 0,
        seenAt
      )
    }

    // 3) 先把本次扫描账号下的来源文件标记为不存在，稍后由实际见到的文件置回
    let missingMarked = 0
    if (accountKeys.length > 0) {
      const placeholders = accountKeys.map(() => '?').join(', ')
      db.prepare(
        `UPDATE source_files SET present = 0
          WHERE source_id = ? AND account_key IN (${placeholders})`
      ).run(sourceId, ...accountKeys)
    }

    // 4) 资产与来源文件
    const findAsset = db.prepare(
      `SELECT asset_id, captured_at, capture_time_source, width, height
         FROM assets WHERE account_key = ? AND game_key = ? AND sha256 = ?`
    )
    const insertAsset = db.prepare(
      `INSERT INTO assets (asset_id, account_key, game_key, sha256, bytes, ext, width, height, captured_at, capture_time_source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const updateAsset = db.prepare(
      `UPDATE assets SET bytes = ?, ext = ?, width = ?, height = ?, captured_at = ?, capture_time_source = ?
        WHERE asset_id = ?`
    )
    const upsertSourceFile = db.prepare(
      `INSERT INTO source_files (source_file_id, source_id, account_key, asset_id, relative_path, size, mtime_ms, has_thumbnail, present, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(source_id, account_key, relative_path) DO UPDATE SET
         asset_id = excluded.asset_id,
         size = excluded.size,
         mtime_ms = excluded.mtime_ms,
         has_thumbnail = excluded.has_thumbnail,
         present = 1,
         last_seen_at = excluded.last_seen_at`
    )

    let assetCount = 0
    for (const candidate of outcome.candidates) {
      const accountKey = accountKeyFor(candidate.accountId)
      const existing = findAsset.get(accountKey, candidate.gameKey, candidate.sha256) as
        | AssetRow
        | undefined

      let assetId: string
      if (existing) {
        assetId = existing.asset_id
        // 已有的拍摄时间不被空值覆盖；来源标记跟随最终采用的值
        const capturedAt = candidate.capturedAt ?? existing.captured_at
        const captureTimeSource =
          candidate.capturedAt === null ? existing.capture_time_source : candidate.captureTimeSource

        updateAsset.run(
          candidate.size,
          candidate.ext,
          candidate.width ?? existing.width,
          candidate.height ?? existing.height,
          capturedAt,
          captureTimeSource,
          assetId
        )
      } else {
        assetId = randomUUID()
        insertAsset.run(
          assetId,
          accountKey,
          candidate.gameKey,
          candidate.sha256,
          candidate.size,
          candidate.ext,
          candidate.width,
          candidate.height,
          candidate.capturedAt,
          candidate.captureTimeSource,
          seenAt
        )
        assetCount += 1
      }

      upsertSourceFile.run(
        randomUUID(),
        sourceId,
        accountKey,
        assetId,
        candidate.relativePath,
        candidate.size,
        Math.round(candidate.mtimeMs),
        candidate.thumbnailAbsolutePath ? 1 : 0,
        seenAt
      )
    }

    missingMarked = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS total FROM source_files WHERE source_id = ? AND present = 0`
          )
          .get(sourceId) as { total: number } | undefined
      )?.total ?? 0
    )

    return {
      assets: assetCount,
      sourceFiles: outcome.candidates.length,
      missingMarked
    }
  })
}

export function markSourceScan(
  db: SqliteDatabase,
  input: { sourceId: string; status: string; error?: string | null; at: string }
): void {
  db.prepare(
    `UPDATE sources SET last_scan_at = ?, last_scan_status = ?, last_scan_error = ? WHERE source_id = ?`
  ).run(input.at, input.status, input.error ?? null, input.sourceId)
}

export function insertSource(
  db: SqliteDatabase,
  input: { sourceId: string; rootPath: string; kind: string; createdAt: string }
): void {
  db.prepare(
    `INSERT INTO sources (source_id, root_path, kind, created_at, last_scan_at, last_scan_status, last_scan_error)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL)
     ON CONFLICT(source_id) DO UPDATE SET root_path = excluded.root_path, kind = excluded.kind`
  ).run(input.sourceId, input.rootPath, input.kind, input.createdAt)
}

export interface SourceRow {
  readonly sourceId: string
  readonly rootPath: string
  readonly kind: string
  readonly lastScanAt: string | null
  readonly lastScanStatus: string | null
}

export function listSources(db: SqliteDatabase): SourceRow[] {
  const rows = db
    .prepare(
      `SELECT source_id AS sourceId, root_path AS rootPath, kind, last_scan_at AS lastScanAt, last_scan_status AS lastScanStatus
         FROM sources ORDER BY created_at`
    )
    .all()

  return rows.map((row) => ({
    sourceId: String(row.sourceId),
    rootPath: String(row.rootPath),
    kind: String(row.kind),
    lastScanAt: row.lastScanAt === null ? null : String(row.lastScanAt),
    lastScanStatus: row.lastScanStatus === null ? null : String(row.lastScanStatus)
  }))
}

export function findSourceByRoot(db: SqliteDatabase, rootPath: string): SourceRow | null {
  const row = db
    .prepare(
      `SELECT source_id AS sourceId, root_path AS rootPath, kind, last_scan_at AS lastScanAt, last_scan_status AS lastScanStatus
         FROM sources WHERE lower(root_path) = lower(?) LIMIT 1`
    )
    .get(rootPath)

  if (!row) {
    return null
  }
  return {
    sourceId: String(row.sourceId),
    rootPath: String(row.rootPath),
    kind: String(row.kind),
    lastScanAt: row.lastScanAt === null ? null : String(row.lastScanAt),
    lastScanStatus: row.lastScanStatus === null ? null : String(row.lastScanStatus)
  }
}

export function findSourceById(db: SqliteDatabase, sourceId: string): SourceRow | null {
  const row = db
    .prepare(
      `SELECT source_id AS sourceId, root_path AS rootPath, kind, last_scan_at AS lastScanAt, last_scan_status AS lastScanStatus
         FROM sources WHERE source_id = ? LIMIT 1`
    )
    .get(sourceId)

  if (!row) {
    return null
  }
  return {
    sourceId: String(row.sourceId),
    rootPath: String(row.rootPath),
    kind: String(row.kind),
    lastScanAt: row.lastScanAt === null ? null : String(row.lastScanAt),
    lastScanStatus: row.lastScanStatus === null ? null : String(row.lastScanStatus)
  }
}

/**
 * 移除来源登记：删除来源行与其来源文件记录。
 *
 * 保留 assets 行：资产是逻辑身份，重新登记同一来源后可以只靠 size/mtime 复用哈希，
 * 无需重算；在界面来源移除后这些资产会显示为"原图缺失"而不是消失。
 */
export function deleteSource(db: SqliteDatabase, sourceId: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM source_files WHERE source_id = ?').run(sourceId)
    db.prepare('DELETE FROM sources WHERE source_id = ?').run(sourceId)
  })
}
