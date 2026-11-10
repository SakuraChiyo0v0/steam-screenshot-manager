import { describe, expect, it } from 'vitest'
import { parseMultistatusEntries } from '@core/sync/webdav'

const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
  <D:response><D:href>/webdav/home/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
  <D:response><D:href>/webdav/home/AmeChan/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
  <D:response><D:href>/webdav/home/%E6%88%AA%E5%9B%BE/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
  <D:response><D:href>/webdav/home/a%20b.jpg</D:href><D:propstat><D:prop>
    <D:resourcetype/><D:getcontentlength>2048</D:getcontentlength>
    <D:getlastmodified>Tue, 13 Oct 2026 10:00:00 GMT</D:getlastmodified>
  </D:prop></D:propstat></D:response>
</D:multistatus>`

describe('解析 PROPFIND 目录项', () => {
  it('识别目录与文件，路径是相对远端根的，根自己那一项被跳过', () => {
    const entries = parseMultistatusEntries(xml, 'webdav/home')
    // 目录排在文件前面；目录之间按本地化规则排序（中文与拉丁文的先后由 locale 决定，不写死）
    expect(entries.map((entry) => entry.name).sort()).toEqual(['AmeChan', 'a b.jpg', '截图'].sort())
    expect(entries.filter((entry) => entry.isDir).map((entry) => entry.name).sort()).toEqual(
      ['AmeChan', '截图'].sort()
    )
    expect(entries.map((entry) => entry.path).sort()).toEqual(['AmeChan', 'a b.jpg', '截图'].sort())
    const file = entries.find((entry) => entry.name === 'a b.jpg')!
    expect(file.isDir).toBe(false)
    expect(file.size).toBe(2048)
    expect(file.modifiedAt).toBe(new Date('Tue, 13 Oct 2026 10:00:00 GMT').toISOString())
  })

  it('目录排在文件前面', () => {
    const entries = parseMultistatusEntries(xml, 'webdav/home')
    expect(entries[entries.length - 1]!.isDir).toBe(false)
  })

  it('没有前缀的命名空间也能解析', () => {
    const plain = '<multistatus><response><href>/a/b/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response></multistatus>'
    const entries = parseMultistatusEntries(plain, 'a')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ name: 'b', path: 'b', isDir: true, size: null })
  })

  it('根路径为空时按整体解析；越出根的项被忽略', () => {
    const entries = parseMultistatusEntries(xml, '')
    expect(entries.map((entry) => entry.path)).toContain('webdav/home/AmeChan')
    expect(entries.map((entry) => entry.path)).toContain('webdav/home/截图')
  })

  it('坏 XML 不抛错，返回空数组', () => {
    expect(parseMultistatusEntries('not xml at all', 'x')).toEqual([])
  })
})
