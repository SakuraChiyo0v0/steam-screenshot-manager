import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  findEntry,
  formatEntry,
  parseChangelog,
  parseInlineMarkdown,
  parseReleaseNotes
} from '@shared/changelog'

const SAMPLE = `# 更新日志

本文件记录每个版本的可见变化。

## [未发布]

- 还没发布的条目

## [0.7.0] - 2026-11-10

### 新增

- **文件夹远端**：远端不再只能是 WebDAV。
- **从图库目录重建索引**：只读 metadata 与原图，
  续行要接到上一条后面。

### 修复

- 报错带上实际请求的 URL。

## [0.6.0] - 2026-10-08

### 新增

- 恢复到 Steam。
`

describe('CHANGELOG 解析', () => {
  it('按版本切节，忽略非版本标题（未发布）', () => {
    const entries = parseChangelog(SAMPLE)
    expect(entries.map((entry) => entry.version)).toEqual(['0.7.0', '0.6.0'])
    expect(entries[0]!.date).toBe('2026-11-10')
  })

  it('按小标题分组，折行接到上一条', () => {
    const entry = findEntry(parseChangelog(SAMPLE), '0.7.0')!
    expect(entry.groups.map((group) => group.title)).toEqual(['新增', '修复'])
    expect(entry.groups[0]!.items).toHaveLength(2)
    expect(entry.groups[0]!.items[1]).toContain('续行要接到上一条后面')
    expect(entry.groups[1]!.items[0]).toContain('实际请求的 URL')
  })

  it('渲染成 Release 正文时保留分组', () => {
    const text = formatEntry(findEntry(parseChangelog(SAMPLE), '0.7.0')!)
    expect(text).toContain('**新增**')
    expect(text).toContain('- **文件夹远端**')
    expect(text.indexOf('**新增**')).toBeLessThan(text.indexOf('**修复**'))
  })

  it('找不到的版本返回 null（发布脚本据此失败）', () => {
    expect(findEntry(parseChangelog(SAMPLE), '9.9.9')).toBeNull()
  })

  it('版本比较只认三段数字', () => {
    expect(compareVersions('0.7.0', '0.6.0')).toBeGreaterThan(0)
    expect(compareVersions('v0.7.0', '0.7.0')).toBe(0)
    expect(compareVersions('0.7.10', '0.7.9')).toBeGreaterThan(0)
  })
})

describe('行内 Markdown（更新内容的富文本）', () => {
  it('粗体里套行内代码', () => {
    expect(parseInlineMarkdown('**修复网关 `/webdav` 前缀模式**：只把前缀剥掉了')).toEqual([
      {
        kind: 'strong',
        tokens: [
          { kind: 'text', text: '修复网关 ' },
          { kind: 'code', text: '/webdav' },
          { kind: 'text', text: ' 前缀模式' }
        ]
      },
      { kind: 'text', text: '：只把前缀剥掉了' }
    ])
  })

  it('纯文本原样返回；未闭合标记不吞字符', () => {
    expect(parseInlineMarkdown('普通一句话')).toEqual([{ kind: 'text', text: '普通一句话' }])
    expect(parseInlineMarkdown('**没闭合')).toEqual([{ kind: 'text', text: '**没闭合' }])
    expect(parseInlineMarkdown('没闭合 `')).toEqual([{ kind: 'text', text: '没闭合 `' }])
  })

  it('行内代码里的 ** 不当粗体', () => {
    expect(parseInlineMarkdown('`a**b`')).toEqual([{ kind: 'code', text: 'a**b' }])
  })
})

describe('发布正文解析（latest.yml 的 releaseNotes）', () => {
  it('按分组标题与小标题拆开，折行接上', () => {
    const notes = ['**新增**', '', '- 第一条', '- 第二条', '  折行接上', '', '**修复**', '', '- 修了一个错'].join('\n')
    expect(parseReleaseNotes(notes)).toEqual([
      { title: '新增', items: ['第一条', '第二条 折行接上'] },
      { title: '修复', items: ['修了一个错'] }
    ])
  })

  it('没有分组标题时归到一个无标题分组；空正文给空数组', () => {
    expect(parseReleaseNotes('- 只有条目')).toEqual([{ title: '', items: ['只有条目'] }])
    expect(parseReleaseNotes('')).toEqual([])
  })

  it('formatEntry 的输出能被 parseReleaseNotes 读回来（带分组标题的形状）', () => {
    const entry = {
      version: '1.0.0',
      date: '',
      groups: [
        { title: '新增', items: ['a', 'b'] },
        { title: '修复', items: ['c'] }
      ]
    }
    expect(parseReleaseNotes(formatEntry(entry))).toEqual([
      { title: '新增', items: ['a', 'b'] },
      { title: '修复', items: ['c'] }
    ])
  })
})
