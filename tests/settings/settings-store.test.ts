import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { migrate } from '@core/db/migrations'
import { isSettingsPatch, readSettings, writeSettings } from '@core/settings/settings-store'
import { createMemoryDatabase } from '../helpers/database'

describe('本机偏好存储', () => {
  it('空数据库返回默认值', async () => {
    const db = await createMemoryDatabase()
    migrate(db)

    expect(readSettings(db)).toEqual(DEFAULT_SETTINGS)

    db.close()
  })

  it('写入后读回同一份偏好', async () => {
    const db = await createMemoryDatabase()
    migrate(db)

    writeSettings(db, { autoCollect: true })
    expect(readSettings(db).autoCollect).toBe(true)

    writeSettings(db, { autoCollect: false })
    expect(readSettings(db).autoCollect).toBe(false)

    db.close()
  })

  it('图库根目录可写入也可清空', async () => {
    const db = await createMemoryDatabase()
    migrate(db)

    writeSettings(db, { libraryRoot: 'C:\\LocalSpace\\gallery' })
    expect(readSettings(db).libraryRoot).toBe('C:\\LocalSpace\\gallery')

    writeSettings(db, { libraryRoot: null })
    expect(readSettings(db).libraryRoot).toBeNull()

    db.close()
  })

  it('部分更新不影响其他字段', async () => {
    const db = await createMemoryDatabase()
    migrate(db)

    writeSettings(db, { autoCollect: true, libraryRoot: 'C:\\LocalSpace\\gallery' })
    writeSettings(db, { autoCollect: false })

    expect(readSettings(db)).toEqual({
      ...DEFAULT_SETTINGS,
      autoCollect: false,
      libraryRoot: 'C:\\LocalSpace\\gallery'
    })

    db.close()
  })

  it('运行时校验拒绝未知字段与错误类型', () => {
    expect(isSettingsPatch({ autoCollect: true })).toBe(true)
    expect(isSettingsPatch({ libraryRoot: null })).toBe(true)
    expect(isSettingsPatch({ libraryRoot: 'C:\\x' })).toBe(true)

    expect(isSettingsPatch({ unknown: 1 })).toBe(false)
    expect(isSettingsPatch({ autoCollect: 'yes' })).toBe(false)
    expect(isSettingsPatch({ libraryRoot: 123 })).toBe(false)
    expect(isSettingsPatch(null)).toBe(false)
    expect(isSettingsPatch([])).toBe(false)
    expect(isSettingsPatch('string')).toBe(false)
  })
})
