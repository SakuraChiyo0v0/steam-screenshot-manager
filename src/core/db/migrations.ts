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
