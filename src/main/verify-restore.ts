/**
 * 真机恢复验证入口（工具模式）：`--verify-restore=<baseUrl>`。
 *
 * 模拟"新电脑"：使用空白用户数据目录 + 空白本地图库，只靠远端图库把内容恢复回来。
 *
 * 选项：
 *   --dav-user=<用户名> --dav-pass=<密码>
 *   --library-root=<本地图库根目录>（必填，通常是空目录）
 *   --library-id=<远端图库标识>（不给则自动挑选排序后的第一个）
 *   --game-keys=steam-438100,steam-1687950（只恢复这些游戏；不给则全部）
 *
 * 流程：连接（写入 remotes 与加密凭据）→ 读远端清单 → 恢复 → 立刻重跑证明幂等
 *      → 写出 verify-restore.json 供外部核对。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { AppError } from '@shared/errors'
import { checkLibraryRoot } from '@core/settings/library-root'
import { writeSettings } from '@core/settings/settings-store'
import { saveCredential } from '@core/sync/credentials'
import { validateLibraryDescriptor, libraryDescriptorPath } from '@core/sync/library-remote'
import { listRemoteRecords, planRestoreGames, restoreAssets } from '@core/sync/restore'
import { DavClient } from '@core/sync/webdav'
import { disposeAppContext, initAppContext } from './app-context'
import { resolveProtectedRoots } from './paths'

const RESTORE_PREFIX = '--verify-restore='

export function readVerifyRestoreTarget(argv: readonly string[]): string | null {
  const matched = argv.find((argument) => argument.startsWith(RESTORE_PREFIX))
  if (!matched) return null
  const value = matched.slice(RESTORE_PREFIX.length).trim()
  return value.length > 0 ? value : null
}

function readArg(argv: readonly string[], prefix: string): string | null {
  const matched = argv.find((argument) => argument.startsWith(prefix))
  return matched ? matched.slice(prefix.length).trim() : null
}

export async function runVerifyRestore(baseUrl: string, argv: readonly string[]): Promise<void> {
  try {
    const context = await initAppContext()
    const db = context.database.db

    const username = readArg(argv, '--dav-user=') ?? 'test'
    const password = readArg(argv, '--dav-pass=') ?? 'test'
    const libraryRootArg = readArg(argv, '--library-root=')
    if (!libraryRootArg) {
      throw new AppError('LIB_PATH_INVALID', '恢复验证必须提供 --library-root')
    }
    const libraryRoot = resolve(libraryRootArg)
    const requestedLibraryId = readArg(argv, '--library-id=')
    const gameKeysArg = readArg(argv, '--game-keys=')
    const gameKeys = gameKeysArg
      ? gameKeysArg.split(',').map((value) => value.trim()).filter((value) => value.length > 0)
      : undefined

    const rootCheck = checkLibraryRoot({
      candidate: libraryRoot,
      protectedRoots: resolveProtectedRoots(context.paths),
      sourceRoots: []
    })
    if (!rootCheck.ok) {
      throw new AppError('LIB_PATH_INVALID', rootCheck.reason)
    }
    mkdirSync(libraryRoot, { recursive: true })
    writeSettings(db, { libraryRoot })

    const client = new DavClient({
      baseUrl,
      rootPath: '',
      credential: { username, password }
    })

    // 挑选远端图库
    let libraryId = requestedLibraryId ?? ''
    if (!libraryId) {
      const list = await client.list('steam-gallery-v1')
      const candidates = list.hrefs
        .map((href) => href.replace(/\/+$/, '').split('/').pop() ?? '')
        .filter((name) => name.length > 0 && name !== 'steam-gallery-v1')
        .sort()
      for (const candidate of candidates) {
        const text = await client.getText(libraryDescriptorPath(candidate))
        if (text && validateLibraryDescriptor(JSON.parse(text), candidate).ok) {
          libraryId = candidate
          break
        }
      }
    }
    if (!libraryId) {
      throw new AppError('IPC_INVALID_INPUT', '远端没有可用图库')
    }

    // 登记连接与凭据（与界面连接等价）
    const existing = db
      .prepare('SELECT remote_id AS remoteId FROM remotes WHERE base_url = ? AND library_id = ? LIMIT 1')
      .get(baseUrl, libraryId) as { remoteId: string } | undefined
    const remoteId = existing?.remoteId ?? randomUUID()
    const now = new Date().toISOString()
    if (existing) {
      db.prepare(
        "UPDATE remotes SET credential_ref = ?, last_check_at = ?, last_check_status = 'ok' WHERE remote_id = ?"
      ).run(remoteId, now, remoteId)
    } else {
      db.prepare(
        `INSERT INTO remotes (remote_id, library_id, base_url, root_path, credential_ref, format_version, created_at, last_check_at, last_check_status)
         VALUES (?, ?, ?, '', ?, 1, ?, ?, 'ok')`
      ).run(remoteId, libraryId, baseUrl, remoteId, now, now)
    }
    saveCredential(context.paths.dataDir, remoteId, { username, password })

    const report: Record<string, unknown> = {
      mode: 'verify-restore',
      baseUrl,
      libraryId,
      libraryRoot,
      gameKeys: gameKeys ?? null,
      startedAt: now
    }

    // 1) 读远端清单
    const catalog = await listRemoteRecords(client, libraryId)
    const plan = planRestoreGames(db, catalog.records, libraryRoot)
    report['catalog'] = {
      records: catalog.records.length,
      scanned: catalog.scannedRecords,
      invalid: catalog.invalidRecords,
      errors: catalog.errors,
      games: plan
    }
    process.stdout.write(
      `[恢复] 远端清单：${catalog.records.length} 条记录（无效 ${catalog.invalidRecords}），${plan.length} 款游戏\n`
    )

    // 2) 恢复
    const result = await restoreAssets(db, {
      libraryRoot,
      remoteId,
      libraryId,
      client,
      records: catalog.records,
      gameKeys,
      onProgress: (progress) => {
        if (progress.processed % 500 === 0 && progress.processed > 0) {
          process.stdout.write(
            `[恢复] ${progress.processed}/${progress.total} 已恢复 ${progress.restored} 跳过 ${progress.skipped} 失败 ${progress.failed}\n`
          )
        }
      }
    })
    report['restoreRun'] = {
      total: result.total,
      restored: result.restored,
      skipped: result.skipped,
      failed: result.failed,
      cancelled: result.cancelled,
      durationMs: result.durationMs,
      failures: result.failures
    }
    process.stdout.write(
      `[恢复] 完成：计划 ${result.total}，已恢复 ${result.restored}，跳过 ${result.skipped}，失败 ${result.failed}，耗时 ${(result.durationMs / 1000).toFixed(1)}s\n`
    )

    // 3) 幂等：立刻重跑
    const second = await restoreAssets(db, {
      libraryRoot,
      remoteId,
      libraryId,
      client,
      records: catalog.records,
      gameKeys
    })
    report['secondRun'] = {
      total: second.total,
      restored: second.restored,
      skipped: second.skipped,
      failed: second.failed
    }
    process.stdout.write(
      `[恢复] 重跑：计划 ${second.total}，已恢复 ${second.restored}（期望 0），跳过 ${second.skipped}\n`
    )

    // 4) 本地状态
    const assets = db.prepare('SELECT COUNT(*) AS n FROM assets').get() as { n: number }
    const copies = db
      .prepare('SELECT COUNT(*) AS n FROM local_copies WHERE present = 1 AND library_root = ?')
      .get(libraryRoot) as { n: number }
    const sources = db.prepare('SELECT COUNT(*) AS n FROM source_files').get() as { n: number }
    report['localState'] = {
      assets: assets.n,
      localCopies: copies.n,
      sourceFiles: sources.n,
      libraryRoot
    }
    report['restoredItems'] = db
      .prepare(
        `SELECT a.asset_id AS assetId, a.account_key AS accountKey, a.game_key AS gameKey, a.sha256 AS sha256,
                a.original_filename AS originalFilename, lc.relative_path AS relativePath
           FROM local_copies lc JOIN assets a ON a.asset_id = lc.asset_id
          WHERE lc.present = 1 AND lc.library_root = ?
          ORDER BY lc.relative_path`
      )
      .all(libraryRoot)
      .map((row) => ({
        assetId: String(row.assetId),
        accountKey: String(row.accountKey),
        gameKey: String(row.gameKey),
        sha256: String(row.sha256),
        originalFilename: String(row.originalFilename ?? ''),
        relativePath: String(row.relativePath)
      }))

    report['finishedAt'] = new Date().toISOString()
    const reportFile = join(context.paths.dataDir, 'verify-restore.json')
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(`[恢复] 报告已写入 ${reportFile}\n`)
    process.stdout.write(
      `[恢复] 本地状态：资产 ${assets.n}，受管副本 ${copies.n}，来源文件行 ${sources.n}（恢复不依赖来源）\n`
    )

    disposeAppContext()
    app.exit(result.failed > 0 ? 1 : 0)
  } catch (error) {
    const detail =
      error instanceof Error
        ? { message: error.message, code: (error as AppError).code }
        : String(error)
    process.stderr.write(`[恢复验证失败] ${JSON.stringify(detail)}\n`)
    app.exit(1)
  }
}
