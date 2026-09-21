/**
 * 预览缓存：为图库资产生成中等尺寸 JPEG，供相册网格与缩略图带使用。
 *
 * 为什么需要：
 * - Steam 自带缩略图只有约 200px，放大到卡片尺寸会发虚；
 * - 直接使用 4K 原图解码成本高（一张 2560×1440 解码约数十 MB 内存），大量图片浏览会卡；
 * - 恢复出来的图库没有来源缩略图，只能用原图。
 *
 * 实现用 Electron 内置的 nativeImage（零新增依赖），产物放在图库根下
 * `cache/previews/<sha256>.jpg`：可随时重建、不参与备份上传（上传只走 originals/）。
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { nativeImage } from 'electron'
import type { SqliteDatabase } from '../db/sqlite'

/** 相册卡片最宽约 400px，按 2 倍屏留余量（800 恰好够 2 倍屏，留到 1000 更稳，体积仍远小于原图）。 */
export const PREVIEW_MAX_WIDTH = 1000
/** 查看器底部缩略图带只有约 86px 高，用更小的尺寸避免几十张 800px 纹理常驻。 */
export const MINI_MAX_WIDTH = 200

export type PreviewSize = 'preview' | 'mini'

const SIZES: Record<PreviewSize, { dir: string; maxWidth: number; quality: number }> = {
  preview: { dir: 'previews', maxWidth: PREVIEW_MAX_WIDTH, quality: 78 },
  mini: { dir: 'minis', maxWidth: MINI_MAX_WIDTH, quality: 76 }
}

/** 没有图库目录时，预览缓存放在用户数据目录下的这个子目录。 */
export const PREVIEW_CACHE_DIR = 'preview-cache'

/**
 * 解析预览缓存的根目录。
 *
 * - 设了图库：放图库的 `cache/`，跟着图库走，整库迁移时预览一起带走；
 * - 没设图库：放用户数据目录，保证任何 profile 都能有预览，
 *   不需要用户先建图库（否则"优先原图"就只能一直解码 4K 原图）。
 */
export function resolvePreviewCacheRoot(input: {
  libraryRoot: string
  userDataRoot: string
}): string {
  const libraryRoot = input.libraryRoot.trim()
  return libraryRoot.length > 0
    ? join(resolve(libraryRoot), 'cache')
    : join(resolve(input.userDataRoot), PREVIEW_CACHE_DIR)
}

export function previewAbsolutePath(
  cacheRoot: string,
  sha256: string,
  size: PreviewSize = 'preview'
): string {
  return join(resolve(cacheRoot), SIZES[size].dir, `${sha256}.jpg`)
}

export function hasPreview(
  cacheRoot: string,
  sha256: string,
  size: PreviewSize = 'preview'
): boolean {
  return existsSync(previewAbsolutePath(cacheRoot, sha256, size))
}

export interface GeneratePreviewResult {
  readonly created: boolean
  readonly bytes: number
  readonly width: number
  readonly height: number
}

/**
 * 生成一张预览。已有则直接返回；源文件无法解码时返回 null（由调用方回退原图）。
 * 注意：nativeImage 的解码是同步的，单张约几十毫秒，调用方应限速。
 */
export function generatePreview(input: {
  cacheRoot: string
  sha256: string
  sourcePath: string
  size?: PreviewSize
}): GeneratePreviewResult | null {
  const size: PreviewSize = input.size ?? 'preview'
  const spec = SIZES[size]
  const target = previewAbsolutePath(input.cacheRoot, input.sha256, size)
  if (existsSync(target)) {
    const info = statSync(target)
    return { created: false, bytes: info.size, width: spec.maxWidth, height: 0 }
  }

  let image
  try {
    image = nativeImage.createFromPath(input.sourcePath)
  } catch {
    return null
  }
  if (image.isEmpty()) {
    return null
  }

  const imageSize = image.getSize()
  const resized =
    imageSize.width > spec.maxWidth
      ? image.resize({ width: spec.maxWidth, quality: 'good' })
      : image
  const jpeg = resized.toJPEG(spec.quality)
  if (jpeg.length === 0) {
    return null
  }

  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, jpeg)
  try {
    renameSync(temporary, target)
  } catch {
    rmSync(temporary, { force: true })
    if (!existsSync(target)) {
      return null
    }
  }

  const finalSize = resized.getSize()
  return { created: true, bytes: jpeg.length, width: finalSize.width, height: finalSize.height }
}

export interface PreviewStats {
  readonly count: number
  readonly bytes: number
}

/** 预览缓存现状，供设置页显示。 */
export function previewStats(cacheRoot: string, size: PreviewSize = 'preview'): PreviewStats {
  const dir = join(resolve(cacheRoot), SIZES[size].dir)
  if (!existsSync(dir)) {
    return { count: 0, bytes: 0 }
  }
  let count = 0
  let bytes = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jpg')) {
      continue
    }
    count += 1
    try {
      bytes += statSync(join(dir, entry.name)).size
    } catch {
      /* 单个文件读不到不影响统计 */
    }
  }
  return { count, bytes }
}

export interface PreviewCandidate {
  readonly assetId: string
  readonly sha256: string
  readonly sourceRoot: string
  readonly relativePath: string
}

/**
 * 列出还缺预览的资产。
 *
 * 解码源可以是图库副本，也可以是来源目录里的原件：没有归档过图库的用户
 * 同样需要预览（否则浏览时只能一直解码 4K 原图）。
 */
export function planPreviews(
  db: SqliteDatabase,
  cacheRoot: string,
  size: PreviewSize = 'preview'
): PreviewCandidate[] {
  const rows = db
    .prepare(
      `SELECT a.asset_id AS assetId, a.sha256 AS sha256,
              COALESCE(lc.library_root, s.root_path) AS sourceRoot,
              COALESCE(lc.relative_path, sf.relative_path) AS relativePath
         FROM assets a
         LEFT JOIN local_copies lc ON lc.asset_id = a.asset_id AND lc.present = 1
         LEFT JOIN source_files sf ON sf.asset_id = a.asset_id AND sf.present = 1
         LEFT JOIN sources s ON s.source_id = sf.source_id
        WHERE lc.local_copy_id IS NOT NULL
           OR (sf.source_file_id IS NOT NULL AND s.root_path IS NOT NULL)
        GROUP BY a.asset_id
        ORDER BY a.game_key, COALESCE(a.captured_at, ''), a.asset_id`
    )
    .all() as { assetId: string; sha256: string; sourceRoot: string; relativePath: string }[]

  return rows
    .filter((row) => row.sourceRoot && row.relativePath)
    .map((row) => ({
      assetId: String(row.assetId),
      sha256: String(row.sha256),
      sourceRoot: String(row.sourceRoot),
      relativePath: String(row.relativePath)
    }))
    .filter((candidate) => !hasPreview(cacheRoot, candidate.sha256, size))
}
