import { describe, expect, it } from 'vitest'
import { compareVersions, findEntry, formatEntry, parseChangelog } from '@shared/changelog'

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
