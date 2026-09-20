import { describe, expect, it } from 'vitest'
import { checkLibraryRoot, isSameOrInside, normalizeForCompare } from '@core/settings/library-root'

// 路径重叠规则依赖 Windows 的大小写不敏感语义，仅在 Windows 上验证。
describe.skipIf(process.platform !== 'win32')('图库根目录校验', () => {
  const protectedRoots = ['C:\\Users\\mafuyu\\AppData\\Roaming\\steam-screenshot-manager']
  const sourceRoots = ['C:\\LocalSpace\\softwares\\Steam']

  it('接受与来源和受保护目录都无关的目录', () => {
    const result = checkLibraryRoot({
      candidate: 'C:\\LocalSpace\\gallery',
      protectedRoots,
      sourceRoots
    })
    expect(result.ok).toBe(true)
  })

  it('拒绝与来源目录相同', () => {
    const result = checkLibraryRoot({
      candidate: 'C:\\LocalSpace\\softwares\\Steam',
      protectedRoots,
      sourceRoots
    })
    expect(result.ok).toBe(false)
  })

  it('拒绝位于来源目录之内（避免递归采集自身产物）', () => {
    const result = checkLibraryRoot({
      candidate: 'C:\\LocalSpace\\softwares\\Steam\\shots',
      protectedRoots,
      sourceRoots
    })
    expect(result.ok).toBe(false)
  })

  it('拒绝包含来源目录', () => {
    const result = checkLibraryRoot({
      candidate: 'C:\\LocalSpace',
      protectedRoots,
      sourceRoots
    })
    expect(result.ok).toBe(false)
  })

  it('拒绝指向受保护目录', () => {
    const result = checkLibraryRoot({
      candidate: protectedRoots[0],
      protectedRoots,
      sourceRoots
    })
    expect(result.ok).toBe(false)
  })

  it('拒绝包含受保护目录的父级路径', () => {
    const result = checkLibraryRoot({
      candidate: 'C:\\Users\\mafuyu',
      protectedRoots,
      sourceRoots
    })
    expect(result.ok).toBe(false)
  })

  it('忽略大小写与结尾分隔符', () => {
    const result = checkLibraryRoot({
      candidate: 'c:\\localspace\\SOFTWARES\\steam\\',
      protectedRoots,
      sourceRoots
    })
    expect(result.ok).toBe(false)
  })

  it('拒绝相对路径与空值', () => {
    expect(checkLibraryRoot({ candidate: 'gallery', protectedRoots, sourceRoots }).ok).toBe(false)
    expect(checkLibraryRoot({ candidate: '   ', protectedRoots, sourceRoots }).ok).toBe(false)
  })

  it('isSameOrInside 正确区分同级与嵌套', () => {
    expect(isSameOrInside('C:\\a', 'C:\\a')).toBe(true)
    expect(isSameOrInside('C:\\a', 'C:\\a\\b')).toBe(true)
    expect(isSameOrInside('C:\\a', 'C:\\ab')).toBe(false)
    expect(isSameOrInside('C:\\a\\b', 'C:\\a')).toBe(false)
  })

  it('normalizeForCompare 归一化结尾分隔符与大小写', () => {
    expect(normalizeForCompare('C:\\A\\B\\')).toBe(normalizeForCompare('c:\\a\\b'))
  })
})
