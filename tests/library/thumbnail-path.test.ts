import { describe, expect, it } from 'vitest'
import { thumbnailPathFor } from '@core/library/asset-paths'

describe('缩略图相对路径推导', () => {
  it('在截图目录下插入 thumbnails 段（与 Steam 布局一致）', () => {
    expect(thumbnailPathFor('userdata/1000000001/760/remote/438100/screenshots/a.jpg')).toBe(
      'userdata/1000000001/760/remote/438100/screenshots/thumbnails/a.jpg'
    )
  })

  it('兼容反斜杠分隔符', () => {
    expect(thumbnailPathFor('438100\\screenshots\\a.jpg')).toBe('438100/screenshots/thumbnails/a.jpg')
  })

  it('没有目录分隔符时退化为 thumbnails/<文件名>', () => {
    expect(thumbnailPathFor('a.jpg')).toBe('thumbnails/a.jpg')
  })

  it('使用最后一个分隔符，不受文件名中的点号影响', () => {
    expect(thumbnailPathFor('a/b.c/screenshots/x.y.jpg')).toBe(
      'a/b.c/screenshots/thumbnails/x.y.jpg'
    )
  })
})
