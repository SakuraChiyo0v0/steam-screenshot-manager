import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import {
  PREVIEW_CACHE_DIR,
  PREVIEW_MAX_WIDTH,
  previewAbsolutePath,
  resolvePreviewCacheRoot
} from '@core/library/previews'

describe('预览缓存根目录', () => {
  it('设了图库时放图库的 cache 下（跟着图库迁移）', () => {
    const root = resolvePreviewCacheRoot({
      libraryRoot: 'D:\\shots-library',
      userDataRoot: 'C:\\Users\\x\\AppData\\Roaming\\app'
    })
    expect(root).toBe(join(resolve('D:\\shots-library'), 'cache'))
  })

  it('没设图库时放用户数据目录，保证任何 profile 都有预览', () => {
    const root = resolvePreviewCacheRoot({
      libraryRoot: '',
      userDataRoot: 'C:\\Users\\x\\AppData\\Roaming\\app'
    })
    expect(root).toBe(join(resolve('C:\\Users\\x\\AppData\\Roaming\\app'), PREVIEW_CACHE_DIR))
  })

  it('路径按尺寸分开存放', () => {
    const root = resolvePreviewCacheRoot({ libraryRoot: '', userDataRoot: 'C:\\tmp\\app' })
    expect(previewAbsolutePath(root, 'abc', 'preview')).toBe(join(root, 'previews', 'abc.jpg'))
    expect(previewAbsolutePath(root, 'abc', 'mini')).toBe(join(root, 'minis', 'abc.jpg'))
  })

  it('预览宽度按 2 倍屏留余量（卡片约 400px）', () => {
    expect(PREVIEW_MAX_WIDTH).toBeGreaterThanOrEqual(800)
  })
})
