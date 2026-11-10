import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '@core/db/migrations'
import type { SqliteDatabase } from '@core/db/sqlite'
import { importLibraryIndex } from '@core/library/import'
import { listAccounts, listAssets, listGames } from '@core/library/queries'
import { AppError } from '@shared/errors'
import { createMemoryDatabase } from '../helpers/database'

const ACCOUNT_KEY = 'steam-1078416773'
const GAME_KEY = 'steam-1030300'

let workDir: string
let libraryRoot: string
let db: SqliteDatabase

function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 按归档的布局写一份图库条目：originals/... 原图 + metadata/... 说明文件。 */
function putEntry(input: {
  content: string
  accountKey?: string
  gameKey?: string
  gameName?: string
  capturedAt?: string | null
  skipOriginal?: boolean
  metadataPatch?: Record<string, unknown>
}) {
  const accountKey = input.accountKey ?? ACCOUNT_KEY
  const gameKey = input.gameKey ?? GAME_KEY
  const sha256 = sha256Of(input.content)
  const assetId = randomUUID()
  const originalRelative = `originals/${accountKey}/${gameKey}/${sha256}.jpg`
  if (!input.skipOriginal) {
    const originalPath = join(libraryRoot, ...originalRelative.split('/'))
    mkdirSync(dirname(originalPath), { recursive: true })
    writeFileSync(originalPath, input.content, 'utf8')
  }
  const metadataRelative = `metadata/${accountKey}/${gameKey}/${sha256}.json`
  const metadataPath = join(libraryRoot, ...metadataRelative.split('/'))
  mkdirSync(dirname(metadataPath), { recursive: true })
  const payload = {
    schemaVersion: 1,
    assetId,
    accountKey,
    gameKey,
    gameName: input.gameName ?? '半衰期',
    originalFilename: '20260622091808_1.jpg',
    sha256,
    bytes: Buffer.byteLength(input.content),
    ext: '.jpg',
    width: 2560,
    height: 1406,
    capturedAt: input.capturedAt === undefined ? '2026-06-22T01:18:08.000Z' : input.capturedAt,
    captureTimeSource: 'screenshot-index',
    archivedAt: '2026-10-05T04:42:34.069Z',
    ...input.metadataPatch
  }
  writeFileSync(metadataPath, JSON.stringify(payload, null, 2), 'utf8')
  return { assetId, sha256, relativePath: originalRelative }
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'ssm-import-'))
  libraryRoot = join(workDir, 'Steam截图')
  mkdirSync(join(libraryRoot, 'metadata'), { recursive: true })
  mkdirSync(join(libraryRoot, 'originals'), { recursive: true })
  db = await createMemoryDatabase()
  migrate(db)
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('从图库目录重建索引', () => {
  it('按说明文件重建游戏、账号、资产与副本，图片可直接展示', async () => {
    const first = putEntry({ content: 'shot-1' })
    putEntry({ content: 'shot-2' })

    const summary = await importLibraryIndex(db, { libraryRoot })

    expect(summary.scanned).toBe(2)
    expect(summary.imported).toBe(2)
    expect(summary.skipped).toBe(0)
    expect(summary.failed).toBe(0)
    expect(summary.games).toBe(1)
    expect(summary.accounts).toBe(1)

    const games = listGames(db)
    expect(games).toHaveLength(1)
    expect(games[0]).toMatchObject({ gameKey: GAME_KEY, name: '半衰期', appId: '1030300', assetCount: 2 })

    const accounts = listAccounts(db)
    expect(accounts[0]).toMatchObject({ accountKey: ACCOUNT_KEY, assetCount: 2 })

    const page = listAssets(db, {})
    expect(page.items).toHaveLength(2)
    // 副本存在 → 可读，且沿用元数据里的 assetId 与原名
    expect(page.items.every((item) => item.available && item.archived)).toBe(true)
    expect(page.items.map((item) => item.assetId)).toContain(first.assetId)
    expect(page.items[0]!.originalFilename).toBe('20260622091808_1.jpg')
    expect(page.items[0]!.width).toBe(2560)
  })

  it('重复导入幂等：不新增行，只记已有', async () => {
    putEntry({ content: 'shot-1' })
    await importLibraryIndex(db, { libraryRoot })
    const again = await importLibraryIndex(db, { libraryRoot })

    expect(again.imported).toBe(0)
    expect(again.skipped).toBe(1)
    expect(listAssets(db, {}).items).toHaveLength(1)
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM local_copies').get() as { n: number }).n)).toBe(1)
  })

  it('索引里已有同一张图时复用原 assetId（不打断已有引用）', async () => {
    const entry = putEntry({ content: 'shot-1' })
    const existingAssetId = randomUUID()
    db.prepare(
      `INSERT INTO assets (asset_id, account_key, game_key, sha256, bytes, ext, width, height, captured_at, capture_time_source, created_at)
       VALUES (?, ?, ?, ?, 6, '.jpg', 1920, 1080, NULL, 'screenshot-index', '2026-09-21T00:00:00.000Z')`
    ).run(existingAssetId, ACCOUNT_KEY, GAME_KEY, entry.sha256)

    const summary = await importLibraryIndex(db, { libraryRoot })

    expect(summary.imported).toBe(0)
    expect(summary.skipped).toBe(1)
    const items = listAssets(db, {}).items
    expect(items).toHaveLength(1)
    expect(items[0]!.assetId).toBe(existingAssetId)
    // 元数据补上了尺寸与原文件名
    expect(items[0]!.width).toBe(2560)
    expect(items[0]!.originalFilename).toBe('20260622091808_1.jpg')
  })

  it('原图缺失、字段非法都不写入，只计失败并给出原因', async () => {
    putEntry({ content: 'ok' })
    putEntry({ content: 'gone', skipOriginal: true })
    putEntry({ content: 'bad-hash', metadataPatch: { sha256: 'not-a-hash' } })

    const summary = await importLibraryIndex(db, { libraryRoot })

    expect(summary.scanned).toBe(3)
    expect(summary.imported).toBe(1)
    expect(summary.failed).toBe(2)
    expect(summary.failures.join(' ')).toContain('原图缺失')
    expect(summary.failures.join(' ')).toContain('sha256')
    expect(listAssets(db, {}).items).toHaveLength(1)
  })

  it('没有 metadata/ 的目录直接拒绝，而不是当成空图库', async () => {
    rmSync(join(libraryRoot, 'metadata'), { recursive: true, force: true })
    await expect(importLibraryIndex(db, { libraryRoot })).rejects.toThrow(AppError)
    await expect(importLibraryIndex(db, { libraryRoot })).rejects.toThrow(/metadata/)
  })

  it('可以被取消：已读到的批次照常写入，取消后不再继续读', async () => {
    for (let index = 0; index < 70; index += 1) {
      putEntry({ content: `shot-${index}` })
    }
    let calls = 0
    const summary = await importLibraryIndex(db, {
      libraryRoot,
      shouldCancel: () => {
        calls += 1
        return calls > 1
      }
    })
    expect(calls).toBeGreaterThan(1)
    // 一批 32 份说明文件，第一批读完后取消，剩下的不再读
    expect(summary.imported).toBe(32)
    expect(summary.failures.join(' ')).toContain('已取消')
  })
})
