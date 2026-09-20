import { describe, expect, it } from 'vitest'
import { AppError } from '@shared/errors'
import {
  MIGRATIONS,
  assertMigrationsValid,
  latestSchemaVersion,
  migrate,
  readSchemaVersion,
  type Migration
} from '@core/db/migrations'
import { createMemoryDatabase, listTables } from '../helpers/database'

describe('schema 版本化与迁移', () => {
  it('全新数据库迁移到最新版本并建表', async () => {
    const db = await createMemoryDatabase()

    const outcome = migrate(db)

    expect(outcome.from).toBe(0)
    expect(outcome.to).toBe(latestSchemaVersion())
    expect(readSchemaVersion(db)).toBe(latestSchemaVersion())
    expect(listTables(db)).toContain('health_check')
    expect(listTables(db)).toContain('settings')

    db.close()
  })

  it('重复执行不重复应用已完成的迁移', async () => {
    const db = await createMemoryDatabase()
    migrate(db)

    const second = migrate(db)

    expect(second.applied).toEqual([])
    expect(second.from).toBe(latestSchemaVersion())
    expect(second.to).toBe(latestSchemaVersion())

    db.close()
  })

  it('迁移失败时回滚，保留原库与版本号', async () => {
    const db = await createMemoryDatabase()
    migrate(db)
    const before = readSchemaVersion(db)

    const failing: Migration[] = [
      {
        version: before + 1,
        description: '故意失败的迁移',
        up(target) {
          target.exec('CREATE TABLE should_not_survive (id INTEGER)')
          throw new Error('模拟迁移失败')
        }
      }
    ]

    expect(() => migrate(db, failing)).toThrowError(AppError)
    expect(readSchemaVersion(db)).toBe(before)
    expect(listTables(db)).not.toContain('should_not_survive')

    db.close()
  })

  it('拒绝重复或非法的迁移版本号', () => {
    expect(() =>
      assertMigrationsValid([
        { version: 1, description: 'a', up() {} },
        { version: 1, description: 'b', up() {} }
      ])
    ).toThrowError(AppError)

    expect(() => assertMigrationsValid([{ version: 0, description: 'a', up() {} }])).toThrowError(
      AppError
    )
  })

  it('内置迁移表本身合法', () => {
    expect(() => assertMigrationsValid(MIGRATIONS)).not.toThrow()
  })
})
