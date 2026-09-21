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
import { dirname, join } from 'node:path'
import { nativeImage } from 'electron'
import type { SqliteDatabase } from '../db/sqlite'

/** 相册卡片最宽约 400px，按 2 倍屏留余量。 */
export const PREVIEW_MAX_WIDTH = 800
/** 查看器底部缩略图带只有约 86px 高，用更小的尺寸避免几十张 800px 纹理常驻。 */
export const MINI_MAX_WIDTH = 200

export type PreviewSize = 'preview' | 'mini'

const SIZES: Record<PreviewSize, { dir: string; maxWidth: number; quality: number }> = {
  preview: { dir: 'previews', maxWidth: PREVIEW_MAX_WIDTH, quality: 78 },
  mini: { dir: 'minis', maxWidth: MINI_MAX_WIDTH, quality: 76 }
}

export function previewAbsolutePath(
  libraryRoot: string,
  sha256: string,
  size: PreviewSize = 'preview'
): string {
  return join(libraryRoot, 'cache', SIZES[size].dir, `${sha256}.jpg`)
}

export function hasPreview(
  libraryRoot: string,
  sha256: string,
  size: PreviewSize = 'preview'
): boolean {
  return existsSync(previewAbsolutePath(libraryRoot, sha256, size))
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
  libraryRoot: string
  sha256: string
  sourcePath: string
  size?: PreviewSize
}): GeneratePreviewResult | null {
  const size: PreviewSize = input.size ?? 'preview'
  const spec = SIZES[size]
  const target = previewAbsolutePath(input.libraryRoot, input.sha256, size)
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
export function previewStats(libraryRoot: string, size: PreviewSize = 'preview'): PreviewStats {
  const dir = join(libraryRoot, 'cache', SIZES[size].dir)
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

/** 列出还缺预览的资产（来源或图库副本均可作为解码源）。 */
export function planPreviews(
  db: SqliteDatabase,
  libraryRoot: string,
  size: PreviewSize = 'preview'
): PreviewCandidate[] {
  const rows = db
    .prepare(
      `SELECT a.asset_id AS assetId, a.sha256 AS sha256,
              COALESCE(s.root_path, lc.library_root) AS sourceRoot,
              COALESCE(sf.relative_path, lc.relative_path) AS relativePath
         FROM assets a
         JOIN local_copies lc ON lc.asset_id = a.asset_id AND lc.present = 1 AND lc.library_root = ?
         LEFT JOIN source_files sf ON sf.asset_id = a.asset_id AND sf.present = 1
         LEFT JOIN sources s ON s.source_id = sf.source_id
        ORDER BY a.game_key, COALESCE(a.captured_at, ''), a.asset_id`
    )
    .all(libraryRoot) as { assetId: string; sha256: string; sourceRoot: string; relativePath: string }[]

  return rows
    .filter((row) => row.sourceRoot && row.relativePath)
    .map((row) => ({
      assetId: String(row.assetId),
      sha256: String(row.sha256),
      sourceRoot: String(row.sourceRoot),
      relativePath: String(row.relativePath)
    }))
    .filter((candidate) => !hasPreview(libraryRoot, candidate.sha256, size))
}
