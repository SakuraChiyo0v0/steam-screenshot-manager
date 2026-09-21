/**
 * 导出：按规则把图库副本（优先）或来源原件复制到用户选择的目录。
 *
 * 规则（docs/product-plan.md FR-07、docs/architecture.md §5）：
 * - 支持按游戏名、AppID、年份组织目录；
 * - 遵守 Windows 命名限制：非法字符、保留名、结尾点/空格、总长度；
 * - 冲突保留两份，绝不覆盖：目标已存在且内容相同则跳过，不同则追加指纹短码；
 * - 复制后重新计算目标文件哈希并与索引指纹核对（复制后校验一致）。
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { AppError } from '@shared/errors'
import { isInsideRoot } from './asset-paths'
import type { SqliteDatabase } from '../db/sqlite'

export type ExportLayout = 'game' | 'game-year' | 'game-appid' | 'flat'

export interface ExportOptions {
  readonly targetDir: string
  readonly layout: ExportLayout
  /** 优先使用该图库下的受管副本；为空或副本缺失时回退来源原件 */
  readonly libraryRoot?: string | null
  readonly gameKeys?: readonly string[]
  readonly assetIds?: readonly string[]
  readonly onProgress?: (progress: ExportProgress) => void
  readonly shouldCancel?: () => boolean
}

export interface ExportProgress {
  readonly processed: number
  readonly total: number | null
  readonly currentFile: string | null
  readonly written: number
  readonly skipped: number
  readonly failed: number
}

export interface ExportFailure {
  readonly assetId: string
  readonly target: string
  readonly message: string
}

export interface ExportResult {
  readonly targetDir: string
  readonly total: number
  readonly written: number
  readonly skipped: number
  readonly failed: number
  readonly cancelled: boolean
  readonly conflictsRenamed: number
  readonly failures: readonly ExportFailure[]
  readonly durationMs: number
}

export interface ExportItem {
  readonly assetId: string
  readonly gameKey: string
  readonly gameName: string
  readonly appId: string | null
  readonly sha256: string
  readonly bytes: number
  readonly originalFilename: string
  readonly capturedAt: string | null
  readonly sourceRoot: string
  readonly sourceRelativePath: string
  readonly libraryRelativePath: string | null
  readonly libraryRoot: string | null
}

/** Windows 保留名（大小写不敏感，含带扩展名的形式）。 */
const RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9'
])

const MAX_SEGMENT_LENGTH = 64
const MAX_RELATIVE_LENGTH = 180

/** 规范化单个路径片段：去掉 Windows 非法字符、结尾点与空格，处理保留名。 */
export function sanitizeSegment(raw: string, maxLength = MAX_SEGMENT_LENGTH): string {
  const replaced = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')

  const safe = replaced.length === 0 ? 'unknown' : replaced
  const withoutExtension = safe.split('.')[0]!.toUpperCase()
  const prefixed = RESERVED_NAMES.has(withoutExtension) ? `_${safe}` : safe

  if (prefixed.length <= maxLength) {
    return prefixed
  }
  const extension = extname(prefixed)
  const base = prefixed.slice(0, prefixed.length - extension.length)
  return `${base.slice(0, Math.max(1, maxLength - extension.length))}${extension}`
}

function yearOf(capturedAt: string | null): string {
  if (!capturedAt) {
    return '时间未知'
  }
  const match = /^(\d{4})/.exec(capturedAt)
  return match ? match[1]! : '时间未知'
}

/** 导出相对路径：按布局规则拼装，并保证总长度可控。 */
export function buildExportRelativePath(item: ExportItem, layout: ExportLayout): string {
  const gameFolder = sanitizeSegment(item.gameName.length > 0 ? item.gameName : item.gameKey)
  const appIdFolder = sanitizeSegment(`${item.gameName} (${item.appId ?? item.gameKey})`)
  const extension = extname(item.originalFilename)
  const baseName = item.originalFilename.slice(
    0,
    item.originalFilename.length - extension.length
  )
  const fileSegment = sanitizeSegment(baseName) + sanitizeSegment(extension, 10).replace(/^_/, '')

  const segments: string[] = []
  if (layout === 'game' || layout === 'game-year') {
    segments.push(gameFolder)
  } else if (layout === 'game-appid') {
    segments.push(appIdFolder)
  }
  if (layout === 'game-year') {
    segments.push(yearOf(item.capturedAt))
  }
  segments.push(fileSegment)

  // 每段都已截断到 MAX_SEGMENT_LENGTH，因此总长度有界（≤ 3 段 × 64 + 分隔符），
  // 不需要再叠一层"整体超长"的分支。
  const relativePath = segments.join('/')
  if (relativePath.length > MAX_RELATIVE_LENGTH) {
    throw new AppError('LIB_PATH_INVALID', '导出路径超出预期长度')
  }
  return relativePath
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 })
  for await (const chunk of stream) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

function baseNameOf(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

/** 导出清单：优先受管副本，缺失时回退来源原件。 */
export function planExport(db: SqliteDatabase, options: ExportOptions): ExportItem[] {
  const conditions: string[] = []
  const params: (string | number | null)[] = [options.libraryRoot ? resolve(options.libraryRoot) : null]

  if (options.gameKeys && options.gameKeys.length > 0) {
    conditions.push(`a.game_key IN (${options.gameKeys.map(() => '?').join(', ')})`)
    params.push(...options.gameKeys)
  }
  if (options.assetIds && options.assetIds.length > 0) {
    conditions.push(`a.asset_id IN (${options.assetIds.map(() => '?').join(', ')})`)
    params.push(...options.assetIds)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = db
    .prepare(
      `SELECT
         a.asset_id            AS assetId,
         a.game_key            AS gameKey,
         g.name                AS gameName,
         g.app_id              AS appId,
         a.sha256              AS sha256,
         a.bytes               AS bytes,
         a.captured_at         AS capturedAt,
         s.root_path           AS sourceRoot,
         sf.relative_path      AS sourceRelativePath,
         lc.relative_path      AS libraryRelativePath,
         lc.library_root       AS libraryRoot
       FROM assets a
       JOIN games g ON g.game_key = a.game_key
       LEFT JOIN local_copies lc
              ON lc.asset_id = a.asset_id AND lc.present = 1 AND lc.library_root = ?
       JOIN source_files sf
              ON sf.source_file_id = (
                   SELECT sf2.source_file_id FROM source_files sf2
                    WHERE sf2.asset_id = a.asset_id AND sf2.present = 1
                    ORDER BY sf2.last_seen_at DESC, sf2.relative_path
                    LIMIT 1
                 )
       JOIN sources s ON s.source_id = sf.source_id
       ${where}
       ORDER BY a.game_key, COALESCE(a.captured_at, ''), a.asset_id`
    )
    .all(...params)

  return rows.map((row) => ({
    assetId: String(row.assetId),
    gameKey: String(row.gameKey),
    gameName: String(row.gameName),
    appId: row.appId === null || row.appId === undefined ? null : String(row.appId),
    sha256: String(row.sha256),
    bytes: Number(row.bytes),
    originalFilename: baseNameOf(String(row.sourceRelativePath)),
    capturedAt: row.capturedAt === null ? null : String(row.capturedAt),
    sourceRoot: String(row.sourceRoot),
    sourceRelativePath: String(row.sourceRelativePath),
    libraryRelativePath:
      row.libraryRelativePath === null || row.libraryRelativePath === undefined
        ? null
        : String(row.libraryRelativePath),
    libraryRoot:
      row.libraryRoot === null || row.libraryRoot === undefined ? null : String(row.libraryRoot)
  }))
}

/** 在冲突时生成保留两份的目标名：追加指纹短码，必要时再追加序号。 */
function resolveConflictPath(targetPath: string, sha256: string): string | null {
  const extension = extname(targetPath)
  const base = targetPath.slice(0, targetPath.length - extension.length)
  const candidates = [`${base}_${sha256.slice(0, 8)}${extension}`]
  for (let index = 2; index <= 5; index += 1) {
    candidates.push(`${base}_${sha256.slice(0, 8)}_${index}${extension}`)
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

export async function exportAssets(
  db: SqliteDatabase,
  options: ExportOptions
): Promise<ExportResult> {
  const startedAt = Date.now()
  const targetDir = resolve(options.targetDir)
  const items = planExport(db, options)
  const failures: ExportFailure[] = []
  let written = 0
  let skipped = 0
  let conflictsRenamed = 0

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!
    if (options.shouldCancel?.()) {
      return {
        targetDir,
        total: items.length,
        written,
        skipped,
        failed: failures.length,
        cancelled: true,
        conflictsRenamed,
        failures,
        durationMs: Date.now() - startedAt
      }
    }

    let targetPath = join(targetDir, buildExportRelativePath(item, options.layout))
    if (!isInsideRoot(targetDir, targetPath)) {
      failures.push({ assetId: item.assetId, target: targetPath, message: '导出路径越出目标目录' })
      continue
    }

    try {
      // 优先使用图库受管副本：来源可能已经不可用
      let sourcePath: string | null = null
      if (item.libraryRoot && item.libraryRelativePath) {
        const candidate = join(item.libraryRoot, item.libraryRelativePath)
        if (isInsideRoot(item.libraryRoot, candidate) && existsSync(candidate)) {
          sourcePath = candidate
        }
      }
      if (!sourcePath) {
        const candidate = join(item.sourceRoot, item.sourceRelativePath)
        if (isInsideRoot(item.sourceRoot, candidate) && existsSync(candidate)) {
          sourcePath = candidate
        }
      }
      if (!sourcePath) {
        throw new AppError('SRC_NOT_FOUND', '图库副本与来源原件都不可用')
      }

      if (existsSync(targetPath)) {
        const existingHash = await hashFile(targetPath)
        if (existingHash === item.sha256) {
          skipped += 1
          continue
        }
        const renamed = resolveConflictPath(targetPath, item.sha256)
        if (!renamed) {
          throw new AppError('LIB_PATH_INVALID', '同名冲突已存在多份，无法再保留新副本')
        }
        targetPath = renamed
        conflictsRenamed += 1
      }

      mkdirSync(dirname(targetPath), { recursive: true })
      copyFileSync(sourcePath, targetPath)

      // 复制后校验：不一致就删除刚写入的文件，不留半成品
      const copiedHash = await hashFile(targetPath)
      if (copiedHash !== item.sha256) {
        rmSync(targetPath, { force: true })
        throw new AppError('LIB_HASH_MISMATCH', '导出后校验不一致')
      }
      written += 1
    } catch (error) {
      failures.push({
        assetId: item.assetId,
        target: targetPath,
        message: error instanceof Error ? error.message : String(error)
      })
    }

    options.onProgress?.({
      processed: index + 1,
      total: items.length,
      currentFile: item.originalFilename,
      written,
      skipped,
      failed: failures.length
    })
  }

  return {
    targetDir,
    total: items.length,
    written,
    skipped,
    failed: failures.length,
    cancelled: false,
    conflictsRenamed,
    failures,
    durationMs: Date.now() - startedAt
  }
}

/** 统计导出目录里的文件数，供验证脚本核对。 */
export function countFilesRecursively(dir: string): number {
  if (!existsSync(dir)) {
    return 0
  }
  let count = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      count += countFilesRecursively(join(dir, entry.name))
    } else if (entry.isFile()) {
      count += 1
    }
  }
  return count
}
