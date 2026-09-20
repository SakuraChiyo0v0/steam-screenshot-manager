import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '@core/db/migrations'
import type { SqliteDatabase } from '@core/db/sqlite'
import {
  deleteSource,
  insertSource,
  listSources,
  loadKnownHashes,
  writeScanOutcome
} from '@core/library/index-writer'
import { libraryStats, listAssets } from '@core/library/queries'
import type { ScanCandidate, ScanOutcome } from '@core/steam/scanner'
import { createMemoryDatabase } from '../helpers/database'

const SOURCE_ID = '11111111-2222-4333-8444-555555555555'
const ROOT = 'C:\\sample\\steam'
const SEEN_AT = '2026-09-21T00:00:00.000Z'

function candidate(
  overrides: Partial<ScanCandidate> & { relativePath: string; sha256: string }
): ScanCandidate {
  return {
    accountId: '1000000001',
    gameKey: 'steam-438100',
    sourceId: SOURCE_ID,
    absolutePath: `${ROOT}\\userdata\\1000000001\\760\\remote\\${overrides.relativePath}`,
    thumbnailAbsolutePath: null,
    size: 100,
    mtimeMs: 1000,
    ext: '.jpg',
    width: 1920,
    height: 1080,
    capturedAt: '2026-05-01T00:00:00.000Z',
    captureTimeSource: 'screenshot-index',
    ...overrides
  }
}

function outcome(candidates: ScanCandidate[]): ScanOutcome {
  return {
    profiles: [
      {
        accountId: '1000000001',
        steamId64: '76561199000000001',
        accountName: 'steamlogin1',
        personaName: 'SakuraChiyo'
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
      }
    ],
    candidates,
    failures: [],
    cancelled: false,
    scannedAccounts: ['1000000001']
  }
}

async function setup(): Promise<SqliteDatabase> {
  const db = await createMemoryDatabase()
  migrate(db)
  insertSource(db, { sourceId: SOURCE_ID, rootPath: ROOT, kind: 'manual', createdAt: SEEN_AT })
  return db
}

describe('索引写入', () => {
  let db: SqliteDatabase

  beforeEach(async () => {
    db = await setup()
  })

  it('首次写入建立资产与来源文件', () => {
    const result = writeScanOutcome(db, {
      sourceId: SOURCE_ID,
      seenAt: SEEN_AT,
      outcome: outcome([
        candidate({ relativePath: '438100/screenshots/a.jpg', sha256: 'aa' }),
        candidate({ relativePath: '438100/screenshots/b.jpg', sha256: 'bb' })
      ])
    })

    expect(result.assets).toBe(2)
    expect(result.sourceFiles).toBe(2)
    expect(result.missingMarked).toBe(0)
    expect(libraryStats(db).assets).toBe(2)
  })

  it('重复扫描同一来源不产生重复行', () => {
    const candidates = [
      candidate({ relativePath: '438100/screenshots/a.jpg', sha256: 'aa' }),
      candidate({ relativePath: '438100/screenshots/b.jpg', sha256: 'bb' })
    ]
    writeScanOutcome(db, { sourceId: SOURCE_ID, seenAt: SEEN_AT, outcome: outcome(candidates) })
    const second = writeScanOutcome(db, {
      sourceId: SOURCE_ID,
      seenAt: SEEN_AT,
      outcome: outcome(candidates)
    })

    expect(second.assets).toBe(0)
    expect(second.sourceFiles).toBe(2)
    expect(libraryStats(db).assets).toBe(2)
    expect(second.missingMarked).toBe(0)
  })

  it('同游戏内内容相同的多个文件折叠为一个逻辑资产', () => {
    const result = writeScanOutcome(db, {
      sourceId: SOURCE_ID,
      seenAt: SEEN_AT,
      outcome: outcome([
        candidate({ relativePath: '438100/screenshots/a_1.jpg', sha256: 'same' }),
        candidate({ relativePath: '438100/screenshots/a_2.jpg', sha256: 'same' }),
        candidate({ relativePath: '438100/screenshots/a_3.jpg', sha256: 'same' })
      ])
    })

    expect(result.assets).toBe(1)
    expect(result.sourceFiles).toBe(3)
    expect(libraryStats(db).assets).toBe(1)
  })

  it('同内容跨游戏保留各自归属', () => {
    const result = writeScanOutcome(db, {
      sourceId: SOURCE_ID,
      seenAt: SEEN_AT,
      outcome: outcome([
        candidate({ relativePath: '438100/screenshots/a.jpg', sha256: 'same' }),
        candidate({
          relativePath: '2593370/screenshots/a.jpg',
          sha256: 'same',
          gameKey: 'steam-2593370'
        })
      ])
    })

    expect(result.assets).toBe(2)
    expect(libraryStats(db).assets).toBe(2)
  })

  it('成功扫描后把本次未见到的来源文件标记为缺失，但不删除资产', () => {
    writeScanOutcome(db, {
      sourceId: SOURCE_ID,
      seenAt: SEEN_AT,
      outcome: outcome([
        candidate({ relativePath: '438100/screenshots/a.jpg', sha256: 'aa' }),
        candidate({ relativePath: '438100/screenshots/b.jpg', sha256: 'bb' })
      ])
    })

    const second = writeScanOutcome(db, {
      sourceId: SOURCE_ID,
      seenAt: SEEN_AT,
      outcome: outcome([candidate({ relativePath: '438100/screenshots/a.jpg', sha256: 'aa' })])
    })

    expect(second.missingMarked).toBe(1)
    expect(libraryStats(db).assets).toBe(2)
    expect(libraryStats(db).missingFiles).toBe(1)

    const page = listAssets(db, {})
    const missing = page.items.find((item) => !item.available)
    expect(missing).toBeDefined()
    expect(missing!.fileName).toBe('(来源缺失)')
  })

  it('按账号隔离存在状态：只标记本次扫描账号下的文件', () => {
    writeScanOutcome(db, {
      sourceId: SOURCE_ID,
      seenAt: SEEN_AT,
      outcome: {
        ...outcome([
          candidate({ relativePath: '438100/screenshots/a.jpg', sha256: 'aa' }),
          candidate({
            relativePath: '4162040/screenshots/x.jpg',
            sha256: 'xx',
            accountId: '1000000002',
            gameKey: 'steam-4162040'
          })
        ]),
        scannedAccounts: ['1000000001', '1000000002']
      }
    })

    // 第二次只扫描第一个账号：另一个账号的文件不应被标记为缺失
    writeScanOutcome(db, {
      sourceId: SOURCE_ID,
      seenAt: SEEN_AT,
      outcome: outcome([candidate({ relativePath: '438100/screenshots/a.jpg', sha256: 'aa' })])
    })

    expect(libraryStats(db).missingFiles).toBe(0)
  })

  it('已有拍摄时间不被空值覆盖', () => {
    writeScanOutcome(db, {
      sourceId: SOURCE_ID,
      seenAt: SEEN_AT,
      outcome: outcome([
        candidate({
          relativePath: '438100/screenshots/a.jpg',
          sha256: 'aa',
          capturedAt: '2026-05-01T00:00:00.000Z'
        })
      ])
    })

    writeScanOutcome(db, {
      sourceId: SOURCE_ID,
      seenAt: SEEN_AT,
      outcome: outcome([
        candidate({
          relativePath: '438100/screenshots/a.jpg',
          sha256: 'aa',
          capturedAt: null,
          captureTimeSource: 'unknown'
        })
      ])
    })

    const asset = listAssets(db, {}).items[0]!
    expect(asset.capturedAt).toBe('2026-05-01T00:00:00.000Z')
    expect(asset.captureTimeSource).toBe('screenshot-index')
  })

  it('已有哈希可在 size 与 mtime 未变时复用', () => {
    writeScanOutcome(db, {
      sourceId: SOURCE_ID,
      seenAt: SEEN_AT,
      outcome: outcome([
        candidate({ relativePath: '438100/screenshots/a.jpg', sha256: 'aa', size: 100, mtimeMs: 1000 })
      ])
    })

    const known = loadKnownHashes(db, SOURCE_ID)
    expect(known.get('438100/screenshots/a.jpg')).toEqual({
      size: 100,
      mtimeMs: 1000,
      sha256: 'aa'
    })
  })

  it('移除来源只删除来源文件，资产保留为缺失状态', () => {
    writeScanOutcome(db, {
      sourceId: SOURCE_ID,
      seenAt: SEEN_AT,
      outcome: outcome([candidate({ relativePath: '438100/screenshots/a.jpg', sha256: 'aa' })])
    })

    deleteSource(db, SOURCE_ID)

    expect(listSources(db)).toHaveLength(0)
    expect(libraryStats(db).assets).toBe(1)
    expect(listAssets(db, {}).items[0]!.available).toBe(false)
  })
})
