/** 测试辅助：创建一个内存数据库（结构与真实运行一致）。 */

import { openDatabase, loadNodeSqlite, type SqliteDatabase } from '@core/db/sqlite'

export async function createMemoryDatabase(): Promise<SqliteDatabase> {
  const sqlite = await loadNodeSqlite()
  return openDatabase(':memory:', sqlite)
}

/** 取出数据库里所有表名，用于断言建表与回滚结果。 */
export function listTables(db: SqliteDatabase): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => String(row.name))
}
