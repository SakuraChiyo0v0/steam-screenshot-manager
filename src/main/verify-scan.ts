/**
 * 真机扫描验证入口（`--verify-scan=<目录>`）。
 *
 * 用途：在没有界面交互的情况下对真实数据跑完整的"登记来源 → 扫描 → 入库"链路，
 * 并把逻辑资产清单写成 JSON，便于与外部哈希基准逐条对账。
 *
 * 与 `--self-check` 一样，这是验证工具而不是产品功能：不创建窗口、不复制任何文件，
 * 来源目录全程只读。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { validateManualRoot } from '@core/steam/discovery'
import { scanSource } from '@core/steam/scanner'
import {
  findSourceByRoot,
  insertSource,
  loadKnownHashes,
  markSourceScan,
  writeScanOutcome
} from '@core/library/index-writer'
import { libraryStats } from '@core/library/queries'
import { listAssetIdentities } from '@core/library/verification'
import { disposeAppContext, initAppContext } from './app-context'

const FLAG_PREFIX = '--verify-scan='

export function readVerifyScanTarget(argv: readonly string[]): string | null {
  const matched = argv.find((argument) => argument.startsWith(FLAG_PREFIX))
  if (!matched) {
    return null
  }
  const value = matched.slice(FLAG_PREFIX.length)
  return value.trim().length > 0 ? value.trim() : null
}

export async function runVerifyScan(target: string): Promise<void> {
  const startedAt = Date.now()

  try {
    const context = await initAppContext()
    const rootPath = validateManualRoot(target)

    let source = findSourceByRoot(context.database.db, rootPath)
    if (!source) {
      insertSource(context.database.db, {
        sourceId: randomUUID(),
        rootPath,
        kind: 'manual',
        createdAt: new Date().toISOString()
      })
      source = findSourceByRoot(context.database.db, rootPath)
    }
    if (!source) {
      throw new Error('来源登记失败')
    }

    process.stdout.write(`[验证] 来源根：${rootPath}\n`)

    const knownHashes = loadKnownHashes(context.database.db, source.sourceId)
    process.stdout.write(`[验证] 已可复用哈希：${knownHashes.size}\n`)

    const scanStartedAt = Date.now()
    const outcome = await scanSource({
      rootPath,
      sourceId: source.sourceId,
      accountIds: [],
      knownHashes,
      onProgress: (progress) => {
        if (progress.phase === 'hashing' && progress.processed % 1000 === 0) {
          process.stdout.write(
            `[验证] 已处理 ${progress.processed}${progress.total === null ? '' : ` / ${progress.total}`}\n`
          )
        }
      }
    })
    const scanDurationMs = Date.now() - scanStartedAt

    const seenAt = new Date().toISOString()
    const written = writeScanOutcome(context.database.db, {
      sourceId: source.sourceId,
      outcome,
      seenAt
    })
    markSourceScan(context.database.db, {
      sourceId: source.sourceId,
      status: outcome.failures.length > 0 ? 'partial' : 'ok',
      error: outcome.failures.length > 0 ? `${outcome.failures.length} 个文件读取失败` : null,
      at: seenAt
    })

    const stats = libraryStats(context.database.db)
    const assets = listAssetIdentities(context.database.db)

    const report = {
      mode: 'verify-scan',
      target: rootPath,
      sourceId: source.sourceId,
      scannedAccounts: outcome.scannedAccounts,
      games: outcome.games.length,
      scanDurationMs,
      totalDurationMs: Date.now() - startedAt,
      sourceFilesWritten: written.sourceFiles,
      createdAssets: written.assets,
      missingMarked: written.missingMarked,
      failures: outcome.failures,
      cancelled: outcome.cancelled,
      stats,
      assets
    }

    const reportFile = join(context.paths.dataDir, 'verify-scan.json')
    mkdirSync(context.paths.dataDir, { recursive: true })
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

    process.stdout.write(
      [
        '[验证] 完成',
        `账号 ${outcome.scannedAccounts.length}`,
        `游戏 ${outcome.games.length}`,
        `来源文件 ${written.sourceFiles}`,
        `新增资产 ${written.assets}`,
        `失败 ${outcome.failures.length}`,
        `扫描耗时 ${(scanDurationMs / 1000).toFixed(1)} 秒`,
        `报告 ${reportFile}`
      ].join('　') + '\n'
    )

    disposeAppContext()
    app.exit(outcome.failures.length > 0 ? 1 : 0)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[验证失败] ${detail}\n`)
    app.exit(1)
  }
}
