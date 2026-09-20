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
