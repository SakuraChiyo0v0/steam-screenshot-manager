/**
 * 真机上传验证入口（工具模式）：`--verify-upload=<baseUrl>`。
 *
 * 选项：
 *   --dav-user=<用户名> --dav-pass=<密码>
 *   --library-root=<本地图库根目录>（缺省用设置里的图库目录）
 *   --upload-limit=<n>  只上传前 n 个资产（快速验证）
 *   --force-retry       忽略退避窗口，立刻重试失败项
 *   --library-id=<id>   指定加入已有远端图库
 *
 * 流程：兼容探测 → 新建或加入远端图库 → 上传（上传对象→读回校验→发布记录→读回校验）
 *      → 立刻重跑证明幂等 → 写出 verify-upload.json 供外部核对。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { AppError } from '@shared/errors'
import { checkLibraryRoot } from '@core/settings/library-root'
import { readSettings } from '@core/settings/settings-store'
import {
  buildLibraryDescriptor,
  libraryDescriptorPath,
  libraryRootPath,
  validateLibraryDescriptor
} from '@core/sync/library-remote'
import { isCredentialStorageAvailable, saveCredential } from '@core/sync/credentials'
import { DavClient, probeCapabilities } from '@core/sync/webdav'
import { planUpload, remoteStatusCounts, uploadAssets } from '@core/sync/upload'
import { disposeAppContext, initAppContext } from './app-context'
import { resolveProtectedRoots } from './paths'

const UPLOAD_PREFIX = '--verify-upload='

export function readVerifyUploadTarget(argv: readonly string[]): string | null {
  const matched = argv.find((argument) => argument.startsWith(UPLOAD_PREFIX))
  if (!matched) return null
  const value = matched.slice(UPLOAD_PREFIX.length).trim()
  return value.length > 0 ? value : null
}

function readArg(argv: readonly string[], prefix: string): string | null {
  const matched = argv.find((argument) => argument.startsWith(prefix))
  return matched ? matched.slice(prefix.length).trim() : null
}

export async function runVerifyUpload(baseUrl: string, argv: readonly string[]): Promise<void> {
  try {
    const context = await initAppContext()
    const db = context.database.db

    const username = readArg(argv, '--dav-user=') ?? 'test'
    const password = readArg(argv, '--dav-pass=') ?? 'test'
    const limitRaw = readArg(argv, '--upload-limit=')
    const limit = limitRaw ? Number(limitRaw) : null
    const forceRetry = argv.includes('--force-retry')
    const requestedLibraryId = readArg(argv, '--library-id=')

    if (!isCredentialStorageAvailable()) {
      throw new AppError('APP_INTERNAL', '当前系统无法安全保存凭据，验证中止')
    }

    const settings = readSettings(db)
    const libraryRootArg = readArg(argv, '--library-root=')
    const libraryRoot = resolve(libraryRootArg ?? settings.libraryRoot ?? '')
    if (!libraryRootArg && !settings.libraryRoot) {
      throw new AppError('LIB_PATH_INVALID', '未提供 --library-root，且设置里没有图库目录')
    }
    const rootCheck = checkLibraryRoot({
      candidate: libraryRoot,
      protectedRoots: resolveProtectedRoots(context.paths),
      sourceRoots: []
    })
    if (!rootCheck.ok) {
      throw new AppError('LIB_PATH_INVALID', rootCheck.reason)
    }

    const client = new DavClient({
      baseUrl,
      rootPath: '',
      credential: { username, password }
    })

    const report: Record<string, unknown> = {
      mode: 'verify-upload',
      baseUrl,
      libraryRoot,
      startedAt: new Date().toISOString()
    }

    // 1) 兼容探测（新随机子目录）
    const probe = await probeCapabilities(client, '')
    report['probe'] = probe
    const probeFailed = probe.filter((item) => !item.ok)
    process.stdout.write(
      `[上传] 兼容探测：${probe.length - probeFailed.length}/${probe.length} 通过${
        probeFailed.length > 0 ? `，失败项：${probeFailed.map((item) => item.name).join('、')}` : ''
      }\n`
    )

    // 2) 新建或加入远端图库
    const libraryList = await client.list('steam-gallery-v1')
    let libraryId = requestedLibraryId ?? ''
    let descriptor = null

    for (const href of libraryList.hrefs) {
      const candidateId = href.split('/').filter((segment) => segment.length > 0).pop()
      if (!candidateId || candidateId === 'steam-gallery-v1') continue
      const text = await client.getText(libraryDescriptorPath(candidateId))
      if (!text) continue
      try {
        const validation = validateLibraryDescriptor(JSON.parse(text), candidateId)
        if (validation.ok) {
          libraryId = requestedLibraryId && requestedLibraryId !== candidateId ? libraryId : candidateId
          descriptor = validation.descriptor
          if (!requestedLibraryId) break
        }
      } catch {
        // 单个描述文件损坏不影响其它图库
      }
    }

    if (!libraryId || !descriptor) {
      libraryId = requestedLibraryId ?? randomUUID()
      const createdAt = new Date().toISOString()
      const created = buildLibraryDescriptor(libraryId, createdAt)
      await client.ensureCollection(libraryRootPath(libraryId))
      await client.putText(libraryDescriptorPath(libraryId), `${JSON.stringify(created, null, 2)}\n`)
      const readBack = await client.getText(libraryDescriptorPath(libraryId))
      const validation = validateLibraryDescriptor(readBack ? JSON.parse(readBack) : null, libraryId)
      if (!validation.ok) {
        throw new AppError('APP_INTERNAL', `library.json 读回校验失败：${validation.reason}`)
      }
      descriptor = validation.descriptor
      process.stdout.write(`[上传] 新建远端图库 ${libraryId}\n`)
    } else {
      process.stdout.write(`[上传] 加入已有远端图库 ${libraryId}\n`)
    }

    // 3) 记录远端连接（密码只进 safeStorage）
    const existing = db
      .prepare('SELECT remote_id AS remoteId FROM remotes WHERE base_url = ? AND library_id = ? LIMIT 1')
      .get(baseUrl, libraryId) as { remoteId: string } | undefined
    const remoteId = existing?.remoteId ?? randomUUID()
    if (!existing) {
      db.prepare(
        `INSERT INTO remotes (remote_id, library_id, base_url, root_path, credential_ref, format_version, created_at, last_check_at, last_check_status)
         VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)`
      ).run(
        remoteId,
        libraryId,
        baseUrl,
        remoteId,
        descriptor.schemaVersion,
        new Date().toISOString(),
        new Date().toISOString(),
        probeFailed.length === 0 ? 'ok' : 'partial'
      )
    }
    saveCredential(context.paths.dataDir, remoteId, { username, password })

    report['library'] = { libraryId, remoteId, descriptor }

    // 4) 上传
    const result = await uploadAssets(db, {
      remoteId,
      libraryId,
      deviceId: context.device.deviceId,
      libraryRoot,
      client,
      forceRetry,
      ...(limit !== null && Number.isFinite(limit) ? { maxItems: limit } : {}),
      onProgress: (progress) => {
        if (progress.processed % 100 === 0 && progress.processed > 0) {
          process.stdout.write(
            `[上传] ${progress.processed}/${progress.total} 已校验 ${progress.verified} 失败 ${progress.failed}\n`
          )
        }
      }
    })

    report['uploadRun'] = {
      total: result.total,
      verified: result.verified,
      uploaded: result.uploaded,
      failed: result.failed,
      cancelled: result.cancelled,
      abortedByAuth: result.abortedByAuth,
      durationMs: result.durationMs,
      failures: result.failures.slice(0, 20)
    }
    process.stdout.write(
      `[上传] 完成：计划 ${result.total}，已校验 ${result.verified}（其中新传 ${result.uploaded}），失败 ${result.failed}，耗时 ${(result.durationMs / 1000).toFixed(1)}s\n`
    )

    // 5) 幂等：立刻重跑一次
    const replanned = planUpload(db, {
      remoteId,
      libraryId,
      deviceId: context.device.deviceId,
      libraryRoot
    })
    report['replanAfterRun'] = replanned.length
    const expectedRemaining = limit !== null && Number.isFinite(limit) ? null : 0
    process.stdout.write(
      `[上传] 重跑计划：${replanned.length}${expectedRemaining === 0 ? '（期望 0）' : '（本轮带了 limit，剩余量符合预期）'}\n`
    )

    // 6) 状态统计与对象清单
    report['statusCounts'] = remoteStatusCounts(db, remoteId)
    const verifiedRows = db
      .prepare(
        `SELECT ro.asset_id AS assetId, ro.object_key AS objectKey, ro.record_id AS recordId,
                a.sha256 AS sha256, a.account_key AS accountKey, a.game_key AS gameKey
           FROM remote_objects ro JOIN assets a ON a.asset_id = ro.asset_id
          WHERE ro.remote_id = ? AND ro.publish_status = 'verified'
          ORDER BY ro.object_key`
      )
      .all(remoteId)
    report['verifiedObjects'] = verifiedRows.map((row) => ({
      assetId: String(row.assetId),
      objectKey: String(row.objectKey),
      recordId: String(row.recordId),
      sha256: String(row.sha256),
      accountKey: String(row.accountKey),
      gameKey: String(row.gameKey)
    }))

    if (limit !== null) {
      report['note'] = `本轮带 --upload-limit=${limit}；上面的计划数与限制无关，仅用于快速验证`
    }

    report['finishedAt'] = new Date().toISOString()
    const reportFile = join(context.paths.dataDir, 'verify-upload.json')
    mkdirSync(context.paths.dataDir, { recursive: true })
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(`[上传] 报告已写入 ${reportFile}\n`)

    disposeAppContext()
    app.exit(result.failed > 0 || probeFailed.length > 0 ? 1 : 0)
  } catch (error) {
    const detail = error instanceof Error ? { message: error.message, code: (error as AppError).code } : String(error)
    process.stderr.write(`[上传验证失败] ${JSON.stringify(detail)}\n`)
    app.exit(1)
  }
}
