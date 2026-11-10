/**
 * 从 CHANGELOG.md 抽出 package.json 当前版本那一节，写到 release/release-notes.md。
 * electron-builder 拿它当 GitHub Release 正文与 latest.yml 的 releaseNotes
 * （见 electron-builder.yml 的 releaseInfo）。
 *
 *   node scripts/release-notes.mjs              # pnpm package 之前跑
 *   node scripts/release-notes.mjs --tag v0.7.0 # CI：顺便核对标签与版本号一致
 *
 * 当前版本在 CHANGELOG 里没有一节、或者那一节是空的：直接失败。发版不写更新内容，应用里的公告就是空的。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// Node 24 直接跑 .ts（类型擦除）；changelog.ts 没有别的依赖
import { findEntry, formatEntry, parseChangelog } from '../src/shared/changelog.ts'

process.chdir(fileURLToPath(new URL('..', import.meta.url)))

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const tagIndex = process.argv.indexOf('--tag')
if (tagIndex !== -1) {
  const tag = process.argv[tagIndex + 1] ?? ''
  if (tag !== `v${version}`) {
    console.error(`标签 ${tag || '(空)'} 与 package.json 的版本 ${version} 对不上（应为 v${version}）`)
    process.exit(1)
  }
}

const entry = findEntry(parseChangelog(readFileSync('CHANGELOG.md', 'utf8')), version)
const itemCount = entry?.groups.reduce((total, group) => total + group.items.length, 0) ?? 0
if (!entry || itemCount === 0) {
  console.error(`CHANGELOG.md 里没有 ${version} 这一节（或者是空的）：先写更新内容再发版`)
  process.exit(1)
}

mkdirSync('release', { recursive: true })
writeFileSync('release/release-notes.md', formatEntry(entry) + '\n')
console.log(`更新内容：${version}，${itemCount} 条 → release/release-notes.md`)
