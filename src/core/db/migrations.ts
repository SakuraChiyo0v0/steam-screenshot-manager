/**
 * schema 版本化与迁移框架。
 *
 * 规则（docs/architecture.md 第 4 节）：
 * - 数据库带版本号（PRAGMA user_version）；
 * - 迁移按版本顺序执行，每项在事务中完成；
 * - 迁移失败时保留原库、不自动删除数据库"重新开始"。
 */

import { AppError } from '@shared/errors'
import type { SqliteDatabase } from './sqlite'

export interface Migration {
  readonly version: number
  readonly description: string
  up(db: SqliteDatabase): void
}

/**
 * 全部迁移按版本升序排列。新增迁移只追加，不修改已发布项。
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: '建立最小自检表与设置表',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS health_check (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          note       TEXT NOT NULL,
          written_at TEXT NOT NULL
        )
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `)
    }
  },
  {
    version: 2,
    description: '建立索引表：profiles、games、sources、assets、source_files',
    up(db) {
      // 账号身份。accountKey 形如 steam-<AccountID>，创建后固定。
      db.exec(`
        CREATE TABLE IF NOT EXISTS profiles (
          account_key       TEXT PRIMARY KEY,
          steam_account_id  TEXT NOT NULL,
          steam_id64        TEXT,
          account_name      TEXT,
          persona_name      TEXT,
          updated_at        TEXT NOT NULL
        )
      `)

      // 游戏身份。steam 游戏为 steam-<AppID>，非 Steam 快捷方式为 shortcut-<gameID>。
      db.exec(`
        CREATE TABLE IF NOT EXISTS games (
          game_key    TEXT PRIMARY KEY,
          app_id      TEXT,
          kind        TEXT NOT NULL,
          name        TEXT NOT NULL,
          name_source TEXT NOT NULL,
          installed   INTEGER NOT NULL DEFAULT 0,
          updated_at  TEXT NOT NULL
        )
      `)

      // 来源根目录。root_path 只在本机数据库保存，不进远端清单、也不返回渲染层。
      db.exec(`
        CREATE TABLE IF NOT EXISTS sources (
          source_id        TEXT PRIMARY KEY,
          root_path        TEXT NOT NULL,
          kind             TEXT NOT NULL,
          created_at       TEXT NOT NULL,
          last_scan_at     TEXT,
          last_scan_status TEXT,
          last_scan_error  TEXT
        )
      `)

      // 逻辑资产：账号＋游戏＋完整 SHA-256 唯一。
      db.exec(`
        CREATE TABLE IF NOT EXISTS assets (
          asset_id            TEXT PRIMARY KEY,
          account_key         TEXT NOT NULL,
          game_key            TEXT NOT NULL,
          sha256              TEXT NOT NULL,
          bytes               INTEGER NOT NULL,
          ext                 TEXT NOT NULL,
          width               INTEGER,
          height              INTEGER,
          captured_at         TEXT,
          capture_time_source TEXT NOT NULL,
          created_at          TEXT NOT NULL,
          UNIQUE (account_key, game_key, sha256)
        )
      `)

      // 来源文件：同一资产可有多个来源。present 是可撤销状态，来源不可达时不更新。
      db.exec(`
        CREATE TABLE IF NOT EXISTS source_files (
          source_file_id TEXT PRIMARY KEY,
          source_id      TEXT NOT NULL,
          account_key    TEXT NOT NULL,
          asset_id       TEXT NOT NULL,
          relative_path  TEXT NOT NULL,
          size           INTEGER NOT NULL,
          mtime_ms       INTEGER NOT NULL,
          has_thumbnail  INTEGER NOT NULL DEFAULT 0,
          present        INTEGER NOT NULL DEFAULT 1,
          last_seen_at   TEXT NOT NULL,
          UNIQUE (source_id, account_key, relative_path)
        )
      `)

      db.exec('CREATE INDEX IF NOT EXISTS idx_assets_game ON assets (game_key)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_assets_account_game ON assets (account_key, game_key)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_source_files_asset ON source_files (asset_id)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_source_files_source ON source_files (source_id, present)')
    }
  },
  {
    version: 3,
    description: '建立图库副本表 local_copies',
    up(db) {
      // 受管副本：一个资产在某个图库根下最多一份原件。
      // relative_path 相对图库根，绝不保存来源绝对路径。
      db.exec(`
        CREATE TABLE IF NOT EXISTS local_copies (
          local_copy_id TEXT PRIMARY KEY,
          asset_id      TEXT NOT NULL,
          library_root  TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          bytes         INTEGER NOT NULL,
          sha256        TEXT NOT NULL,
          verified_at   TEXT NOT NULL,
          present       INTEGER NOT NULL DEFAULT 1,
          created_at    TEXT NOT NULL,
          UNIQUE (asset_id, library_root)
        )
      `)
      db.exec('CREATE INDEX IF NOT EXISTS idx_local_copies_asset ON local_copies (asset_id, present)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_local_copies_root ON local_copies (library_root, present)')
    }
  },
  {
    version: 4,
    description: '建立远端与远端对象表 remotes、remote_objects',
    up(db) {
      // 远端图库连接。密码不进这里，只存不可逆的凭据引用键。
      db.exec(`
        CREATE TABLE IF NOT EXISTS remotes (
          remote_id         TEXT PRIMARY KEY,
          library_id        TEXT NOT NULL,
          base_url          TEXT NOT NULL,
          root_path         TEXT NOT NULL,
          credential_ref    TEXT NOT NULL,
          format_version    INTEGER NOT NULL,
          created_at        TEXT NOT NULL,
          last_check_at     TEXT,
          last_check_status TEXT
        )
      `)

      // 资产在某个远端上的物理对象与记录状态。publish_status 只在读回校验通过后前进。
      db.exec(`
        CREATE TABLE IF NOT EXISTS remote_objects (
          remote_object_id TEXT PRIMARY KEY,
          remote_id        TEXT NOT NULL,
          asset_id         TEXT NOT NULL,
          object_key       TEXT NOT NULL,
          record_id        TEXT NOT NULL,
          upload_id        TEXT NOT NULL,
          publish_status   TEXT NOT NULL,
          verified_at      TEXT,
          last_error       TEXT,
          attempt_count    INTEGER NOT NULL DEFAULT 0,
          next_attempt_at  TEXT,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL,
          UNIQUE (remote_id, asset_id)
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_remote_objects_status ON remote_objects (remote_id, publish_status)'
      )
    }
  },
  {
    version: 5,
    description: 'assets 增加原文件名（图库副本与远端记录都能提供）',
    up(db) {
      const columns = db.prepare('PRAGMA table_info(assets)').all() as { name: string }[]
      if (!columns.some((column) => column.name === 'original_filename')) {
        db.exec('ALTER TABLE assets ADD COLUMN original_filename TEXT')
      }

      // 回填：优先用仍然存在的来源相对路径的最后一段
      const rows = db
        .prepare(
          `SELECT a.asset_id AS assetId,
                  (SELECT sf.relative_path FROM source_files sf
                    WHERE sf.asset_id = a.asset_id
                    ORDER BY sf.present DESC, sf.last_seen_at DESC LIMIT 1) AS relativePath
             FROM assets a
            WHERE a.original_filename IS NULL`
        )
        .all() as { assetId: string; relativePath: string | null }[]
      const update = db.prepare('UPDATE assets SET original_filename = ? WHERE asset_id = ?')
      for (const row of rows) {
        if (row.relativePath) {
          const segments = String(row.relativePath).split(/[\\/]/)
          update.run(segments[segments.length - 1] ?? null, row.assetId)
        }
      }
    }
  }
]
export interface MigrationOutcome {
  readonly from: number
  readonly to: number
  readonly applied: readonly number[]
}

export function readSchemaVersion(db: SqliteDatabase): number {
  const row = db.prepare('PRAGMA user_version').get()
  const value = row?.user_version
  const version = Number(value ?? 0)
  return Number.isFinite(version) ? version : 0
}

export function latestSchemaVersion(migrations: readonly Migration[] = MIGRATIONS): number {
  return migrations.reduce((max, item) => Math.max(max, item.version), 0)
}

/** 校验迁移表本身合法：版本为正整数、不重复。 */
export function assertMigrationsValid(migrations: readonly Migration[]): void {
  const seen = new Set<number>()
  for (const item of migrations) {
    if (!Number.isInteger(item.version) || item.version <= 0) {
      throw new AppError('LIB_DB_CORRUPT', `迁移版本号非法：${String(item.version)}`)
    }
    if (seen.has(item.version)) {
      throw new AppError('LIB_DB_CORRUPT', `迁移版本号重复：${item.version}`)
    }
    seen.add(item.version)
  }
}

/**
 * 顺序应用尚未执行的迁移。已应用的迁移不会重复执行。
 * 任一项失败即抛出 LIB_DB_CORRUPT，数据库文件保持原样。
 */
export function migrate(
  db: SqliteDatabase,
  migrations: readonly Migration[] = MIGRATIONS
): MigrationOutcome {
  assertMigrationsValid(migrations)

  const from = readSchemaVersion(db)
  const pending = migrations
    .filter((item) => item.version > from)
    .slice()
    .sort((a, b) => a.version - b.version)

  const applied: number[] = []
  for (const item of pending) {
    try {
      db.transaction(() => {
        item.up(db)
        db.exec(`PRAGMA user_version = ${item.version}`)
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new AppError(
        'LIB_DB_CORRUPT',
        `迁移 ${item.version}（${item.description}）失败，已保留原数据库：${detail}`
      )
    }
    applied.push(item.version)
  }

  return { from, to: readSchemaVersion(db), applied }
}
