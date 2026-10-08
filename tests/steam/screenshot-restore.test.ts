import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from '@node-steam/vdf'
import { appendScreenshots } from '@core/steam/screenshot-index-writer'
import { executeSteamScreenshots, planSteamScreenshots, rollbackSteamScreenshots, listSteamScreenshotBackups, type SteamScreenshotAsset } from '@core/steam/screenshot-restore'
import { parseSteamScreenshotPreview, parseSteamScreenshotJob } from '../../src/main/payloads'

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'ssm-restore-'))
  const root = join(base, 'steam'), accountId = '1234', target = join(root, 'userdata', accountId, '760')
  mkdirSync(join(root, 'userdata', accountId), { recursive: true })
  const source = join(base, 'source.jpg'), bytes = Buffer.from('original immutable bytes')
  writeFileSync(source, bytes)
  const asset: SteamScreenshotAsset = { assetId: 'asset', accountKey: 'steam-1234', gameKey: 'steam-42', gameName: '样本', filename: '20261008120000_1.jpg', source, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, width: 1920, height: 1080, capturedAt: '2026-10-08T04:00:00Z' }
  const backupRoot = join(base, 'backups')
  const options = { backupRoot, assertStopped: () => {}, thumbnail: async () => Buffer.from('generated-thumbnail') }
  return { root, accountId, target, asset, backupRoot, options }
}
describe('Steam 截图恢复', () => {
  it('保留既有文本和未知字段，新增正确登记且不伪造社区字段', () => {
    const old = '"screenshots"\r\n{\r\n\t// 原有注释\r\n\t"42"\r\n\t{\r\n\t\t"0"\r\n\t\t{\r\n\t\t\t"filename" "42/screenshots/old.jpg"\r\n\t\t\t"unknown" "keep"\r\n\t\t}\r\n\t}\r\n}\r\n'
    const result = appendScreenshots(old, [{ gameId: '42', filename: 'new.jpg', width: 1, height: 1, creation: 123 }])
    expect(result).toContain('"unknown" "keep"')
    expect(result).toContain('// 原有注释')
    expect(result).not.toContain('publishedfileid')
    const parsed = parse(result) as { screenshots: Record<string, Record<string, unknown>> }
    expect(Object.keys(parsed.screenshots['42']!)).toHaveLength(2)
    expect(() => appendScreenshots('"screenshots" { "42" {} "42" {} }', [])).toThrow()
  }, 30_000)
  it('恢复、重新预览跳过及回滚，原图始终不变', async () => {
    const f = fixture(), plan = await planSteamScreenshots(f.root, f.accountId, [f.asset])
    expect(plan.preview.added).toBe(1)
    const result = await executeSteamScreenshots(plan, f.options)
    expect(result.restored).toBe(1)
    expect(readFileSync(join(f.target, 'remote/42/screenshots', f.asset.filename))).toEqual(readFileSync(f.asset.source))
    expect((await planSteamScreenshots(f.root, f.accountId, [f.asset])).preview.skipped).toBe(1)
    await rollbackSteamScreenshots(f.backupRoot, result.jobId, () => {})
    expect(existsSync(join(f.target, 'screenshots.vdf'))).toBe(false)
    expect(existsSync(join(f.target, 'remote/42/screenshots', f.asset.filename))).toBe(false)
    expect(listSteamScreenshotBackups(f.backupRoot)[0]?.status).toBe('rolled-back')
  }, 30_000)
  it('缩略图生成失败时回滚已复制原件并保留既有索引字节', async () => {
    const f = fixture()
    mkdirSync(f.target, { recursive: true })
    const originalIndex = '"screenshots"\n{\n// unchanged\n}\n'
    writeFileSync(join(f.target, 'screenshots.vdf'), originalIndex)
    const plan = await planSteamScreenshots(f.root, f.accountId, [f.asset])
    await expect(executeSteamScreenshots(plan, { ...f.options, thumbnail: async () => { throw new Error('decode failed') } })).rejects.toThrow('decode failed')
    expect(readFileSync(join(f.target, 'screenshots.vdf'), 'utf8')).toBe(originalIndex)
    expect(existsSync(join(f.target, 'remote/42/screenshots', f.asset.filename))).toBe(false)
  }, 30_000)
  it('同名冲突不覆盖，跨账号与非 JPEG 明确不支持', async () => {
    const f = fixture(), path = join(f.target, 'remote/42/screenshots', f.asset.filename)
    mkdirSync(join(f.target, 'remote/42/screenshots'), { recursive: true }); writeFileSync(path, 'keep')
    const plan = await planSteamScreenshots(f.root, f.accountId, [f.asset, { ...f.asset, accountKey: 'steam-999' }, { ...f.asset, filename: 'other.png' }])
    expect(plan.preview.conflicts).toBe(1); expect(plan.preview.unsupported).toBe(2)
    expect(readFileSync(path, 'utf8')).toBe('keep')
  }, 30_000)
  it('预览后变化或 Steam 正在运行时零写入', async () => {
    const f = fixture(), plan = await planSteamScreenshots(f.root, f.accountId, [f.asset])
    await expect(executeSteamScreenshots(plan, { ...f.options, assertStopped: () => { throw new Error('running') } })).rejects.toThrow('running')
    expect(existsSync(f.backupRoot)).toBe(false)
    mkdirSync(f.target, { recursive: true }); writeFileSync(join(f.target, 'screenshots.vdf'), 'changed')
    await expect(executeSteamScreenshots(plan, f.options)).rejects.toThrow('变化')
    expect(existsSync(f.backupRoot)).toBe(false)
  }, 30_000)
  it('取消后撤销新增内容，外部修改阻止回滚', async () => {
    const f = fixture(), plan = await planSteamScreenshots(f.root, f.accountId, [f.asset])
    const cancelled = await executeSteamScreenshots(plan, { ...f.options, shouldCancel: () => true })
    expect(cancelled.cancelled).toBe(true); expect(cancelled.rolledBack).toBe(true)
    const result = await executeSteamScreenshots(await planSteamScreenshots(f.root, f.accountId, [f.asset]), f.options)
    writeFileSync(join(f.target, 'screenshots.vdf'), 'external')
    await expect(rollbackSteamScreenshots(f.backupRoot, result.jobId, () => {})).rejects.toThrow('外部修改')
    expect(readFileSync(join(f.target, 'screenshots.vdf'), 'utf8')).toBe('external')
  }, 30_000)
  it('IPC 拒绝任意路径、空范围及伪造任务标识', () => {
    expect(() => parseSteamScreenshotPreview({ targetId: 'C:/Steam', accountId: '1234', gameKeys: ['steam-42'] })).toThrow()
    expect(() => parseSteamScreenshotPreview({ targetId: '1', accountId: '../1234', gameKeys: [] })).toThrow()
    expect(() => parseSteamScreenshotJob({ planId: '../file' }, 'planId')).toThrow()
  }, 30_000)
  it('成功合并后可逐字节还原原有索引', async () => {
    const f = fixture(); mkdirSync(f.target, { recursive: true })
    const index = '"screenshots"\r\n{\r\n\t// original\r\n\t"unknown"\r\n\t{\r\n\t\t"keep" "yes"\r\n\t}\r\n}\r\n'
    writeFileSync(join(f.target, 'screenshots.vdf'), index)
    const result = await executeSteamScreenshots(await planSteamScreenshots(f.root, f.accountId, [f.asset]), f.options)
    expect(readFileSync(join(f.target, 'screenshots.vdf'), 'utf8')).toContain('"keep" "yes"')
    await rollbackSteamScreenshots(f.backupRoot, result.jobId, () => {})
    expect(readFileSync(join(f.target, 'screenshots.vdf'), 'utf8')).toBe(index)
  }, 30_000)
  it('发布期间出现同名文件时不覆盖，回滚只删除本任务拥有的文件', async () => {
    const f = fixture(), external = join(f.target, 'remote/42/screenshots/thumbnails', f.asset.filename)
    const plan = await planSteamScreenshots(f.root, f.accountId, [f.asset])
    await expect(executeSteamScreenshots(plan, { ...f.options, thumbnail: async () => {
      mkdirSync(join(external, '..'), { recursive: true }); writeFileSync(external, 'external created during execution')
      return Buffer.from('generated-thumbnail')
    } })).rejects.toThrow()
    expect(readFileSync(external, 'utf8')).toBe('external created during execution')
    expect(existsSync(join(f.target, 'remote/42/screenshots', f.asset.filename))).toBe(false)
  }, 30_000)
})
