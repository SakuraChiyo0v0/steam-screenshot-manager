import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '@core/db/migrations'
import type { SqliteDatabase } from '@core/db/sqlite'
import {
  archiveAssets,
  copyWithHash,
  localCopyState,
  managedRelativePath,
  planArchive,
  reconcileLibrary
} from '@core/library/archive'
import { createMemoryDatabase } from '../helpers/database'

const SOURCE_ID = '11111111-2222-4333-8444-555555555555'
const ACCOUNT_KEY = 'steam-1000000001'
const GAME_KEY = 'steam-438100'
const SEEN_AT = '2026-09-21T00:00:00.000Z'

let workDir: string
let sourceRoot: string
let libraryRoot: string
let db: SqliteDatabase

function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 在来源根下放一个文件，返回它在数据库里需要的字段。 */
function putSourceFile(gameDir: string, fileName: string, content: string) {
  const relativePath = `userdata/1000000001/760/remote/${gameDir}/screenshots/${fileName}`
  const absolutePath = join(sourceRoot, ...relativePath.split('/'))
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, content, 'utf8')
  return {
    relativePath,
    sha256: sha256Of(content),
    bytes: Buffer.byteLength(content)
  }
}

function seedAsset(file: { relativePath: string; sha256: string; bytes: number }, name = 'a.jpg') {
  const assetId = randomUUID()
  db.prepare(
    `INSERT INTO assets (asset_id, account_key, game_key, sha256, bytes, ext, width, height, captured_at, capture_time_source, created_at)
     VALUES (?, ?, ?, ?, ?, '.jpg', 1920, 1080, '2026-05-01T00:00:00.000Z', 'screenshot-index', ?)`
  ).run(assetId, ACCOUNT_KEY, GAME_KEY, file.sha256, file.bytes, SEEN_AT)
  db.prepare(
    `INSERT INTO source_files (source_file_id, source_id, account_key, asset_id, relative_path, size, mtime_ms, has_thumbnail, present, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, 1000, 0, 1, ?)`
  ).run(randomUUID(), SOURCE_ID, ACCOUNT_KEY, assetId, file.relativePath, file.bytes, SEEN_AT)
  return { assetId, ...file, name }
}

async function setup() {
  workDir = mkdtempSync(join(tmpdir(), 'ssm-archive-'))
  sourceRoot = join(workDir, 'source')
  libraryRoot = join(workDir, 'library')
  mkdirSync(sourceRoot, { recursive: true })
  mkdirSync(libraryRoot, { recursive: true })

  db = await createMemoryDatabase()
  migrate(db)
  db.prepare(
    `INSERT INTO sources (source_id, root_path, kind, created_at, last_scan_at, last_scan_status, last_scan_error)
     VALUES (?, ?, 'manual', ?, NULL, NULL, NULL)`
  ).run(SOURCE_ID, sourceRoot, SEEN_AT)
  db.prepare(
    `INSERT INTO games (game_key, app_id, kind, name, name_source, installed, updated_at)
     VALUES (?, '438100', 'steam', 'VRChat', 'app-manifest', 1, ?)`
  ).run(GAME_KEY, SEEN_AT)
}

beforeEach(async () => {
  await setup()
})

afterEach(() => {
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('归档：复制进独立图库', () => {
  it('首次归档写入 originals、metadata 与 local_copies 记录', async () => {
    const file = putSourceFile('438100', 'a.jpg', 'content-a')
    const asset = seedAsset(file)

    const result = await archiveAssets(db, { libraryRoot })

    expect(result.copied).toBe(1)
    expect(result.failed).toBe(0)

    const relativePath = managedRelativePath({
      accountKey: ACCOUNT_KEY,
      gameKey: GAME_KEY,
      sha256: asset.sha256,
      ext: '.jpg'
    })
    expect(existsSync(join(libraryRoot, relativePath))).toBe(true)
    expect(readFileSync(join(libraryRoot, relativePath), 'utf8')).toBe('content-a')
    expect(existsSync(join(libraryRoot, 'metadata', ACCOUNT_KEY, GAME_KEY, `${asset.sha256}.json`))).toBe(true)
    expect(localCopyState(db, libraryRoot)).toEqual({ archived: 1, missing: 0 })
  })

  it('说明文件只含展示与重建字段，不含来源绝对路径', async () => {
    const file = putSourceFile('438100', 'a.jpg', 'content-a')
    const asset = seedAsset(file)
    await archiveAssets(db, { libraryRoot })

    const metadata = readFileSync(
      join(libraryRoot, 'metadata', ACCOUNT_KEY, GAME_KEY, `${asset.sha256}.json`),
      'utf8'
    )
    expect(metadata).not.toContain(sourceRoot)
    expect(metadata).not.toContain('userdata')
    expect(JSON.parse(metadata).originalFilename).toBe('a.jpg')
  })

  it('重复归档不重复复制（幂等）', async () => {
    const file = putSourceFile('438100', 'a.jpg', 'content-a')
    seedAsset(file)

    const first = await archiveAssets(db, { libraryRoot })
    const second = await archiveAssets(db, { libraryRoot })

    expect(first.copied).toBe(1)
    // 已归档的资产不会再进入计划：既不复制也不重复计数
    expect(second.total).toBe(0)
    expect(second.copied).toBe(0)
    expect(localCopyState(db, libraryRoot).archived).toBe(1)
  })

  it('文件已发布但记录丢失时可自愈（恢复场景）', async () => {
    const file = putSourceFile('438100', 'a.jpg', 'content-a')
    const asset = seedAsset(file)
    await archiveAssets(db, { libraryRoot })

    // 模拟"复制完成、记录未写入"就中断
    db.prepare('DELETE FROM local_copies WHERE asset_id = ?').run(asset.assetId)

    const recovered = await archiveAssets(db, { libraryRoot })

    expect(recovered.total).toBe(1)
    expect(recovered.copied).toBe(0)
    expect(recovered.skipped).toBe(1)
    expect(localCopyState(db, libraryRoot).archived).toBe(1)
  })

  it('目标已存在但内容不同：拒绝覆盖并报错', async () => {
    const file = putSourceFile('438100', 'a.jpg', 'content-a')
    const asset = seedAsset(file)
    const relativePath = managedRelativePath({
      accountKey: ACCOUNT_KEY,
      gameKey: GAME_KEY,
      sha256: asset.sha256,
      ext: '.jpg'
    })
    const target = join(libraryRoot, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, '已经存在的其他内容', 'utf8')

    const result = await archiveAssets(db, { libraryRoot })

    expect(result.copied).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.failures[0]!.message).toContain('不一致')
    expect(readFileSync(target, 'utf8')).toBe('已经存在的其他内容')
  })

  it('复制后指纹不一致：不发布、不残留 staging', async () => {
    const file = putSourceFile('438100', 'a.jpg', 'content-a')
    // 故意把索引里的指纹改成与实际内容不符，模拟来源被改动
    const asset = seedAsset({ ...file, sha256: sha256Of('不同的内容') })

    const result = await archiveAssets(db, { libraryRoot })

    expect(result.copied).toBe(0)
    expect(result.failed).toBe(1)
    const original = join(
      libraryRoot,
      managedRelativePath({ accountKey: ACCOUNT_KEY, gameKey: GAME_KEY, sha256: asset.sha256, ext: '.jpg' })
    )
    expect(existsSync(original)).toBe(false)
    expect(existsSync(join(libraryRoot, 'staging'))).toBe(true)
    expect(readdirSync(join(libraryRoot, 'staging'))).toEqual([])
  })

  it('来源文件缺失：记为失败并把来源标记为不存在', async () => {
    const file = putSourceFile('438100', 'a.jpg', 'content-a')
    const asset = seedAsset(file)
    rmSync(join(sourceRoot, ...file.relativePath.split('/')))

    const result = await archiveAssets(db, { libraryRoot })

    expect(result.failed).toBe(1)
    const row = db
      .prepare('SELECT present FROM source_files WHERE asset_id = ?')
      .get(asset.assetId) as { present: number }
    expect(row.present).toBe(0)
  })

  it('中断后重跑只处理剩余项（可恢复且不重复）', async () => {
    const first = seedAsset(putSourceFile('438100', 'a.jpg', 'content-a'))
    seedAsset(putSourceFile('438100', 'b.jpg', 'content-b'))

    let calls = 0
    const partial = await archiveAssets(db, {
      libraryRoot,
      shouldCancel: () => {
        calls += 1
        return calls > 1
      }
    })

    expect(partial.cancelled).toBe(true)
    expect(localCopyState(db, libraryRoot).archived).toBe(1)

    const rest = await archiveAssets(db, { libraryRoot })

    expect(rest.copied).toBe(1)
    expect(rest.skipped).toBe(0)
    expect(localCopyState(db, libraryRoot).archived).toBe(2)
    expect(existsSync(join(libraryRoot, managedRelativePath({ accountKey: ACCOUNT_KEY, gameKey: GAME_KEY, sha256: first.sha256, ext: '.jpg' })))).toBe(true)
  })

  it('对账：受管文件丢失则标记缺失，staging 残留被清理', async () => {
    const file = putSourceFile('438100', 'a.jpg', 'content-a')
    const asset = seedAsset(file)
    await archiveAssets(db, { libraryRoot })

    mkdirSync(join(libraryRoot, 'staging'), { recursive: true })
    writeFileSync(join(libraryRoot, 'staging', 'leftover.part'), 'partial', 'utf8')

    const reconciled = reconcileLibrary(db, libraryRoot)

    expect(reconciled.stagingCleaned).toBe(1)
    expect(reconciled.missing).toBe(0)
    expect(localCopyState(db, libraryRoot)).toEqual({ archived: 1, missing: 0 })

    // 删掉受管副本后再对账
    rmSync(
      join(libraryRoot, managedRelativePath({ accountKey: ACCOUNT_KEY, gameKey: GAME_KEY, sha256: asset.sha256, ext: '.jpg' })),
      { force: true }
    )
    const second = reconcileLibrary(db, libraryRoot)
    expect(second.missing).toBe(1)
    expect(localCopyState(db, libraryRoot)).toEqual({ archived: 0, missing: 1 })
  })

  it('复制到不可写目标时以拒绝方式失败，不抛未捕获错误（复验 P1 阻塞 2）', async () => {
    const source = join(workDir, 'source.bin')
    writeFileSync(source, 'payload', 'utf8')

    // 目标目录不存在：输出流会在打开时出错，必须变成 Promise 拒绝而不是未捕获的 'error' 事件
    await expect(copyWithHash(source, join(workDir, 'no-such-dir', 'target.bin'))).rejects.toThrow()

    // 进程仍然可用（未捕获的流错误会直接终止测试进程）
    expect(existsSync(source)).toBe(true)
  })

  it('归档计划只包含未归档资产', async () => {
    seedAsset(putSourceFile('438100', 'a.jpg', 'content-a'))
    expect(planArchive(db, { libraryRoot })).toHaveLength(1)

    await archiveAssets(db, { libraryRoot })
    expect(planArchive(db, { libraryRoot })).toHaveLength(0)
  })
})

