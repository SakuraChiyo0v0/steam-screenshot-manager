import { describe, expect, it } from 'vitest'
import { chooseImageSource } from '@shared/image-source'

describe('图片取值决策', () => {
  it('有自建预览时一律用预览', () => {
    expect(
      chooseImageSource({
        wantsMini: false,
        hasPreview: true,
        hasSourceThumbnail: true,
        preferOriginalImages: true
      })
    ).toBe('preview')
  })

  it('优先原图时，卡片直接用原图而不是来源缩略图（避免发虚）', () => {
    expect(
      chooseImageSource({
        wantsMini: false,
        hasPreview: false,
        hasSourceThumbnail: true,
        preferOriginalImages: true
      })
    ).toBe('original')
  })

  it('不优先原图时，卡片先给来源缩略图省资源', () => {
    expect(
      chooseImageSource({
        wantsMini: false,
        hasPreview: false,
        hasSourceThumbnail: true,
        preferOriginalImages: false
      })
    ).toBe('source-thumbnail')
  })

  it('缩略图带尺寸很小，始终优先来源缩略图', () => {
    expect(
      chooseImageSource({
        wantsMini: true,
        hasPreview: false,
        hasSourceThumbnail: true,
        preferOriginalImages: true
      })
    ).toBe('source-thumbnail')
  })

  it('没有来源缩略图时只能回退原图', () => {
    expect(
      chooseImageSource({
        wantsMini: true,
        hasPreview: false,
        hasSourceThumbnail: false,
        preferOriginalImages: false
      })
    ).toBe('original')
  })
})
