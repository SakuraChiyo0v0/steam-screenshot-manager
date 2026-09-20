/**
 * 验证用查询：只给主进程内部的核对脚本使用，不经过 IPC、不返回绝对路径。
 *
 * 用途：把索引里的逻辑资产身份导出成可比对的清单，
 * 与 docs/evidence/sample-baseline.csv 这类外部基准逐条对账。
 */

import type { SqliteDatabase } from '../db/sqlite'

export interface AssetIdentity {
  readonly assetId: string
  readonly accountKey: string
  readonly gameKey: string
  readonly sha256: string
  readonly bytes: number
  readonly fileName: string
}

export function listAssetIdentities(db: SqliteDatabase): AssetIdentity[] {
  const rows = db
    .prepare(
      `SELECT
         a.asset_id      AS assetId,
         a.account_key   AS accountKey,
         a.game_key      AS gameKey,
         a.sha256        AS sha256,
         a.bytes         AS bytes,
         (SELECT sf.relative_path FROM source_files sf
           WHERE sf.asset_id = a.asset_id AND sf.present = 1
           ORDER BY sf.relative_path LIMIT 1) AS relativePath
       FROM assets a
       ORDER BY a.game_key, a.asset_id`
    )
    .all()

  return rows.map((row) => {
    const relativePath = row.relativePath === null || row.relativePath === undefined
      ? ''
      : String(row.relativePath)
    const index = relativePath.lastIndexOf('/')
    return {
      assetId: String(row.assetId),
      accountKey: String(row.accountKey),
      gameKey: String(row.gameKey),
      sha256: String(row.sha256),
      bytes: Number(row.bytes),
      fileName: index >= 0 ? relativePath.slice(index + 1) : relativePath
    }
  })
}
