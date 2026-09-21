import { describe, expect, it } from 'vitest'
import {
  completeGameNamesFromCache,
  fetchAppNames,
  appNameCacheStats,
  saveAppNames,
  setGameAlias
} from '@core/steam/app-names'
import { nameSourceRank, shouldReplaceName } from '@core/library/game-name'
import { migrate } from '@core/db/migrations'
import { createMemoryDatabase } from '../helpers/database'
import type { SqliteDatabase } from '@core/db/sqlite'

async function withDatabase(run: (db: SqliteDatabase) => Promise<void> | void): Promise<void> {
  const db = await createMemoryDatabase()
  try {
    migrate(db)
    await run(db)
  } finally {
    db.close()
  }
}

function insertGame(
  db: SqliteDatabase,
  input: { key: string; appId: string | null; name: string; source: string; kind?: string }
): void {
  db.prepare(
    'INSERT INTO games (game_key, app_id, kind, name, name_source, installed, updated_at) VALUES (?,?,?,?,?,?,?)'
  ).run(input.key, input.appId, input.kind ?? 'steam', input.name, input.source, 0, '2026-09-21T00:00:00.000Z')
}

/** 造一个按顺序回页的假 Steam API。 */
function fakeFetcher(pages: unknown[]): {
  fetch: (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>
  urls: string[]
} {
  const urls: string[] = []
  let index = 0
  return {
    urls,
    fetch: async (url: string) => {
      urls.push(url)
      const body = pages[Math.min(index, pages.length - 1)]
      index += 1
      return { ok: true, status: 200, text: async () => JSON.stringify(body) }
    }
  }
}

describe('名称优先级', () => {
  it('用户别名高于自动补全，补全高于兜底', () => {
    expect(nameSourceRank('user')).toBeGreaterThan(nameSourceRank('steam-api'))
    expect(nameSourceRank('steam-api')).toBeGreaterThan(nameSourceRank('fallback'))
  })

  it('空名字不覆盖已有名字', () => {
    expect(
      shouldReplaceName({ name: 'VRChat', source: 'steam-api' }, { name: '  ', source: 'user' })
    ).toBe(false)
  })

  it('兜底名不能覆盖补全名，反过来可以', () => {
    expect(
      shouldReplaceName(
        { name: 'VRChat', source: 'steam-api' },
        { name: '未知游戏（438100）', source: 'fallback' }
      )
    ).toBe(false)
    expect(
      shouldReplaceName(
        { name: '未知游戏（438100）', source: 'fallback' },
        { name: 'VRChat', source: 'steam-api' }
      )
    ).toBe(true)
  })
})

describe('Steam 应用目录抓取', () => {
  it('解析 apps 并带上密钥与分页参数', async () => {
    const fake = fakeFetcher([
      {
        response: {
          apps: [
            { appid: 438100, name: 'VRChat' },
            { appid: 1687950, name: 'Persona 5 Royal' }
          ],
          have_more_results: false,
          last_appid: 1687950
        }
      }
    ])
    const result = await fetchAppNames({ apiKey: 'KEY', fetcher: fake.fetch })
    expect(result.entries).toEqual([
      { appId: '438100', name: 'VRChat' },
      { appId: '1687950', name: 'Persona 5 Royal' }
    ])
    expect(result.exhausted).toBe(true)
    expect(fake.urls[0]).toContain('key=KEY')
    expect(fake.urls[0]).toContain('include_games=1')
    expect(fake.urls[0]).toContain('include_dlc=0')
  })

  it('多页时按 last_appid 继续抓', async () => {
    const fake = fakeFetcher([
      { response: { apps: [{ appid: 1, name: 'A' }], have_more_results: true, last_appid: 1 } },
      { response: { apps: [{ appid: 2, name: 'B' }], have_more_results: false, last_appid: 2 } }
    ])
    const result = await fetchAppNames({ apiKey: 'K', fetcher: fake.fetch, maxPages: 5 })
    expect(result.entries.map((entry) => entry.appId)).toEqual(['1', '2'])
    expect(result.pages).toBe(2)
    expect(fake.urls[1]).toContain('last_appid=1')
  })

  it('返回非 JSON（密钥无效或被网关拦截）时报可读错误', async () => {
    const fetcher = async (): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> => ({
      ok: true,
      status: 200,
      text: async () => '<html>Forbidden</html>'
    })
    await expect(fetchAppNames({ apiKey: 'bad', fetcher })).rejects.toThrow('不是 JSON')
  })

  it('HTTP 失败时抛错', async () => {
    const fetcher = async (): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> => ({
      ok: false,
      status: 403,
      text: async () => '{}'
    })
    await expect(fetchAppNames({ apiKey: 'bad', fetcher })).rejects.toThrow('403')
  })
})

describe('用缓存补全游戏名', () => {
  it('把 AppID 兜底名补成真实名称，且不覆盖用户别名', async () => {
    await withDatabase((db) => {
      const now = '2026-09-21T00:00:00.000Z'
      insertGame(db, { key: 'steam-1687950', appId: '1687950', name: '未知游戏（1687950）', source: 'fallback' })
      insertGame(db, { key: 'steam-438100', appId: '438100', name: '我的名字', source: 'user' })
      saveAppNames(
        db,
        [
          { appId: '1687950', name: 'Persona 5 Royal' },
          { appId: '438100', name: 'VRChat' }
        ],
        now
      )
      expect(completeGameNamesFromCache(db, now)).toBe(1)
      const rows = db
        .prepare('SELECT game_key AS key, name, name_source AS source FROM games ORDER BY game_key')
        .all() as { key: string; name: string; source: string }[]
      expect(rows).toEqual([
        { key: 'steam-1687950', name: 'Persona 5 Royal', source: 'steam-api' },
        { key: 'steam-438100', name: '我的名字', source: 'user' }
      ])
      expect(appNameCacheStats(db).count).toBe(2)
    })
  })

  it('手动别名优先；清除后回到补全名', async () => {
    await withDatabase((db) => {
      const now = '2026-09-21T00:00:00.000Z'
      insertGame(db, { key: 'steam-1687950', appId: '1687950', name: '未知游戏（1687950）', source: 'fallback' })
      saveAppNames(db, [{ appId: '1687950', name: 'Persona 5 Royal' }], now)

      setGameAlias(db, 'steam-1687950', 'P5R', now)
      let row = db
        .prepare('SELECT name, name_source AS source FROM games WHERE game_key = ?')
        .get('steam-1687950') as { name: string; source: string }
      expect(row).toEqual({ name: 'P5R', source: 'user' })
      expect(completeGameNamesFromCache(db, now)).toBe(0)

      setGameAlias(db, 'steam-1687950', '', now)
      row = db
        .prepare('SELECT name, name_source AS source FROM games WHERE game_key = ?')
        .get('steam-1687950') as { name: string; source: string }
      expect(row.name).toBe('Persona 5 Royal')
      expect(row.source).toBe('steam-api')
    })
  })
})
