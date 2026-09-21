/**
 * 批量生成预览缓存（工具模式）：`--build-previews=<图库根目录>`。
 *
 * 用途：图库已有很多图时，先把预览补好，之后浏览就不用解码 4K 原图。
 * 输出计数、总体积与耗时，供性能核对。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { AppError } from '@shared/errors'
import { resolveExistingAssetPath } from '@core/library/asset-paths'
import { generatePreview, planPreviews, previewStats } from '@core/library/previews'
import { disposeAppContext, initAppContext } from './app-context'

const PREFIX = '--build-previews='

export function readBuildPreviewsTarget(argv: readonly string[]): string | null {
  const matched = argv.find((argument) => argument.startsWith(PREFIX))
  if (!matched) return null
  const value = matched.slice(PREFIX.length).trim()
  return value.length > 0 ? value : null
}

export async function runBuildPreviews(target: string, mini = false): Promise<void> {
  try {
    const context = await initAppContext()
    const libraryRoot = resolve(target)
    if (!existsSync(libraryRoot)) {
      throw new AppError('LIB_PATH_INVALID', `图库目录不存在：${libraryRoot}`)
    }
    mkdirSync(join(libraryRoot, 'cache', 'previews'), { recursive: true })
    const cacheRoot = join(libraryRoot, 'cache')

    const size = mini ? ('mini' as const) : ('preview' as const)
    const candidates = planPreviews(context.database.db, cacheRoot, size)
    process.stdout.write(`[预览] 待生成 ${candidates.length} 张\n`)

    let created = 0
    let failed = 0
    let bytes = 0
    const startedAt = Date.now()

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!
      try {
        const sourcePath = await resolveExistingAssetPath(candidate.sourceRoot, candidate.relativePath)
        const result = generatePreview({
          cacheRoot,
          sha256: candidate.sha256,
          sourcePath,
          size
        })
        if (result) {
          if (result.created) {
            created += 1
            bytes += result.bytes
          }
        } else {
          failed += 1
        }
      } catch {
        failed += 1
      }

      if ((index + 1) % 500 === 0) {
        process.stdout.write(`[预览] ${index + 1}/${candidates.length}\n`)
      }
      // 让出事件循环，避免长时间占满主进程
      await new Promise((resolveTick) => setImmediate(resolveTick))
    }

    const durationMs = Date.now() - startedAt
    const stats = previewStats(cacheRoot, size)
    const report = {
      mode: 'build-previews',
      libraryRoot,
      planned: candidates.length,
      created,
      failed,
      newBytes: bytes,
      durationMs,
      total: stats.count,
      totalBytes: stats.bytes
    }
    const reportFile = join(context.paths.dataDir, 'build-previews.json')
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

    process.stdout.write(
      `[预览] 完成：新建 ${created}，失败 ${failed}，耗时 ${(durationMs / 1000).toFixed(1)}s；` +
        `缓存共 ${stats.count} 张 / ${(stats.bytes / 1024 / 1024).toFixed(1)} MB\n` +
        `[预览] 报告已写入 ${reportFile}\n`
    )

    disposeAppContext()
    app.exit(failed > 0 ? 1 : 0)
  } catch (error) {
    const detail =
      error instanceof Error
        ? { message: error.message, code: (error as AppError).code }
        : String(error)
    process.stderr.write(`[预览生成失败] ${JSON.stringify(detail)}\n`)
    app.exit(1)
  }
}
