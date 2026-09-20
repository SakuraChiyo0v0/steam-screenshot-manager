/**
 * 应用数据库：把驱动、迁移与 启动自检组合成一个可用的数据库拥有者。
 *
 * 主进程是唯一的数据库持有者；渲染层只能通过 IPC 间接触发读写。
 */

import { randomUUID } from 'node:crypto'
import { AppError } from '@shared/errors'
import type { DbHealth, SqliteDriverName } from '@shared/types'
import { latestSchemaVersion, migrate, readSchemaVersion } from './migrations'
import { openDatabase, type NodeSqliteModule, type SqliteDatabase } from './sqlite'

export interface AppDatabase {
  readonly driver: SqliteDriverName
  readonly file: string
  readonly schemaVersion: number
  readonly db: SqliteDatabase
  close(): void
  /** 启动自检：写入一条记录并读回。 */
  health(): DbHealth
}

/**
 * 打开数据库并把 schema 迁移到最新版本。
 * 迁移失败时关闭连接并抛出 LIB_DB_CORRUPT，数据库文件保持原样。
 */
export function openAppDatabase(file: string, sqlite: NodeSqliteModule): AppDatabase {
  const db = openDatabase(file, sqlite)

  try {
    migrate(db)
  } catch (error) {
    db.close()
    throw error
  }

  const schemaVersion = readSchemaVersion(db)
  const expected = latestSchemaVersion()
  if (schemaVersion !== expected) {
    db.close()
    throw new AppError('LIB_DB_CORRUPT', `schema 版本 ${schemaVersion} 与期望的 ${expected} 不一致`)
  }

  return {
    driver: db.driver,
    file,
    schemaVersion,
    db,
    close: () => db.close(),
    health(): DbHealth {
      const writtenAt = new Date().toISOString()
      const note = randomUUID()

      db.transaction(() => {
        db.prepare('INSERT INTO health_check (note, written_at) VALUES (?, ?)').run(note, writtenAt)
      })

      const latest = db.prepare('SELECT note FROM health_check ORDER BY id DESC LIMIT 1').get()
      const counted = db.prepare('SELECT COUNT(*) AS total FROM health_check').get()

      return {
        driver: db.driver,
        writtenAt,
        readBack: String(latest?.note ?? ''),
        totalRows: Number(counted?.total ?? 0)
      }
    }
  }
}
