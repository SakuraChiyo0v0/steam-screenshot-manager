import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '@core/db/migrations'
import type { SqliteDatabase } from '@core/db/sqlite'
import { planRestoreGames, restoreAssets, type RemoteRecordEntry } from '@core/sync/restore'
import type { DavClient } from '@core/sync/webdav'
import { createMemoryDatabase } from '../helpers/database'

const LIBRARY_ID = '0f0f0f0f-1111-4222-8333-444444444444'
const ACCOUNT_KEY = 'steam-1000000001'
const GAME_KEY = 'steam-438100'
const DEVICE_ID = 'dev-1'
const UPLOAD_ID = 'up-1'

let workDir: string
let remoteDir: string
let libraryRoot: string
let db: SqliteDatabase

function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 在"远端"放一个对象，返回可用于构造记录的字段。 */
function putRemoteObject(fileName: string, content: string, gameKey = GAME_KEY) {
  const objectKey = `steam-gallery-v1/${LIBRARY_ID}/originals/${ACCOUNT_KEY}/${gameKey}/${DEVICE_ID}/${UPLOAD_ID}/${sha256Of(content)}${fileName.slice(fileName.lastIndexOf('.'))}`
  const absolute = join(remoteDir, ...objectKey.split('/'))
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content, 'utf8')
  return {
    objectKey,
    sha256: sha256Of(content),
    bytes: Buffer.byteLength(content),
    originalFilename: fileName,
    gameKey
  }
}

function toRecord(
  object: ReturnType<typeof putRemoteObject>,
  index: number,
  overrides: Partial<RemoteRecordEntry> = {}
): RemoteRecordEntry {
  return {
    recordId: `rec-${index}`,
    deviceId: DEVICE_ID,
    accountKey: ACCOUNT_KEY,
    gameKey: object.gameKey,
    gameName: object.gameKey === GAME_KEY ? 'VRChat' : object.gameKey,
    originalFilename: object.originalFilename,
    sha256: object.sha256,
    bytes: object.bytes,
    ext: object.objectKey.slice(object.objectKey.lastIndexOf('.')),
    width: 1920,
    height: 1080,
    capturedAt: '2026-05-04T10:00:00.000Z',
    captureTimeSource: 'screenshot-index',
    objectKey: object.objectKey,
    recordKey: `steam-gallery-v1/${LIBRARY_ID}/records/dev-1/2026-05/rec-${index}.json`,
    ...overrides
  }
}

/** 只实现恢复需要的下载能力：从"远端"目录复制到目标路径并算哈希。 */
function fakeClient(options: { corrupt?: boolean } = {}): DavClient {
  return {
    async downloadToFile(relativePath: string, targetPath: string) {
      const source = join(remoteDir, ...relativePath.split('/'))
      if (!existsSync(source)) {
        return null
      }
      const buffer = readFileSync(source)
      const content = options.corrupt ? Buffer.concat([buffer, Buffer.from('x')]) : buffer
      mkdirSync(dirname(targetPath), { recursive: true })
      writeFileSync(targetPath, content)
      return {
        status: 200,
        sha256: createHash('sha256').update(content).digest('hex'),
        bytes: content.length
      }
    }
  } as unknown as DavClient
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'ssm-restore-'))
  remoteDir = join(workDir, 'remote')
  libraryRoot = join(workDir, 'library')
  mkdirSync(remoteDir, { recursive: true })
  mkdirSync(libraryRoot, { recursive: true })
  db = await createMemoryDatabase()
  migrate(db)
})

afterEach(() => {
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('恢复计划', () => {
  it('按游戏汇总，同指纹多条记录只算一个资产', () => {
    const a = putRemoteObject('a.jpg', 'content-a')
    const b = putRemoteObject('b.jpg', 'content-b')
    const records = [toRecord(a, 1), toRecord(a, 2), toRecord(b, 3)]

    const plan = planRestoreGames(db, records, libraryRoot)

    expect(plan).toHaveLength(1)
    expect(plan[0]!.assets).toBe(2)
    expect(plan[0]!.bytes).toBe(a.bytes + b.bytes)
    expect(plan[0]!.alreadyLocal).toBe(0)
  })

  it('已在本机图库中的资产单独计数', async () => {
    const a = putRemoteObject('a.jpg', 'content-a')
    const records = [toRecord(a, 1)]
    await restoreAssets(db, {
      libraryRoot,
      libraryId: LIBRARY_ID,
      client: fakeClient(),
      records
    })

    const plan = planRestoreGames(db, records, libraryRoot)
    expect(plan[0]!.alreadyLocal).toBe(1)
  })
})

describe('恢复执行', () => {
  it('恢复写入受管副本、资产行与说明文件', async () => {
    const a = putRemoteObject('a.jpg', 'content-a')
    const result = await restoreAssets(db, {
      libraryRoot,
      libraryId: LIBRARY_ID,
      client: fakeClient(),
      records: [toRecord(a, 1)]
    })

    expect(result.restored).toBe(1)
    expect(result.failed).toBe(0)

    const relativePath = `originals/${ACCOUNT_KEY}/${GAME_KEY}/${a.sha256}.jpg`
    expect(existsSync(join(libraryRoot, relativePath))).toBe(true)
    expect(readFileSync(join(libraryRoot, relativePath), 'utf8')).toBe('content-a')

    const asset = db
      .prepare('SELECT asset_id AS assetId, original_filename AS originalFilename FROM assets')
      .get() as { assetId: string; originalFilename: string }
    expect(asset.originalFilename).toBe('a.jpg')

    const copy = db
      .prepare('SELECT relative_path AS relativePath, present FROM local_copies WHERE asset_id = ?')
      .get(asset.assetId) as { relativePath: string; present: number }
    expect(copy.relativePath).toBe(relativePath)
    expect(copy.present).toBe(1)

    const game = db
      .prepare('SELECT name, installed FROM games WHERE game_key = ?')
      .get(GAME_KEY) as { name: string; installed: number }
    expect(game.name).toBe('VRChat')
    expect(game.installed).toBe(0)

    const metadata = JSON.parse(
      readFileSync(
        join(libraryRoot, 'metadata', ACCOUNT_KEY, GAME_KEY, `${a.sha256}.json`),
        'utf8'
      )
    ) as { originalFilename: string; restoredFrom: { libraryId: string } }
    expect(metadata.originalFilename).toBe('a.jpg')
    expect(metadata.restoredFrom.libraryId).toBe(LIBRARY_ID)
  })

  it('重复恢复只跳过不重复下载（续传）', async () => {
    const a = putRemoteObject('a.jpg', 'content-a')
    const records = [toRecord(a, 1)]

    const first = await restoreAssets(db, {
      libraryRoot,
      libraryId: LIBRARY_ID,
      client: fakeClient(),
      records
    })
    const second = await restoreAssets(db, {
      libraryRoot,
      libraryId: LIBRARY_ID,
      client: fakeClient(),
      records
    })

    expect(first.restored).toBe(1)
    expect(second.restored).toBe(0)
    expect(second.skipped).toBe(1)
    expect(
      Number(
        (db.prepare('SELECT COUNT(*) AS n FROM local_copies').get() as { n: number }).n
      )
    ).toBe(1)
  })

  it('下载内容与记录不一致时拒绝发布', async () => {
    const a = putRemoteObject('a.jpg', 'content-a')
    const result = await restoreAssets(db, {
      libraryRoot,
      libraryId: LIBRARY_ID,
      client: fakeClient({ corrupt: true }),
      records: [toRecord(a, 1)]
    })

    expect(result.restored).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.failures[0]!.code).toBe('LIB_HASH_MISMATCH')
    expect(existsSync(join(libraryRoot, `originals/${ACCOUNT_KEY}/${GAME_KEY}/${a.sha256}.jpg`))).toBe(
      false
    )
  })

  it('远端对象缺失记为失败且不写库', async () => {
    const a = putRemoteObject('a.jpg', 'content-a')
    const record = toRecord(a, 1, { objectKey: `${a.objectKey}.missing` })
    const result = await restoreAssets(db, {
      libraryRoot,
      libraryId: LIBRARY_ID,
      client: fakeClient(),
      records: [record]
    })

    expect(result.failed).toBe(1)
    expect(result.failures[0]!.code).toBe('SRC_NOT_FOUND')
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM assets').get() as { n: number }).n)).toBe(0)
  })

  it('可按游戏筛选恢复范围', async () => {
    const a = putRemoteObject('a.jpg', 'content-a')
    const b = putRemoteObject('b.jpg', 'content-b', 'steam-999999')
    const result = await restoreAssets(db, {
      libraryRoot,
      libraryId: LIBRARY_ID,
      client: fakeClient(),
      records: [toRecord(a, 1), toRecord(b, 2)],
      gameKeys: [GAME_KEY]
    })

    expect(result.total).toBe(1)
    expect(result.restored).toBe(1)
    expect(
      Number((db.prepare('SELECT COUNT(*) AS n FROM games').get() as { n: number }).n)
    ).toBe(1)
  })

  it('恢复时登记该远端已有这些资产，避免换机后重复上传', async () => {
    const a = putRemoteObject('a.jpg', 'content-a')
    const records = [toRecord(a, 1)]

    await restoreAssets(db, {
      libraryRoot,
      remoteId: 'remote-1',
      libraryId: LIBRARY_ID,
      client: fakeClient(),
      records
    })

    const row = db
      .prepare(
        "SELECT publish_status AS status, object_key AS objectKey FROM remote_objects WHERE remote_id = 'remote-1'"
      )
      .get() as { status: string; objectKey: string } | undefined
    expect(row?.status).toBe('verified')
    expect(row?.objectKey).toBe(a.objectKey)

    // 重跑（走跳过分支）也要保持登记，且不产生重复行
    await restoreAssets(db, {
      libraryRoot,
      remoteId: 'remote-1',
      libraryId: LIBRARY_ID,
      client: fakeClient(),
      records
    })
    expect(
      Number(
        (db.prepare("SELECT COUNT(*) AS n FROM remote_objects WHERE remote_id = 'remote-1'").get() as {
          n: number
        }).n
      )
    ).toBe(1)
  })

  it('取消后保留已完成部分', async () => {
    const a = putRemoteObject('a.jpg', 'content-a')
    const b = putRemoteObject('b.jpg', 'content-b')
    let calls = 0
    const result = await restoreAssets(db, {
      libraryRoot,
      libraryId: LIBRARY_ID,
      client: fakeClient(),
      records: [toRecord(a, 1), toRecord(b, 2)],
      // 每处理完一项后检查一次：第一次检查放行，第二次检查时停止
      shouldCancel: () => {
        calls += 1
        return calls > 1
      }
    })

    expect(result.cancelled).toBe(true)
    expect(result.restored).toBe(1)
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM local_copies').get() as { n: number }).n)).toBe(1)
  })
})
