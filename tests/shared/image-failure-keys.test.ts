import { describe, expect, it } from 'vitest'
import { IMAGE_FAILURE_KEYS, isAssetUnavailable, withFailedImage } from '@shared/gallery-view'

describe('原图与缩略图的失败状态分离（复验 P2）', () => {
  const assetId = '11111111-2222-4333-8444-555555555555'

  it('缩略图失败不影响主图可用性', () => {
    const failed = withFailedImage(new Set<string>(), IMAGE_FAILURE_KEYS.thumbnail(assetId))
    const originalFailed = failed.has(IMAGE_FAILURE_KEYS.original(assetId))

    expect(originalFailed).toBe(false)
    expect(isAssetUnavailable(true, originalFailed)).toBe(false)
  })

  it('原图失败才判定主图不可用', () => {
    const failed = withFailedImage(new Set<string>(), IMAGE_FAILURE_KEYS.original(assetId))
    expect(isAssetUnavailable(true, failed.has(IMAGE_FAILURE_KEYS.original(assetId)))).toBe(true)
  })

  it('两者使用不同的键，互不覆盖', () => {
    expect(IMAGE_FAILURE_KEYS.original(assetId)).not.toBe(IMAGE_FAILURE_KEYS.thumbnail(assetId))
    expect(IMAGE_FAILURE_KEYS.cover('steam-438100')).toBe('steam-438100:cover')
  })

  it('缩略图回退原图：两者都失败时才没有可显示来源', () => {
    const onlyThumb = withFailedImage(new Set<string>(), IMAGE_FAILURE_KEYS.thumbnail(assetId))
    const both = withFailedImage(onlyThumb, IMAGE_FAILURE_KEYS.original(assetId))

    const sourceFor = (set: ReadonlySet<string>) =>
      set.has(IMAGE_FAILURE_KEYS.thumbnail(assetId))
        ? set.has(IMAGE_FAILURE_KEYS.original(assetId))
          ? null
          : 'original'
        : 'thumbnail'

    expect(sourceFor(onlyThumb)).toBe('original')
    expect(sourceFor(both)).toBeNull()
  })
})
