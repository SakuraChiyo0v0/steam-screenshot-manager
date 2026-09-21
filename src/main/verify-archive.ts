/**
 * 真机归档验证入口（工具模式）。
 *
 * `--verify-archive=<图库根>`：
 *   1. 可选：先按 `--cancel-after=<n>` 模拟一次中断（只处理 n 项就取消），证明中断后已完成的成果保留；
 *   2. 再完整归档一次，产出计数；
 *   3. 立刻重跑一次，证明幂等（计划应为 0）；
 *   4. 对账（受管文件缺失标记 + staging 清理）；
 *   5. 导出一个游戏到图库同级目录，产出计数与冲突数；
 *   6. 把可核对的清单写入用户数据目录的 verify-archive.json。
 *
 * 只读取来源，写入图库与导出目录；不删除任何来源文件。
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { archiveAssets, localCopyState, reconcileLibrary } from '@core/library/archive'
import { exportAssets, countFilesRecursively } from '@core/library/export'
import { disposeAppContext, initAppContext } from './app-context'

const ARCHIVE_PREFIX = '--verify-archive='
const CANCEL_PREFIX = '--cancel-after='

export function readVerifyArchiveTarget(argv: readonly string[]): string | null {
  const matched = argv.find((argument) => argument.startsWith(ARCHIVE_PREFIX))
  if (!matched) {
    return null
  }
  const value = matched.slice(ARCHIVE_PREFIX.length).trim()
  return value.length > 0 ? value : null
}

function readCancelAfter(argv: readonly string[]): number | null {
  const matched = argv.find((argument) => argument.startsWith(CANCEL_PREFIX))
  if (!matched) {
    return null
  }
  const value = Number(matched.slice(CANCEL_PREFIX.length))
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

/** 统计 originals 下的实际文件数（不读数据库，用于核对副本数量）。 */
function countManagedFiles(libraryRoot: string): number {
  const originalsDir = join(libraryRoot, 'originals')
  let files = 0
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        files += 1
      }
    }
  }
  walk(originalsDir)
  return files
}

export async function runVerifyArchive(
  target: string,
  argv: readonly string[]
): Promise<void> {
  const libraryRoot = resolve(target)
  const cancelAfter = readCancelAfter(argv)

  try {
    const context = await initAppContext()
    const db = context.database.db
    mkdirSync(libraryRoot, { recursive: true })

    const report: Record<string, unknown> = {
      mode: 'verify-archive',
      libraryRoot,
      startedAt: new Date().toISOString()
    }

    // 1) 可选：模拟中断
    if (cancelAfter !== null) {
      let processed = 0
      const interrupted = await archiveAssets(db, {
        libraryRoot,
        onProgress: (progress) => {
          processed = progress.processed
        },
        shouldCancel: () => processed >= cancelAfter
      })
      report['interruptedRun'] = {
        cancelAfter,
        cancelled: interrupted.cancelled,
        copied: interrupted.copied,
        skipped: interrupted.skipped,
        failed: interrupted.failed
      }
      process.stdout.write(
        `[归档] 模拟中断：已处理 ${interrupted.copied + interrupted.skipped}，取消=${interrupted.cancelled}\n`
      )
    }

    // 2) 完整归档
    const archiveStartedAt = Date.now()
    const archive = await archiveAssets(db, {
      libraryRoot,
      onProgress: (progress) => {
        if (progress.processed % 1000 === 0) {
          process.stdout.write(`[归档] ${progress.processed}/${progress.total ?? '?'}\n`)
        }
      }
    })
    report['archiveRun'] = {
      total: archive.total,
      copied: archive.copied,
      skipped: archive.skipped,
      failed: archive.failed,
      cancelled: archive.cancelled,
      durationMs: archive.durationMs,
      failures: archive.failures.slice(0, 20)
    }
    process.stdout.write(
      `[归档] 完成：计划 ${archive.total}，新复制 ${archive.copied}，已存在 ${archive.skipped}，失败 ${archive.failed}，耗时 ${(archive.durationMs / 1000).toFixed(1)}s\n`
    )

    // 3) 幂等：立刻重跑，计划应为 0
    const secondRun = await archiveAssets(db, { libraryRoot })
    report['idempotentRun'] = {
      total: secondRun.total,
      copied: secondRun.copied,
      skipped: secondRun.skipped,
      failed: secondRun.failed
    }
    process.stdout.write(
      `[归档] 重跑：计划 ${secondRun.total}，新复制 ${secondRun.copied}（期望 0）\n`
    )

    // 4) 对账
    const reconciled = reconcileLibrary(db, libraryRoot)
    report['reconcile'] = reconciled
    report['localCopyState'] = localCopyState(db, libraryRoot)
    report['managedFilesOnDisk'] = countManagedFiles(libraryRoot)

    const assets = db
      .prepare(
        `SELECT lc.asset_id AS assetId, lc.relative_path AS relativePath, lc.sha256 AS sha256, lc.present AS present,
                a.account_key AS accountKey, a.game_key AS gameKey, a.bytes AS bytes
           FROM local_copies lc JOIN assets a ON a.asset_id = lc.asset_id
          WHERE lc.library_root = ?
          ORDER BY lc.relative_path`
      )
      .all(libraryRoot)
    report['copies'] = assets.map((row) => ({
      assetId: String(row.assetId),
      accountKey: String(row.accountKey),
      gameKey: String(row.gameKey),
      sha256: String(row.sha256),
      present: Number(row.present) === 1,
      relativePath: String(row.relativePath)
    }))
    report['managedBytes'] = Number(
      (
        db
          .prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM local_copies WHERE library_root = ?')
          .get(libraryRoot) as { total: number }
      ).total
    )

    // 5) 导出一个游戏（取副本最多的那个，覆盖多条路径规则中的年份分支）
    const busiest = db
      .prepare(
        `SELECT a.game_key AS gameKey, COUNT(*) AS total
           FROM local_copies lc JOIN assets a ON a.asset_id = lc.asset_id
          WHERE lc.library_root = ?
          GROUP BY a.game_key ORDER BY total DESC LIMIT 1`
      )
      .get(libraryRoot) as { gameKey: string; total: number } | undefined

    if (busiest) {
      const exportDir = `${libraryRoot}-export`
      mkdirSync(exportDir, { recursive: true })
      const exported = await exportAssets(db, {
        targetDir: exportDir,
        layout: 'game-year',
        libraryRoot,
        gameKeys: [busiest.gameKey]
      })
      report['export'] = {
        targetDir: exportDir,
        gameKey: busiest.gameKey,
        expected: busiest.total,
        total: exported.total,
        written: exported.written,
        skipped: exported.skipped,
        failed: exported.failed,
        conflictsRenamed: exported.conflictsRenamed,
        durationMs: exported.durationMs,
        fileCount: countFilesRecursively(exportDir)
      }
      process.stdout.write(
        `[导出] ${busiest.gameKey}：应导 ${busiest.total}，实写 ${exported.written}，跳过 ${exported.skipped}，失败 ${exported.failed}，文件数 ${countFilesRecursively(exportDir)}\n`
      )
    }

    report['finishedAt'] = new Date().toISOString()
    report['totalDurationMs'] = Date.now() - archiveStartedAt

    const reportFile = join(context.paths.dataDir, 'verify-archive.json')
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(`[归档] 报告已写入 ${reportFile}\n`)

    disposeAppContext()
    app.exit(archive.failed > 0 ? 1 : 0)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[归档验证失败] ${detail}\n`)
    app.exit(1)
  }
}
