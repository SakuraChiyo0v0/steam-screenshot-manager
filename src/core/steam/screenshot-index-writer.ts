/** 只追加截图条目；原文件的未知字段、注释和既有文本保持不变。 */
import { AppError } from '@shared/errors'

export interface IndexNode {
  name: string
  close: number
  values: Map<string, string>
  children: IndexNode[]
}

export function screenshotLayout(text: string): IndexNode {
  const tokens: { value: string; at: number; kind: 'string' | '{' | '}' }[] = []
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  while (i < text.length) {
    if (/\s/.test(text[i]!)) { i++; continue }
    if (text.slice(i, i + 2) === '//') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    const at = i
    const ch = text[i++]!
    if (ch === '{' || ch === '}') { tokens.push({ value: ch, at, kind: ch }); continue }
    if (ch !== '"') throw new AppError('SRC_VDF_PARSE', '截图索引含不支持的语法')
    let value = '', closed = false
    while (i < text.length) {
      const next = text[i++]!
      if (next === '"') { closed = true; break }
      if (next === '\\' && i < text.length) value += text[i++]!
      else value += next
    }
    if (!closed) throw new AppError('SRC_VDF_PARSE', '截图索引字符串未闭合')
    tokens.push({ value, at, kind: 'string' })
  }
  let pos = 0
  const body = (name: string, top = false): IndexNode => {
    const node: IndexNode = { name, close: text.length, values: new Map(), children: [] }
    const keys = new Set<string>()
    while (pos < tokens.length) {
      const key = tokens[pos++]!
      if (key.kind === '}') {
        if (top) throw new AppError('SRC_VDF_PARSE', '截图索引多余右括号')
        node.close = key.at
        return node
      }
      const value = tokens[pos++]
      if (key.kind !== 'string' || !value || keys.has(key.value.toLowerCase())) {
        throw new AppError('SRC_VDF_PARSE', '截图索引结构损坏或包含重复键')
      }
      keys.add(key.value.toLowerCase())
      if (value.kind === '{') node.children.push(body(key.value))
      else if (value.kind === 'string') node.values.set(key.value, value.value)
      else throw new AppError('SRC_VDF_PARSE', '截图索引缺少字段值')
    }
    if (!top) throw new AppError('SRC_VDF_PARSE', '截图索引对象未闭合')
    return node
  }
  const root = body('', true)
  const screenshots = root.children.find(node => node.name === 'screenshots')
  if (!screenshots) throw new AppError('SRC_VDF_PARSE', '截图索引缺少 screenshots 对象')
  return screenshots
}

export interface RebuiltScreenshot {
  gameId: string
  filename: string
  width: number
  height: number
  creation: number
}

export function appendScreenshots(text: string, items: readonly RebuiltScreenshot[]): string {
  const layout = screenshotLayout(text)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const edits: { at: number; value: string }[] = []
  const grouped = new Map<string, RebuiltScreenshot[]>()
  for (const item of items) {
    if (!/^[1-9]\d{0,9}$/.test(item.gameId) || !/^[\w.-]+\.jpe?g$/i.test(item.filename)) {
      throw new AppError('IPC_INVALID_INPUT', '截图路径或游戏标识不合法')
    }
    const group = grouped.get(item.gameId) ?? []
    group.push(item)
    grouped.set(item.gameId, group)
  }
  for (const [gameId, group] of grouped) {
    const game = layout.children.find(node => node.name === gameId)
    if (game?.values.size || game?.children.some(node => !/^\d+$/.test(node.name))) {
      throw new AppError('SRC_VDF_PARSE', '游戏截图索引结构不支持')
    }
    let next = game ? Math.max(-1, ...game.children.map(node => Number(node.name))) + 1 : 0
    let value = eol
    if (!game) value += `\t"${gameId}"${eol}\t{${eol}`
    for (const item of group) {
      const fields = {
        type: '1', filename: `${gameId}/screenshots/${item.filename}`,
        thumbnail: `${gameId}/screenshots/thumbnails/${item.filename}`, imported: '1',
        width: String(item.width), height: String(item.height), gameid: gameId,
        creation: String(item.creation), Permissions: '2'
      }
      value += `\t\t"${next++}"${eol}\t\t{${eol}`
      for (const [key, field] of Object.entries(fields)) value += `\t\t\t"${key}"\t\t"${field}"${eol}`
      value += `\t\t}${eol}`
    }
    if (!game) value += `\t}${eol}`
    edits.push({ at: game?.close ?? layout.close, value })
  }
  let result = text
  for (const edit of edits.sort((a, b) => b.at - a.at)) result = result.slice(0, edit.at) + edit.value + result.slice(edit.at)
  screenshotLayout(result)
  return result
}
