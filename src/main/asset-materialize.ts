/**
 * 按需取回：本机没有这张原图时，从备份地址下载到内部缓存再给界面用。
 *
 * 场景：换电脑/清理过本地副本后，索引里还有这张图，但文件只在备份里。
 * 以前这种情况界面直接显示「原图不可用」；现在第一次请求时自动取回并登记副本。
 * 只下载这一张，不整库拉取；并发请求同一个 assetId 会合并成一次下载。
 */
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AppError } from '@shared/errors'
import { upsertLocalCopy } from '@core/library/archive'
import { managedRelativePath } from '@core/library/archive'
import type { SqliteDatabase } from '@core/db/sqlite'
import { getAppContext } from './app-context'
import { ensureLibraryRoot, openRemote } from './sync-job'

const inflight = new Map<string, Promise<string | null>>()

export function materializeAsset(assetId: string): Promise<string | null> {
  const existing = inflight.get(assetId)
  if (existing) return existing
  const task = run(assetId).finally(() => inflight.delete(assetId))
  inflight.set(assetId, task)
  return task
}

async function run(assetId: string): Promise<string | null> {
  const { database, device } = getAppContext()
  const db: SqliteDatabase = database.db

  const asset = db
    .prepare('SELECT account_key AS accountKey, game_key AS gameKey, sha256, ext, bytes FROM assets WHERE asset_id = ?')
    .get(assetId) as any
  if (!asset) return null

  const object = db
    .prepare(
      `SELECT ro.object_key AS objectKey, ro.remote_id AS remoteId
         FROM remote_objects ro
        WHERE ro.asset_id = ? AND ro.publish_status = 'verified'
        ORDER BY ro.verified_at DESC LIMIT 1`
    )
    .get(assetId) as any
  if (!object) return null

  const libraryRoot = ensureLibraryRoot()
  const relativePath = managedRelativePath({
    accountKey: String(asset.accountKey),
    gameKey: String(asset.gameKey),
    sha256: String(asset.sha256),
    ext: String(asset.ext)
  })
  const target = join(libraryRoot, ...relativePath.split('/'))
  if (existsSync(target)) return target

  try {
    const remote = await openRemote(String(object.remoteId))
    const temporary = `${target}.part-${device.deviceId.slice(0, 8)}`
    mkdirSync(dirname(target), { recursive: true })
    const downloaded = await remote.store.downloadToFile(String(object.objectKey), temporary)
    if (!downloaded) {
      rmSync(temporary, { force: true })
      return null
    }
    if (downloaded.sha256 !== String(asset.sha256)) {
      rmSync(temporary, { force: true })
      throw new AppError('LIB_HASH_MISMATCH', '取回内容与索引指纹不一致')
    }
    renameSync(temporary, target)
    upsertLocalCopy(db, {
      assetId,
      libraryRoot,
      relativePath,
      bytes: downloaded.bytes,
      sha256: downloaded.sha256,
      verifiedAt: new Date().toISOString()
    })
    return target
  } catch {
    return null
  }
}
