import { describe, expect, it } from 'vitest'
import { migrate } from '@core/db/migrations'
import { createMemoryDatabase } from '../helpers/database'

function insertSetting(db: Awaited<ReturnType<typeof createMemoryDatabase>>, key: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, '1')
}

function settingKeys(db: Awaited<ReturnType<typeof createMemoryDatabase>>): string[] {
  return db
    .prepare('SELECT key FROM settings ORDER BY key')
    .all()
    .map((row) => String(row.key))
}

describe('事务', () => {
  it('事务中途失败时整体回滚', async () => {
    const db = await createMemoryDatabase()
    migrate(db)

    expect(() =>
      db.transaction(() => {
        insertSetting(db, 'a')
        insertSetting(db, 'b')
        throw new Error('模拟写入失败')
      })
    ).toThrowError('模拟写入失败')

    expect(settingKeys(db)).toEqual([])

    db.close()
  })

  it('嵌套事务只回滚内层', async () => {
    const db = await createMemoryDatabase()
    migrate(db)

    db.transaction(() => {
      insertSetting(db, 'outer')

      try {
        db.transaction(() => {
          insertSetting(db, 'inner')
          throw new Error('内层失败')
        })
      } catch {
        // 内层失败被外层捕获，外层应继续提交
      }

      insertSetting(db, 'after')
    })

    expect(settingKeys(db)).toEqual(['after', 'outer'])

    db.close()
  })

  it('事务成功时提交全部写入', async () => {
    const db = await createMemoryDatabase()
    migrate(db)

    db.transaction(() => {
      insertSetting(db, 'x')
      insertSetting(db, 'y')
    })

    expect(settingKeys(db)).toEqual(['x', 'y'])

    db.close()
  })
})
