import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '@core/db/migrations'
import type { SqliteDatabase } from '@core/db/sqlite'
import {
  buildExportRelativePath,
  countFilesRecursively,
  exportAssets,
  sanitizeSegment,
  type ExportItem
} from '@core/library/export'
import { archiveAssets } from '@core/library/archive'
import { createMemoryDatabase } from '../helpers/database'

const SOURCE_ID = '11111111-2222-4333-8444-555555555555'
const ACCOUNT_KEY = 'steam-1000000001'
const GAME_KEY = 'steam-438100'
const SEEN_AT = '2026-09-21T00:00:00.000Z'

let workDir: string
let sourceRoot: string
let libraryRoot: string
let targetDir: string
let db: SqliteDatabase

function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function putSourceFile(fileName: string, content: string, gameDir = '438100') {
  const relativePath = `userdata/1000000001/760/remote/${gameDir}/screenshots/${fileName}`
  const absolutePath = join(sourceRoot, ...relativePath.split('/'))
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, content, 'utf8')
  return { relativePath, sha256: sha256Of(content), bytes: Buffer.byteLength(content) }
}

function seedAsset(file: { relativePath: string; sha256: string; bytes: number }) {
  const assetId = randomUUID()
  db.prepare(
    `INSERT INTO assets (asset_id, account_key, game_key, sha256, bytes, ext, width, height, captured_at, capture_time_source, created_at)
     VALUES (?, ?, ?, ?, ?, '.jpg', 1920, 1080, '2026-05-01T12:00:00.000Z', 'screenshot-index', ?)`
  ).run(assetId, ACCOUNT_KEY, GAME_KEY, file.sha256, file.bytes, SEEN_AT)
  db.prepare(
    `INSERT INTO source_files (source_file_id, source_id, account_key, asset_id, relative_path, size, mtime_ms, has_thumbnail, present, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, 1000, 0, 1, ?)`
  ).run(randomUUID(), SOURCE_ID, ACCOUNT_KEY, assetId, file.relativePath, file.bytes, SEEN_AT)
  return assetId
}

async function setup() {
  workDir = mkdtempSync(join(tmpdir(), 'ssm-export-'))
  sourceRoot = join(workDir, 'source')
  libraryRoot = join(workDir, 'library')
  targetDir = join(workDir, 'exported')
  mkdirSync(sourceRoot, { recursive: true })

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

describe('导出路径规则', () => {
  const item: ExportItem = {
    assetId: 'a',
    gameKey: GAME_KEY,
    gameName: 'VRChat',
    appId: '438100',
    sha256: 'abcdef0123456789',
    bytes: 10,
    originalFilename: '20260501120000_1.jpg',
    capturedAt: '2026-05-01T12:00:00.000Z',
    sourceRoot: 'C:\\src',
    sourceRelativePath: 'x/y.jpg',
    libraryRelativePath: null,
    libraryRoot: null
  }

  it('按游戏名布局', () => {
    expect(buildExportRelativePath(item, 'game')).toBe('VRChat/20260501120000_1.jpg')
  })

  it('按游戏名＋年份布局', () => {
    expect(buildExportRelativePath(item, 'game-year')).toBe('VRChat/2026/20260501120000_1.jpg')
  })

  it('按游戏名＋AppID 布局', () => {
    expect(buildExportRelativePath(item, 'game-appid')).toBe('VRChat (438100)/20260501120000_1.jpg')
  })

  it('平铺布局不建子目录', () => {
    expect(buildExportRelativePath(item, 'flat')).toBe('20260501120000_1.jpg')
  })

  it('拍摄时间未知时用明确文案而不是伪造年份', () => {
    expect(buildExportRelativePath({ ...item, capturedAt: null }, 'game-year')).toBe(
      'VRChat/时间未知/20260501120000_1.jpg'
    )
  })

  it('超长文件名被规范化到可控长度', () => {
    const long = { ...item, originalFilename: `${'很长的名字'.repeat(20)}.jpg` }
    const relativePath = buildExportRelativePath(long, 'game')
    expect(relativePath.length).toBeLessThanOrEqual(180)
    expect(relativePath.endsWith('.jpg')).toBe(true)
  })

  it('极端输入下路径长度仍然有界（各段分别截断）', () => {
    const long = { ...item, gameName: '很长的游戏名'.repeat(30), originalFilename: `${'n'.repeat(300)}.jpg` }
    const relativePath = buildExportRelativePath(long, 'game-appid')
    expect(relativePath.length).toBeLessThanOrEqual(180)
    expect(relativePath.endsWith('.jpg')).toBe(true)
  })
})

describe('Windows 片段规范化', () => {
  it('替换非法字符并处理结尾点与空格', () => {
    expect(sanitizeSegment('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j')
    expect(sanitizeSegment('name. ')).toBe('name')
  })

  it('保留名前加下划线', () => {
    expect(sanitizeSegment('CON')).toBe('_CON')
    expect(sanitizeSegment('nul.txt')).toBe('_nul.txt')
  })

  it('空值退化为 unknown，超长被截断', () => {
    expect(sanitizeSegment('   ')).toBe('unknown')
    expect(sanitizeSegment('x'.repeat(200)).length).toBeLessThanOrEqual(64)
  })
})

describe('导出执行', () => {
  it('导出后文件存在且内容与指纹一致', async () => {
    const file = putSourceFile('a.jpg', 'content-a')
    seedAsset(file)

    const result = await exportAssets(db, { targetDir, layout: 'game-year' })

    expect(result.written).toBe(1)
    expect(result.failed).toBe(0)
    const exported = join(targetDir, 'VRChat', '2026', 'a.jpg')
    expect(existsSync(exported)).toBe(true)
    expect(sha256Of(readFileSync(exported, 'utf8'))).toBe(file.sha256)
  })

  it('目标已存在且内容相同：跳过不重复写', async () => {
    const file = putSourceFile('a.jpg', 'content-a')
    seedAsset(file)

    await exportAssets(db, { targetDir, layout: 'flat' })
    const second = await exportAssets(db, { targetDir, layout: 'flat' })

    expect(second.skipped).toBe(1)
    expect(second.written).toBe(0)
    expect(countFilesRecursively(targetDir)).toBe(1)
  })

  it('同名不同内容：保留两份，不覆盖已有文件', async () => {
    const first = putSourceFile('same.jpg', 'first-content')
    seedAsset(first)
    const target = join(targetDir, 'same.jpg')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'existing-different', 'utf8')

    const result = await exportAssets(db, { targetDir, layout: 'flat' })

    expect(result.conflictsRenamed).toBe(1)
    expect(result.written).toBe(1)
    expect(readFileSync(target, 'utf8')).toBe('existing-different')
    expect(countFilesRecursively(targetDir)).toBe(2)
  })

  it('优先使用图库副本：来源文件删掉也能导出', async () => {
    const file = putSourceFile('a.jpg', 'content-a')
    seedAsset(file)
    await archiveAssets(db, { libraryRoot })
    rmSync(join(sourceRoot, ...file.relativePath.split('/')), { force: true })

    const result = await exportAssets(db, { targetDir, layout: 'flat', libraryRoot })

    expect(result.written).toBe(1)
    expect(readFileSync(join(targetDir, 'a.jpg'), 'utf8')).toBe('content-a')
  })

  it('来源与图库副本都不可用时记为失败', async () => {
    const file = putSourceFile('a.jpg', 'content-a')
    seedAsset(file)
    rmSync(join(sourceRoot, ...file.relativePath.split('/')), { force: true })

    const result = await exportAssets(db, { targetDir, layout: 'flat' })

    expect(result.failed).toBe(1)
    expect(result.failures[0]!.message).toContain('不可用')
  })

  it('可按游戏筛选导出范围', async () => {
    seedAsset(putSourceFile('a.jpg', 'content-a'))
    const result = await exportAssets(db, {
      targetDir,
      layout: 'flat',
      gameKeys: ['steam-999999']
    })

    expect(result.total).toBe(0)
    expect(countFilesRecursively(targetDir)).toBe(0)
  })
})
