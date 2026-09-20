import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '@shared/errors'
import {
  isInsideRoot,
  resolveAssetPath,
  resolveExistingAssetPath
} from '@core/library/asset-paths'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ssm-assets-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('资产路径边界（词法检查）', () => {
  const root = 'C:\\library\\root'

  it('接受根目录内的相对路径', () => {
    expect(resolveAssetPath(root, '438100/screenshots/a.jpg')).toBe(
      'C:\\library\\root\\438100\\screenshots\\a.jpg'
    )
  })

  it('拒绝包含上级目录的相对路径', () => {
    expect(() => resolveAssetPath(root, '../secret.jpg')).toThrowError(AppError)
    expect(() => resolveAssetPath(root, '438100/../../secret.jpg')).toThrowError(AppError)
  })

  it('拒绝绝对路径与盘符路径', () => {
    expect(() => resolveAssetPath(root, 'C:\\Windows\\System32\\config\\SAM')).toThrowError(AppError)
    expect(() => resolveAssetPath(root, '/etc/passwd')).toThrowError(AppError)
  })

  it('拒绝空路径与含空字节的路径', () => {
    expect(() => resolveAssetPath(root, '')).toThrowError(AppError)
    expect(() => resolveAssetPath(root, 'a\u0000b.jpg')).toThrowError(AppError)
  })

  it('isInsideRoot 正确区分同根、子路径与外部路径', () => {
    expect(isInsideRoot('C:\\a', 'C:\\a')).toBe(true)
    expect(isInsideRoot('C:\\a', 'C:\\a\\b\\c.jpg')).toBe(true)
    expect(isInsideRoot('C:\\a', 'C:\\ab\\c.jpg')).toBe(false)
    expect(isInsideRoot('C:\\a\\b', 'C:\\a')).toBe(false)
  })
})

describe('资产路径边界（真实文件）', () => {
  it('文件存在且位于根内时返回真实路径', async () => {
    const file = join(workDir, 'shot.jpg')
    writeFileSync(file, 'x')

    const resolved = await resolveExistingAssetPath(workDir, 'shot.jpg')
    expect(resolved.toLowerCase()).toContain('shot.jpg')
  })

  it('文件不存在时报错，不返回路径', async () => {
    await expect(resolveExistingAssetPath(workDir, 'missing.jpg')).rejects.toThrowError(AppError)
  })

  it('越界路径在词法阶段就被拒绝', async () => {
    await expect(resolveExistingAssetPath(workDir, '../outside.jpg')).rejects.toThrowError(AppError)
  })
})
