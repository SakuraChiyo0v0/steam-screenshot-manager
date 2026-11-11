/**
 * 从图库目录重建索引。
 *
 * 换机器、或者把图库目录直接放在 NAS 上时，索引（sqlite）是空的，但图库本身
 * 已经带着完整信息：每张原图旁边都有一份 `metadata/<accountKey>/<gameKey>/<sha256>.json`。
 * 这里只读这些说明文件重建 games / assets / profiles / local_copies，
 * **不读来源、不复制任何文件、不修改图库内容**。
 *
 * 幂等：已存在的资产按 (account_key, game_key, sha256) 复用原 assetId，
 * 副本按 (asset_id, library_root) 更新；重复导入不产生重复行。
 *
 * 元数据里的 assetId 会被沿用（预览缓存按 assetId/sha256 命名，沿用它才能直接命中）。
 */

import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AppError } from '@shared/errors'
import type { SqliteDatabase } from '../db/sqlite'
import { shouldReplaceName } from './game-name'
import { completeGameNamesFromCache } from '../steam/app-names'
import { upsertLocalCopy } from './archive'

export interface LibraryRecord {
  readonly assetId: string
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
  readonly archivedAt: string | null
  /** 原图在图库里的相对路径 */
  readonly relativePath: string
}

export interface ImportProgress {
  readonly processed: number
  readonly total: number
  readonly currentFile: string | null
  readonly imported: number
  readonly failed: number
}

export interface ImportSummary {
  readonly libraryRoot: string
  readonly scanned: number
  readonly imported: number
  readonly skipped: number
  readonly failed: number
  readonly games: number
  readonly accounts: number
  readonly durationMs: number
  /** 前几条失败原因，便于界面提示 */
  readonly failures: readonly string[]
}

export interface ImportOptions {
  readonly libraryRoot: string
  readonly onProgress?: (progress: ImportProgress) => void
  readonly shouldCancel?: () => boolean
}

/** 元数据里出现的字段一律当外部输入校验：图库目录可能被同步工具改过，也可能来自别的版本。 */
function parseRecord(raw: unknown): { ok: true; record: LibraryRecord } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: '说明文件不是对象' }
  }
  const value = raw as Record<string, unknown>
  if (value.schemaVersion !== 1) {
    return { ok: false, reason: `不支持的说明文件版本：${String(value.schemaVersion)}` }
  }
  const pickString = (key: string): string | null => {
    const item = value[key]
    return typeof item === 'string' && item.length > 0 ? item : null
  }
  const assetId = pickString('assetId')
  const accountKey = pickString('accountKey')
  const gameKey = pickString('gameKey')
  const originalFilename = pickString('originalFilename')
  const sha256 = pickString('sha256')
  const ext = pickString('ext')
  const bytes = value.bytes

  if (!assetId) return { ok: false, reason: '缺少 assetId' }
  if (!accountKey) return { ok: false, reason: '缺少 accountKey' }
  if (!gameKey) return { ok: false, reason: '缺少 gameKey' }
  if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) return { ok: false, reason: 'sha256 格式非法' }
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes <= 0) {
    return { ok: false, reason: 'bytes 非法' }
  }
  if (!ext || !ext.startsWith('.')) return { ok: false, reason: 'ext 非法' }

  const rawWidth = value.width
  const rawHeight = value.height
  const width = typeof rawWidth === 'number' && Number.isInteger(rawWidth) ? rawWidth : null
  const height = typeof rawHeight === 'number' && Number.isInteger(rawHeight) ? rawHeight : null

  return {
    ok: true,
    record: {
      assetId,
      accountKey,
      gameKey,
      gameName: pickString('gameName'),
      originalFilename: originalFilename ?? `${sha256.slice(0, 12)}${ext}`,
      sha256: sha256.toLowerCase(),
      bytes,
      ext,
      width,
      height,
      capturedAt: pickString('capturedAt'),
      captureTimeSource: pickString('captureTimeSource') ?? 'unknown',
      archivedAt: pickString('archivedAt'),
      relativePath: `originals/${accountKey}/${gameKey}/${sha256.toLowerCase()}${ext}`
    }
  }
}

/**
 * 现有原图的清单：`${accountKey}/${gameKey}` → 文件名集合。
 *
 * 网络盘上每次 stat 都是一次几十毫秒的往返，几千张图逐个 stat 会把导入拖成分钟级；
 * 改成每个游戏目录一次 readdir，几十次调用就够。
 */
function listExistingOriginals(libraryRoot: string): Map<string, Set<string>> {
  const originalsRoot = join(libraryRoot, 'originals')
  const index = new Map<string, Set<string>>()
  for (const account of safeReadDir(originalsRoot)) {
    const accountDir = join(originalsRoot, account)
    for (const game of safeReadDir(accountDir)) {
      index.set(`${account}/${game}`, new Set(safeReadDir(join(accountDir, game))))
    }
  }
  return index
}

/** 列出所有说明文件的绝对路径（metadata/<account>/<game>/<sha>.json）。 */
function listMetadataFiles(libraryRoot: string): string[] {
  const metadataRoot = join(libraryRoot, 'metadata')
  const files: string[] = []
  for (const account of safeReadDir(metadataRoot)) {
    const accountDir = join(metadataRoot, account)
    for (const game of safeReadDir(accountDir)) {
      const gameDir = join(accountDir, game)
      for (const file of safeReadDir(gameDir)) {
        if (file.toLowerCase().endsWith('.json')) {
          files.push(join(gameDir, file))
        }
      }
    }
  }
  return files
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function gameKind(gameKey: string): 'steam' | 'non-steam' {
  return gameKey.startsWith('shortcut-') ? 'non-steam' : 'steam'
}

function appIdOf(gameKey: string): string | null {
  const match = /^steam-(\d+)$/.exec(gameKey)
  return match ? match[1]! : null
}

function accountIdOf(accountKey: string): string {
  const match = /^steam-(.+)$/.exec(accountKey)
  return match ? match[1]! : accountKey
}

/**
 * 扫描图库并写入索引。全部写入在一个事务里完成，中途取消时不留半截状态。
 */
export async function importLibraryIndex(
  db: SqliteDatabase,
  options: ImportOptions
): Promise<ImportSummary> {
  const startedAt = Date.now()
  const libraryRoot = resolve(options.libraryRoot)

  if (!existsSync(libraryRoot)) {
    throw new AppError('LIB_PATH_INVALID', `图库目录不存在：${libraryRoot}`)
  }
  if (!existsSync(join(libraryRoot, 'metadata'))) {
    throw new AppError(
      'LIB_PATH_INVALID',
      '这个目录里没有 metadata/，不是本程序建的图库目录（应该包含 originals/ 与 metadata/）'
    )
  }

  const files = listMetadataFiles(libraryRoot)
  const total = files.length
  const failures: string[] = []
  let imported = 0
  let skipped = 0
  let failed = 0
  let cancelled = false

  const now = new Date().toISOString()

  // 第一阶段：并发读说明文件并校验。
  //
  // 图库常常放在网络盘（SMB / WebDAV 挂载）上，小文件一次 50ms 上下；顺序读 6000 份要六分钟。
  // 读这一侧并发化（写仍是单线程、一个事务），耗时掉到十分之一，且不影响写入的原子性。
  const existingOriginals = listExistingOriginals(libraryRoot)
  const records: LibraryRecord[] = []
  // 网络盘上一次往返几十毫秒，单线程读 6000 份要几分钟；读这一侧并发，写仍是单线程一个事务
  const CONCURRENCY = 32
  for (let start = 0; start < files.length; start += CONCURRENCY) {
    if (options.shouldCancel?.()) {
      cancelled = true
      break
    }
    const batch = files.slice(start, start + CONCURRENCY)
    const parsed = await Promise.all(
      batch.map(async (file) => {
        try {
          const text = await readFile(file, 'utf8')
          const result = parseRecord(JSON.parse(text))
          if (!result.ok) {
            return { file, result }
          }
          const { accountKey, gameKey } = result.record
          const present = existingOriginals.get(`${accountKey}/${gameKey}`)
          const fileName = `${result.record.sha256}${result.record.ext}`
          if (!present || !present.has(fileName)) {
            return { file, result: { ok: false as const, reason: '原图缺失' } }
          }
          return { file, result }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return {
            file,
            result: {
              ok: false as const,
              reason: message.includes('ENOENT') ? '原图缺失' : message
            }
          }
        }
      })
    )
    for (const item of parsed) {
      if (!item.result.ok) {
        failed += 1
        if (failures.length < 20) failures.push(`${item.file}：${item.result.reason}`)
        continue
      }
      records.push(item.result.record)
    }
    options.onProgress?.({
      processed: Math.min(start + batch.length, total),
      total,
      currentFile: batch[batch.length - 1] ? batch[batch.length - 1] : null,
      imported,
      failed
    })
  }

  db.transaction(() => {
    const upsertProfile = db.prepare(
      `INSERT INTO profiles (account_key, steam_account_id, steam_id64, account_name, persona_name, updated_at)
       VALUES (?, ?, NULL, NULL, NULL, ?)
       ON CONFLICT(account_key) DO UPDATE SET updated_at = excluded.updated_at`
    )
    const existingNames = new Map<string, { name: string; source: string }>()
    for (const row of db
      .prepare('SELECT game_key AS gameKey, name, name_source AS nameSource FROM games')
      .all() as { gameKey: string; name: string; nameSource: string }[]) {
      existingNames.set(String(row.gameKey), { name: String(row.name), source: String(row.nameSource) })
    }
    const upsertGame = db.prepare(
      `INSERT INTO games (game_key, app_id, kind, name, name_source, installed, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(game_key) DO UPDATE SET
         app_id = COALESCE(excluded.app_id, games.app_id),
         name = excluded.name,
         name_source = excluded.name_source,
         updated_at = excluded.updated_at`
    )
    const findAsset = db.prepare(
      'SELECT asset_id AS assetId FROM assets WHERE account_key = ? AND game_key = ? AND sha256 = ?'
    )
    const insertAsset = db.prepare(
      `INSERT INTO assets (asset_id, account_key, game_key, sha256, bytes, ext, width, height, captured_at, capture_time_source, created_at, original_filename)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const updateAsset = db.prepare(
      `UPDATE assets SET bytes = ?, ext = ?, width = ?, height = ?, captured_at = COALESCE(?, captured_at),
              original_filename = COALESCE(original_filename, ?)
        WHERE asset_id = ?`
    )

    records.forEach((record, index) => {
      upsertProfile.run(record.accountKey, accountIdOf(record.accountKey), now)

      const fallbackName = record.gameName ?? `未知游戏（${record.gameKey}）`
      const existing = existingNames.get(record.gameKey)
      const next = { name: fallbackName, source: record.gameName ? 'library-metadata' : 'fallback' }
      const final = shouldReplaceName(existing, next) ? next : (existing ?? next)
      existingNames.set(record.gameKey, final)
      upsertGame.run(
        record.gameKey,
        appIdOf(record.gameKey),
        gameKind(record.gameKey),
        final.name,
        final.source,
        now
      )

      const known = findAsset.get(record.accountKey, record.gameKey, record.sha256) as
        | { assetId: string }
        | undefined
      const assetId = known ? String(known.assetId) : record.assetId
      if (known) {
        updateAsset.run(
          record.bytes,
          record.ext,
          record.width,
          record.height,
          record.capturedAt,
          record.originalFilename,
          assetId
        )
      } else {
        insertAsset.run(
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
          record.archivedAt ?? now,
          record.originalFilename
        )
      }

      upsertLocalCopy(db, {
        assetId,
        libraryRoot,
        relativePath: record.relativePath,
        bytes: record.bytes,
        sha256: record.sha256,
        verifiedAt: record.archivedAt ?? now
      })
      if (known) skipped += 1
      else imported += 1

      if (index % 500 === 0 || index === records.length - 1) {
        options.onProgress?.({
          processed: total,
          total,
          currentFile: record.originalFilename,
          imported,
          failed
        })
      }
    })
  })

  // 商店名称缓存里如果有这些 AppID，顺手补上名字（纯本地，不联网）
  try {
    completeGameNamesFromCache(db, now)
  } catch {
    // 补名失败不影响导入
  }

  const games = Number(
    (db.prepare('SELECT COUNT(*) AS total FROM games').get() as { total: number }).total
  )
  const accounts = Number(
    (db.prepare('SELECT COUNT(*) AS total FROM profiles').get() as { total: number }).total
  )

  options.onProgress?.({
    processed: total,
    total,
    currentFile: null,
    imported,
    failed
  })

  return {
    libraryRoot,
    scanned: total,
    imported,
    skipped,
    failed,
    games,
    accounts,
    durationMs: Date.now() - startedAt,
    failures: cancelled ? [...failures, '已取消：未处理的条目没有导入'] : failures
  }
}
