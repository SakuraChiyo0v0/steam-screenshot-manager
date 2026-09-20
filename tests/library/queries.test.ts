import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '@core/db/migrations'
import type { SqliteDatabase } from '@core/db/sqlite'
import { insertSource, writeScanOutcome } from '@core/library/index-writer'
import {
  decodeCursor,
  findAssetLocation,
  getAsset,
  libraryStats,
  listAccounts,
  listAssets,
  listGames
} from '@core/library/queries'
import type { ScanCandidate, ScanOutcome } from '@core/steam/scanner'
import { createMemoryDatabase } from '../helpers/database'

const SOURCE_ID = '11111111-2222-4333-8444-555555555555'
const ROOT = 'C:\\sample\\steam'
const SEEN_AT = '2026-09-21T00:00:00.000Z'

function candidate(
  relativePath: string,
  sha256: string,
  options: {
    gameKey?: string
    gameName?: string
    capturedAt?: string | null
    bytes?: number
    accountId?: string
  } = {}
): ScanCandidate {
  return {
    accountId: options.accountId ?? '1000000001',
    gameKey: options.gameKey ?? 'steam-438100',
    sourceId: SOURCE_ID,
    relativePath,
    absolutePath: `${ROOT}\\userdata\\${options.accountId ?? '1000000001'}\\760\\remote\\${relativePath}`,
    thumbnailAbsolutePath: null,
    size: options.bytes ?? 100,
    mtimeMs: 1000,
    ext: '.jpg',
    width: 1920,
    height: 1080,
    capturedAt: options.capturedAt === undefined ? '2026-05-01T00:00:00.000Z' : options.capturedAt,
    captureTimeSource: 'screenshot-index',
    sha256
  }
}

async function seed(): Promise<SqliteDatabase> {
  const db = await createMemoryDatabase()
  migrate(db)
  insertSource(db, { sourceId: SOURCE_ID, rootPath: ROOT, kind: 'manual', createdAt: SEEN_AT })

  const outcome: ScanOutcome = {
    profiles: [
      {
        accountId: '1000000001',
        steamId64: '76561199000000001',
        accountName: 'steamlogin1',
        personaName: 'SakuraChiyo'
      },
      {
        accountId: '1000000002',
        steamId64: '76561199000000002',
        accountName: 'steamlogin2',
        personaName: 'Persona2'
      }
    ],
    games: [
      {
        gameKey: 'steam-438100',
        appId: '438100',
        kind: 'steam',
        name: 'VRChat',
        nameSource: 'app-manifest',
        installed: true
      },
      {
        gameKey: 'steam-1687950',
        appId: '1687950',
        kind: 'steam',
        name: 'steam-1687950',
        nameSource: 'fallback',
        installed: false
      }
    ],
    candidates: [
      candidate('438100/screenshots/a.jpg', 'aa', { bytes: 300, capturedAt: '2026-05-03T00:00:00.000Z' }),
      candidate('438100/screenshots/b.jpg', 'bb', { bytes: 200, capturedAt: '2026-05-01T00:00:00.000Z' }),
      candidate('1687950/screenshots/c.jpg', 'cc', {
        gameKey: 'steam-1687950',
        bytes: 100,
        capturedAt: null
      })
    ],
    failures: [],
    cancelled: false,
    scannedAccounts: ['1000000001']
  }

  writeScanOutcome(db, { sourceId: SOURCE_ID, seenAt: SEEN_AT, outcome })
  return db
}

describe('游戏列表统计', () => {
  let db: SqliteDatabase

  beforeEach(async () => {
    db = await seed()
  })

  it('按游戏聚合数量、体积与最新拍摄时间', () => {
    const games = listGames(db, {})
    const vrchat = games.find((game) => game.gameKey === 'steam-438100')!

    expect(vrchat.name).toBe('VRChat')
    expect(vrchat.installed).toBe(true)
    expect(vrchat.assetCount).toBe(2)
    expect(vrchat.bytes).toBe(500)
    expect(vrchat.latestCapturedAt).toBe('2026-05-03T00:00:00.000Z')
    expect(vrchat.coverAssetId).not.toBeNull()
  })

  it('已卸载且无名称的游戏仍然显示，并用 gameKey 兜底', () => {
    const games = listGames(db, {})
    const fallback = games.find((game) => game.gameKey === 'steam-1687950')!

    expect(fallback.installed).toBe(false)
    expect(fallback.name).toBe('steam-1687950')
  })

  it('支持按安装状态与搜索词筛选', () => {
    expect(listGames(db, { installed: false })).toHaveLength(1)
    expect(listGames(db, { installed: true })).toHaveLength(1)
    expect(listGames(db, { query: 'vrchat' })).toHaveLength(1)
    expect(listGames(db, { query: '不存在的游戏' })).toHaveLength(0)
  })

  it('游戏查询结果不含来源根路径', () => {
    expect(JSON.stringify(listGames(db, {}))).not.toContain(ROOT)
  })

  it('空库返回空列表而不是报错', async () => {
    const empty = await createMemoryDatabase()
    migrate(empty)
    expect(listGames(empty, {})).toEqual([])
    expect(libraryStats(empty)).toEqual({
      games: 0,
      assets: 0,
      bytes: 0,
      accounts: 0,
      missingFiles: 0
    })
  })
})

describe('资产查询', () => {
  let db: SqliteDatabase

  beforeEach(async () => {
    db = await seed()
  })

  it('按游戏查询只返回该游戏的资产', () => {
    const page = listAssets(db, { gameKey: 'steam-438100' })
    expect(page.items).toHaveLength(2)
    expect(page.items.every((item) => item.gameKey === 'steam-438100')).toBe(true)
  })

  it('默认按拍摄时间倒序，空时间排在最后', () => {
    const page = listAssets(db, {})
    expect(page.items.map((item) => item.fileName)).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
  })

  it('支持按拍摄时间正序', () => {
    const page = listAssets(db, { sort: 'captured-asc' })
    expect(page.items[0]!.fileName).toBe('c.jpg')
  })

  it('分页游标稳定，无重复无遗漏', () => {
    const first = listAssets(db, { limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()

    const second = listAssets(db, { limit: 2, cursor: first.nextCursor })
    const ids = [...first.items, ...second.items].map((item) => item.assetId)
    expect(new Set(ids).size).toBe(3)
    expect(second.nextCursor).toBeNull()
  })

  it('游标可解码回排序列与资产标识', () => {
    const page = listAssets(db, { limit: 1 })
    const payload = decodeCursor(page.nextCursor!)
    expect(payload.id).toBe(page.items[0]!.assetId)
    expect(payload.key).toBe('2026-05-03T00:00:00.000Z')
  })

  it('资产查询结果不含任何文件系统路径', () => {
    const serialized = JSON.stringify(listAssets(db, {}))
    expect(serialized).not.toContain(ROOT)
    expect(serialized).not.toContain('screenshots')
    expect(serialized).not.toContain('absolutePath')
  })

  it('资产详情返回展示元数据与时间来源', () => {
    const asset = listAssets(db, { gameKey: 'steam-438100' }).items[0]!
    const detail = getAsset(db, asset.assetId)!

    expect(detail.fileName).toBe('a.jpg')
    expect(detail.gameName).toBe('VRChat')
    expect(detail.width).toBe(1920)
    expect(detail.captureTimeSource).toBe('screenshot-index')
    expect(detail.available).toBe(true)
    expect(JSON.stringify(detail)).not.toContain(ROOT)
  })

  it('资产不存在时返回 null', () => {
    expect(getAsset(db, '00000000-0000-4000-8000-000000000000')).toBeNull()
  })

  it('主进程内部可按资产定位来源根与相对路径', () => {
    const asset = listAssets(db, { gameKey: 'steam-438100' }).items[0]!
    const location = findAssetLocation(db, asset.assetId)!

    expect(location.rootPath).toBe(ROOT)
    expect(location.relativePath).toBe('438100/screenshots/a.jpg')
    expect(location.hasThumbnail).toBe(false)
  })

  it('账号列表带资产计数', () => {
    const accounts = listAccounts(db)
    expect(accounts).toHaveLength(2)

    const primary = accounts.find((item) => item.accountKey === 'steam-1000000001')!
    expect(primary.displayName).toBe('SakuraChiyo')
    expect(primary.assetCount).toBe(3)

    const secondary = accounts.find((item) => item.accountKey === 'steam-1000000002')!
    expect(secondary.assetCount).toBe(0)
  })
})
