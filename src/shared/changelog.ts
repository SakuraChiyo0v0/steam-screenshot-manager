/**
 * 更新日志（仓库根的 CHANGELOG.md）的解析。
 *
 * 三处共用：发布脚本取当前版本那一节写进 Release 正文；应用里显示「本版更新内容」；
 * 比较版本决定要不要提示「这次更新了什么」。
 *
 * 本仓库用的是 Keep a Changelog 的写法：
 *
 *   ## [0.7.0] - 2026-11-10
 *   ### 新增
 *   - 一句话
 *     （折行的续行接到上一条后面）
 */

export interface ChangelogEntry {
  readonly version: string
  /** 标题里的日期，原样保留；没写就是空串 */
  readonly date: string
  /** 这一节的小标题（新增 / 修复 / 验证…），用于分组显示 */
  readonly groups: readonly ChangelogGroup[]
}

export interface ChangelogGroup {
  readonly title: string
  readonly items: readonly string[]
}

/** 只认三段数字版本：`## [1.2.3] - 2026-01-02` 与 `## 1.2.3 · 2026-01-02` 都收。 */
const headingPattern = /^##\s+(?:\[|v)?(\d+\.\d+\.\d+)(?:\])?\s*(?:[-·]\s*(.*))?$/

export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let entry: { version: string; date: string; groups: ChangelogGroup[] } | undefined
  let group: { title: string; items: string[] } | undefined

  const pushGroup = (): void => {
    if (entry && group && group.items.length > 0) entry.groups.push(group)
    group = undefined
  }

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const heading = headingPattern.exec(line)
    if (heading) {
      pushGroup()
      entry = { version: heading[1]!, date: (heading[2] ?? '').trim(), groups: [] }
      entries.push(entry)
      continue
    }
    if (line.startsWith('## ')) {
      // 不是版本标题的二级标题（例如「未发布」）：结束当前节
      pushGroup()
      entry = undefined
      continue
    }
    if (!entry) continue
    const sub = /^###+\s+(.*)$/.exec(line)
    if (sub) {
      pushGroup()
      group = { title: sub[1]!.trim(), items: [] }
      continue
    }
    const item = /^\s*[-*]\s+(.*)$/.exec(line)
    if (item) {
      const text = item[1]!.trim()
      if (!group) group = { title: '', items: [] }
      group.items.push(text)
      continue
    }
    // 折行的续行：接到上一条后面
    if (line.trim() && group && group.items.length > 0) {
      group.items[group.items.length - 1] += ` ${line.trim()}`
    }
  }
  pushGroup()

  return entries.map((entry) => ({
    version: entry.version,
    date: entry.date,
    groups: entry.groups
  }))
}

/** 取某个版本的那一节；没有返回 null。 */
export function findEntry(entries: readonly ChangelogEntry[], version: string): ChangelogEntry | null {
  const wanted = version.replace(/^v/, '')
  return entries.find((entry) => entry.version === wanted) ?? null
}

/** 比较 x.y.z；只认数字三段（不发预发布版本）。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 渲染成发布用的 Markdown：保留小标题分组。 */
export function formatEntry(entry: ChangelogEntry): string {
  const blocks: string[] = []
  for (const group of entry.groups) {
    const lines = group.items.map((item) => `- ${item}`)
    blocks.push(group.title ? [`**${group.title}**`, ...lines].join('\n') : lines.join('\n'))
  }
  return blocks.join('\n\n')
}
