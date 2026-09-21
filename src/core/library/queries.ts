/**
 * 图库查询。
 *
 * 只返回展示所需的数据：**不返回任何文件系统路径**（来源根与文件绝对路径都不出主进程）。
 * 图片通过 assetId 走 `ssm-asset` 协议获取。
 */

import type { SqliteDatabase } from '../db/sqlite'

export type AssetSort = 'captured-desc' | 'captured-asc' | 'imported-desc'

export interface GameSummary {
  readonly gameKey: string
  readonly name: string
  readonly kind: string
  readonly appId: string | null
  readonly installed: boolean
  readonly assetCount: number
  readonly bytes: number
  readonly latestCapturedAt: string | null
  readonly coverAssetId: string | null
  readonly coverHasThumbnail: boolean
  readonly accounts: readonly string[]
}

export interface AssetSummary {
  readonly assetId: string
  readonly accountKey: string
  readonly gameKey: string
  readonly gameName: string
  readonly fileName: string
  readonly bytes: number
  readonly width: number | null
  readonly height: number | null
  readonly capturedAt: string | null
  readonly captureTimeSource: string
  readonly available: boolean
  readonly hasThumbnail: boolean
  /** 是否已有受管的图库副本 */
  readonly archived: boolean
}

export interface AssetDetail extends AssetSummary {
  readonly ext: string
  readonly sha256: string
  readonly kind: string
  readonly appId: string | null
}

export interface LibraryStats {
  readonly games: number
  readonly assets: number
  readonly bytes: number
  readonly accounts: number
  readonly missingFiles: number
}

function baseName(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

function toNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

export interface ListGamesOptions {
  readonly query?: string | null
  readonly installed?: boolean | null
  readonly accountKey?: string | null
}

export function listGames(db: SqliteDatabase, options: ListGamesOptions = {}): GameSummary[] {
  const conditions: string[] = []
  const params: (string | number)[] = []

  if (options.query) {
    conditions.push('(lower(g.name) LIKE ? OR lower(g.game_key) LIKE ?)')
    const like = `%${options.query.toLowerCase()}%`
    params.push(like, like)
  }
  if (options.installed === true) {
    conditions.push('g.installed = 1')
  } else if (options.installed === false) {
    conditions.push('g.installed = 0')
  }
  if (options.accountKey) {
    conditions.push('a.account_key = ?')
    params.push(options.accountKey)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = db
    .prepare(
      `SELECT
         a.game_key                                        AS gameKey,
         g.name                                            AS name,
         g.kind                                            AS kind,
         g.app_id                                          AS appId,
         g.installed                                       AS installed,
         COUNT(a.asset_id)                                 AS assetCount,
         SUM(a.bytes)                                      AS bytes,
         MAX(a.captured_at)                                AS latestCapturedAt,
         GROUP_CONCAT(DISTINCT a.account_key)              AS accounts,
         (SELECT a2.asset_id FROM assets a2
            JOIN source_files sf2 ON sf2.asset_id = a2.asset_id AND sf2.present = 1
           WHERE a2.game_key = a.game_key
           ORDER BY COALESCE(a2.captured_at, '') DESC, a2.asset_id
           LIMIT 1)                                        AS coverAssetId,
         (SELECT COALESCE(MAX(sf3.has_thumbnail), 0) FROM source_files sf3
           WHERE sf3.asset_id = (SELECT a3.asset_id FROM assets a3
                                    JOIN source_files sf4 ON sf4.asset_id = a3.asset_id AND sf4.present = 1
                                   WHERE a3.game_key = a.game_key
                                   ORDER BY COALESCE(a3.captured_at, '') DESC, a3.asset_id
                                   LIMIT 1))           AS coverHasThumbnail
       FROM assets a
       JOIN games g ON g.game_key = a.game_key
       ${where}
       GROUP BY a.game_key
       ORDER BY (SELECT MAX(a4.captured_at) FROM assets a4 WHERE a4.game_key = a.game_key) DESC, g.name`
    )
    .all(...params)

  return rows.map((row) => ({
    gameKey: String(row.gameKey),
    name: String(row.name),
    kind: String(row.kind),
    appId: toNullableString(row.appId),
    installed: Number(row.installed) === 1,
    assetCount: Number(row.assetCount),
    bytes: Number(row.bytes ?? 0),
    latestCapturedAt: toNullableString(row.latestCapturedAt),
    coverAssetId: toNullableString(row.coverAssetId),
    coverHasThumbnail: Number(row.coverHasThumbnail ?? 0) === 1,
    accounts: String(row.accounts ?? '')
      .split(',')
      .filter((value) => value.length > 0)
  }))
}

export interface ListAssetsOptions {
  readonly gameKey?: string | null
  readonly accountKey?: string | null
  readonly installed?: boolean | null
  readonly query?: string | null
  readonly sort?: AssetSort
  readonly cursor?: string | null
  readonly limit?: number
}

export interface CursorPayload {
  readonly key: string
  readonly id: string
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): CursorPayload {
  const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as CursorPayload).key !== 'string' ||
    typeof (parsed as CursorPayload).id !== 'string'
  ) {
    throw new Error('游标格式非法')
  }
  return parsed as CursorPayload
}

const ASSET_SELECT = `
  SELECT
    a.asset_id            AS assetId,
    a.account_key         AS accountKey,
    a.game_key            AS gameKey,
    g.name                AS gameName,
    g.kind                AS kind,
    g.app_id              AS appId,
    a.sha256              AS sha256,
    a.bytes               AS bytes,
    a.ext                 AS ext,
    a.width               AS width,
    a.height              AS height,
    a.captured_at         AS capturedAt,
    a.capture_time_source AS captureTimeSource,
    (SELECT sf.relative_path FROM source_files sf
      WHERE sf.asset_id = a.asset_id AND sf.present = 1
      ORDER BY sf.relative_path LIMIT 1)              AS relativePath,
    (SELECT COALESCE(MAX(sf2.has_thumbnail), 0) FROM source_files sf2
      WHERE sf2.asset_id = a.asset_id AND sf2.present = 1) AS hasThumbnail,
    EXISTS (SELECT 1 FROM local_copies lc
             WHERE lc.asset_id = a.asset_id AND lc.present = 1) AS archived
  FROM assets a
  JOIN games g ON g.game_key = a.game_key
`

function mapAssetRow(row: Record<string, unknown>): AssetDetail {
  const relativePath = toNullableString(row.relativePath) ?? ''
  return {
    assetId: String(row.assetId),
    accountKey: String(row.accountKey),
    gameKey: String(row.gameKey),
    gameName: String(row.gameName),
    fileName: relativePath.length > 0 ? baseName(relativePath) : '(来源缺失)',
    bytes: Number(row.bytes),
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height: row.height === null || row.height === undefined ? null : Number(row.height),
    capturedAt: toNullableString(row.capturedAt),
    captureTimeSource: String(row.captureTimeSource),
    available: relativePath.length > 0,
    hasThumbnail: Number(row.hasThumbnail ?? 0) === 1,
    archived: Number(row.archived ?? 0) === 1,
    ext: String(row.ext),
    sha256: String(row.sha256),
    kind: String(row.kind),
    appId: toNullableString(row.appId)
  }
}

export function listAssets(
  db: SqliteDatabase,
  options: ListAssetsOptions = {}
): { items: AssetSummary[]; nextCursor: string | null } {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500)
  const sort: AssetSort = options.sort ?? 'captured-desc'
  const keyExpression = sort === 'imported-desc' ? 'a.created_at' : "COALESCE(a.captured_at, '')"
  const direction = sort === 'captured-asc' ? 'ASC' : 'DESC'

  const conditions: string[] = []
  const params: (string | number)[] = []

  if (options.gameKey) {
    conditions.push('a.game_key = ?')
    params.push(options.gameKey)
  }
  if (options.accountKey) {
    conditions.push('a.account_key = ?')
    params.push(options.accountKey)
  }
  if (options.installed === true) {
    conditions.push('g.installed = 1')
  } else if (options.installed === false) {
    conditions.push('g.installed = 0')
  }
  if (options.query) {
    conditions.push("(lower(g.name) LIKE ? OR lower(a.asset_id) LIKE ? OR EXISTS (SELECT 1 FROM source_files sf5 WHERE sf5.asset_id = a.asset_id AND lower(sf5.relative_path) LIKE ?))")
    const like = `%${options.query.toLowerCase()}%`
    params.push(like, like, like)
  }

  if (options.cursor) {
    const payload = decodeCursor(options.cursor)
    const operator = direction === 'DESC' ? '<' : '>'
    conditions.push(
      `(${keyExpression} ${operator} ? OR (${keyExpression} = ? AND a.asset_id > ?))`
    )
    params.push(payload.key, payload.key, payload.id)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = db
    .prepare(
      `${ASSET_SELECT} ${where}
       ORDER BY ${keyExpression} ${direction}, a.asset_id ASC
       LIMIT ?`
    )
    .all(...params, limit + 1)

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const items = page.map(mapAssetRow)

  let nextCursor: string | null = null
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1]!
    const key =
      sort === 'imported-desc'
        ? String(last['createdAt'] ?? '')
        : (toNullableString(last['capturedAt']) ?? '')
    nextCursor = encodeCursor({ key, id: String(last['assetId']) })
  }

  return { items, nextCursor }
}

export function getAsset(db: SqliteDatabase, assetId: string): AssetDetail | null {
  const row = db.prepare(`${ASSET_SELECT} WHERE a.asset_id = ? LIMIT 1`).get(assetId)
  return row ? mapAssetRow(row) : null
}

export function libraryStats(db: SqliteDatabase): LibraryStats {
  const games = Number((db.prepare('SELECT COUNT(*) AS total FROM games').get() as { total: number }).total)
  const assetsRow = db
    .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(bytes), 0) AS bytes FROM assets')
    .get() as { total: number; bytes: number }
  const accounts = Number(
    (db.prepare('SELECT COUNT(*) AS total FROM profiles').get() as { total: number }).total
  )
  const missing = Number(
    (
      db
        .prepare('SELECT COUNT(*) AS total FROM source_files WHERE present = 0')
        .get() as { total: number }
    ).total
  )

  return {
    games,
    assets: Number(assetsRow.total),
    bytes: Number(assetsRow.bytes),
    accounts,
    missingFiles: missing
  }
}

/** 按 assetId 找到可用于读取的来源与相对路径（含来源根，仅在主进程内部使用）。 */
export interface AssetLocation {
  readonly rootPath: string
  readonly relativePath: string
  readonly hasThumbnail: boolean
}

export function findAssetLocation(db: SqliteDatabase, assetId: string): AssetLocation | null {
  const row = db
    .prepare(
      `SELECT s.root_path AS rootPath, sf.relative_path AS relativePath, sf.has_thumbnail AS hasThumbnail
         FROM source_files sf
         JOIN sources s ON s.source_id = sf.source_id
        WHERE sf.asset_id = ? AND sf.present = 1
        ORDER BY sf.last_seen_at DESC
        LIMIT 1`
    )
    .get(assetId)

  if (!row) {
    return null
  }
  return {
    rootPath: String(row.rootPath),
    relativePath: String(row.relativePath),
    hasThumbnail: Number(row.hasThumbnail ?? 0) === 1
  }
}

export function listAccounts(
  db: SqliteDatabase
): { accountKey: string; displayName: string | null; assetCount: number }[] {
  const rows = db
    .prepare(
      `SELECT p.account_key AS accountKey,
              COALESCE(p.persona_name, p.account_name) AS displayName,
              (SELECT COUNT(*) FROM assets a WHERE a.account_key = p.account_key) AS assetCount
         FROM profiles p
        ORDER BY p.account_key`
    )
    .all()

  return rows.map((row) => ({
    accountKey: String(row.accountKey),
    displayName: toNullableString(row.displayName),
    assetCount: Number(row.assetCount)
  }))
}
