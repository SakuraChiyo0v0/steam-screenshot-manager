import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FolderRemoteClient, isUsableFolderRoot } from '@core/sync/folder-remote'
import { buildObjectKey, buildRecord, libraryRootPath } from '@core/sync/library-remote'
import { probeCapabilities } from '@core/sync/webdav'
import { AppError } from '@shared/errors'

const LIBRARY_ID = '0f0f0f0f-1111-4222-8333-444444444444'

let workDir: string
let remoteRoot: string
let client: FolderRemoteClient

function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ssm-folder-remote-'))
  remoteRoot = join(workDir, '远端备份')
  mkdirSync(remoteRoot, { recursive: true })
  client = new FolderRemoteClient(remoteRoot)
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('文件夹远端', () => {
  it('按远端语义放对象、读回来、算得出指纹', async () => {
    const objectKey = buildObjectKey(LIBRARY_ID, {
      accountKey: 'steam-1000000001',
      gameKey: 'steam-438100',
      deviceId: 'dev-1',
      uploadId: 'up-1',
      sha256: sha256Of('shot'),
      ext: '.jpg'
    })

    const local = join(workDir, 'local.jpg')
    writeFileSync(local, 'shot', 'utf8')

    expect(await client.putFile(objectKey, local)).toBe(201)
    // 父目录被自动建出来了
    expect(existsSync(join(remoteRoot, ...objectKey.split('/')))).toBe(true)

    const target = join(workDir, 'readback.jpg')
    const downloaded = await client.downloadToFile(objectKey, target)
    expect(downloaded?.sha256).toBe(sha256Of('shot'))
    expect(downloaded?.bytes).toBe(4)
    expect(readFileSync(target, 'utf8')).toBe('shot')

    // 读写都不留临时文件
    const leftovers = readdirSync(join(remoteRoot, ...objectKey.split('/').slice(0, -1))).filter((name) =>
      name.includes('ssm-tmp')
    )
    expect(leftovers).toEqual([])
  })

  it('文本记录：写入后读回一致，缺文件时返回 null', async () => {
    const recordKey = `${libraryRootPath(LIBRARY_ID)}/records/dev-1/2026-05/rec-1.json`
    const record = buildRecord({
      libraryId: LIBRARY_ID,
      recordId: 'rec-1',
      deviceId: 'dev-1',
      accountKey: 'steam-1000000001',
      gameKey: 'steam-438100',
      gameName: 'VRChat',
      originalFilename: '20260622091808_1.jpg',
      sha256: sha256Of('shot'),
      bytes: 4,
      ext: '.jpg',
      width: 1920,
      height: 1080,
      capturedAt: '2026-05-04T10:00:00.000Z',
      captureTimeSource: 'screenshot-index',
      importedAt: '2026-05-04T10:01:00.000Z',
      objectKey: `${libraryRootPath(LIBRARY_ID)}/originals/a/b/c/d/e.jpg`
    })

    await client.putText(recordKey, `${JSON.stringify(record, null, 2)}\n`)
    const readBack = await client.getText(recordKey)
    expect(readBack && JSON.parse(readBack)).toMatchObject({ recordId: 'rec-1', sha256: sha256Of('shot') })

    expect(await client.getText(`${libraryRootPath(LIBRARY_ID)}/records/none/2026-05/x.json`)).toBeNull()
    expect(await client.downloadToFile(`${libraryRootPath(LIBRARY_ID)}/originals/none.jpg`, join(workDir, 'x.jpg'))).toBeNull()
  })

  it('列目录给的是相对路径，末尾一段能被恢复流程直接用', async () => {
    await client.putText('steam-gallery-v1/lib/records/dev-1/2026-05/rec-1.json', '{}')
    await client.putText('steam-gallery-v1/lib/records/dev-1/2026-05/rec-2.json', '{}')

    const months = await client.list('steam-gallery-v1/lib/records')
    expect(months.hrefs.map((href) => href.split('/').pop())).toEqual(['dev-1'])

    const files = await client.list('steam-gallery-v1/lib/records/dev-1/2026-05')
    expect(files.hrefs.map((href) => href.split('/').pop()).sort()).toEqual(['rec-1.json', 'rec-2.json'])

    const missing = await client.list('steam-gallery-v1/lib/records/none')
    expect(missing).toEqual({ status: 404, hrefs: [] })
  })

  it('越界路径一律拒绝，不会写到远端根之外', async () => {
    expect(() => (client as unknown as { absolute: (p: string) => string }).absolute('../外面.txt')).toThrow(AppError)
    expect(() => (client as unknown as { absolute: (p: string) => string }).absolute('C:/windows/x.txt')).toThrow(AppError)
    expect(() => (client as unknown as { absolute: (p: string) => string }).absolute('/etc/passwd')).toThrow(AppError)
    await expect(client.putText('../外面.txt', 'x')).rejects.toThrow(AppError)
    expect(existsSync(join(workDir, '外面.txt'))).toBe(false)
  })

  it('删除文件与目录，重复删除不报错', async () => {
    await client.putText('a/b/c.txt', 'x')
    expect(await client.deleteFile('a/b/c.txt')).toBe(true)
    expect(await client.deleteFile('a/b/c.txt')).toBe(false)
    expect(await client.deleteCollection('a')).toBe(true)
    expect(await client.deleteCollection('a')).toBe(false)
    expect(readdirSync(remoteRoot)).toEqual([])
  })

  it('同一份能力探测能跑在文件夹远端上（上传/恢复只依赖这组动作）', async () => {
    const items = await probeCapabilities(client, '')
    expect(items.every((item) => item.ok)).toBe(true)
    // 探测目录最后会被清掉
    expect(readdirSync(remoteRoot).filter((name) => name.startsWith('dav-probe-'))).toEqual([])
  })

  it('远端根存在性检查给出可读原因', async () => {
    expect(await isUsableFolderRoot(remoteRoot)).toEqual({ ok: true })
    const missing = await isUsableFolderRoot(join(workDir, '没有这个目录'))
    expect(missing.ok).toBe(false)
    expect(missing.ok ? '' : missing.reason).toContain('不存在')
  })
})
