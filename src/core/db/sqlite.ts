/**
 * SQLite 访问层的最小封装。
 *
 * 只暴露 当前真正需要的接口：执行语句、预处理语句、事务、关闭。
 * 驱动通过参数注入，因此本模块本身不依赖任何具体运行时，
 * 可以在单元测试里用真实模块验证，也可以在选型 spike 里探测可用性。
 */

import { AppError } from '@shared/errors'
import type { SqliteDriverName } from '@shared/types'

export type SqlValue = string | number | bigint | null | Uint8Array

export interface SqliteRunResult {
  readonly changes: number
  readonly lastInsertRowid: number | bigint
}

export interface SqliteStatement {
  run(...params: SqlValue[]): SqliteRunResult
  get(...params: SqlValue[]): Record<string, SqlValue> | undefined
  all(...params: SqlValue[]): Record<string, SqlValue>[]
}

export interface SqliteDatabase {
  readonly driver: SqliteDriverName
  readonly file: string
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
  /** 在事务中执行 fn；抛错时回滚并原样抛出。支持嵌套（内部使用保存点）。 */
  transaction<T>(fn: () => T): T
}

/** node:sqlite 模块的类型，用于注入。 */
export type NodeSqliteModule = typeof import('node:sqlite')

/** 驱动内部使用的结构化类型，避免与 @types/node 的具体签名耦合。 */
interface RawStatement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...params: SqlValue[]): unknown
  all(...params: SqlValue[]): unknown[]
}

interface RawDatabase {
  exec(sql: string): void
  prepare(sql: string): unknown
  close(): void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 动态加载 node:sqlite；不可用时抛出 LIB_DB_CORRUPT。 */
export async function loadNodeSqlite(): Promise<NodeSqliteModule> {
  try {
    return (await import('node:sqlite')) as NodeSqliteModule
  } catch (error) {
    throw new AppError('LIB_DB_CORRUPT', `当前运行时不支持 node:sqlite（${messageOf(error)}）`)
  }
}

/** 探测当前运行时是否提供 node:sqlite。选型 spike 使用，不抛错。 */
export async function isNodeSqliteAvailable(): Promise<boolean> {
  try {
    await loadNodeSqlite()
    return true
  } catch {
    return false
  }
}

function wrapStatement(statement: RawStatement): SqliteStatement {
  return {
    run: (...params) => {
      const result = statement.run(...params)
      return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid }
    },
    get: (...params) => statement.get(...params) as Record<string, SqlValue> | undefined,
    all: (...params) => statement.all(...params) as Record<string, SqlValue>[]
  }
}

/**
 * 打开（必要时创建）数据库。
 *
 * 数据库文件必须位于用户数据目录，绝不写入安装目录或 ASAR 内路径。
 */
export function openDatabase(file: string, sqlite: NodeSqliteModule): SqliteDatabase {
  let raw: RawDatabase
  try {
    raw = new sqlite.DatabaseSync(file) as unknown as RawDatabase
  } catch (error) {
    throw new AppError('LIB_DB_CORRUPT', `打开数据库失败：${messageOf(error)}`)
  }

  raw.exec('PRAGMA journal_mode = WAL')
  raw.exec('PRAGMA foreign_keys = ON')
  raw.exec('PRAGMA busy_timeout = 5000')

  let depth = 0

  return {
    driver: 'node:sqlite',
    file,
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => wrapStatement(raw.prepare(sql) as RawStatement),
    close: () => raw.close(),
    transaction<T>(fn: () => T): T {
      const isOuter = depth === 0
      const savepoint = `sp_${depth}`
      raw.exec(isOuter ? 'BEGIN' : `SAVEPOINT ${savepoint}`)
      depth += 1
      try {
        const result = fn()
        depth -= 1
        raw.exec(isOuter ? 'COMMIT' : `RELEASE ${savepoint}`)
        return result
      } catch (error) {
        depth -= 1
        try {
          raw.exec(isOuter ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`)
          if (!isOuter) {
            raw.exec(`RELEASE ${savepoint}`)
          }
        } catch {
          // 回滚本身失败时不掩盖原始错误
        }
        throw error
      }
    }
  }
}
