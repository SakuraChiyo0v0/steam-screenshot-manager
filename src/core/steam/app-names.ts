/**
 * 用 Steam Web API 补全游戏名称。
 *
 * 为什么需要：截图目录里只有 AppID，本地能提供的名称来源都不可靠 ——
 * `appmanifest` 只覆盖已安装的游戏；`appinfo.vdf`（v29）把键名放进文件尾部的
 * 字符串表、条目不内嵌结构，离线解析成本高；非 Steam 快捷方式只覆盖手动添加的游戏。
 * 因此未安装、又不在本地缓存里的游戏只剩 AppID 可显示。
 *
 * 用法：在设置里填一个可选的 Steam Web API Key，点"补全游戏信息"，把
 * `IStoreService/GetAppList`（商店应用目录）的名称抓回本地缓存表 `steam_app_names`，
 * 再按优先级补进 `games.name`。名称落库后**断网也能显示**，扫描不会把它覆盖回 AppID。
 */

import type { SqliteDatabase } from '../db/sqlite'
import { shouldReplaceName } from '../library/game-name'

export const STEAM_APP_LIST_URL = 'https://api.steampowered.com/IStoreService/GetAppList/v1/'

/** 每次请求取多少条（官方上限 50000）。 */
export const APP_LIST_PAGE_SIZE = 50_000
/** 单次补全最多抓多少页，避免误配置时无限请求。 */
export const APP_LIST_MAX_PAGES = 12

export interface AppNameEntry {
  readonly appId: string
  readonly name: string
}

export interface HttpResponseLike {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

export type HttpFetcher = (url: string) => Promise<HttpResponseLike>

export interface FetchAppNamesResult {
  readonly entries: AppNameEntry[]
  readonly pages: number
  readonly lastAppId: number
  readonly exhausted: boolean
}

function parsePage(payload: unknown): {
  entries: AppNameEntry[]
  haveMore: boolean
  lastAppId: number
} {
  const response = (payload as { response?: unknown })?.response
  if (typeof response !== 'object' || response === null) {
    return { entries: [], haveMore: false, lastAppId: 0 }
  }
  const rawApps = (response as { apps?: unknown }).apps
  const entries: AppNameEntry[] = []
  if (Array.isArray(rawApps)) {
    for (const item of rawApps) {
      const appId = (item as { appid?: unknown })?.appid
      const name = (item as { name?: unknown })?.name
      if ((typeof appId === 'number' || typeof appId === 'string') && typeof name === 'string') {
        const trimmed = name.trim()
        if (trimmed.length > 0) {
          entries.push({ appId: String(appId), name: trimmed })
        }
      }
    }
  }
  const lastAppId = (response as { last_appid?: unknown }).last_appid
  return {
    entries,
    haveMore: (response as { have_more_results?: unknown }).have_more_results === true,
    lastAppId: typeof lastAppId === 'number' ? lastAppId : 0
  }
}

function buildUrl(apiKey: string, lastAppId: number): string {
  const url = new URL(STEAM_APP_LIST_URL)
  url.searchParams.set('key', apiKey)
  url.searchParams.set('max_results', String(APP_LIST_PAGE_SIZE))
  url.searchParams.set('last_appid', String(lastAppId))
  // 只要游戏；DLC/软件/视频/硬件不参与截图目录命名
  url.searchParams.set('include_games', '1')
  url.searchParams.set('include_dlc', '0')
  url.searchParams.set('include_software', '0')
  url.searchParams.set('include_videos', '0')
  url.searchParams.set('include_hardware', '0')
  return url.toString()
}

/**
 * 分页抓取商店应用目录。
 *
 * `startAppId` 传上次抓到的位置可以只取增量；不传则从头开始。
 */
export async function fetchAppNames(input: {
  apiKey: string
  fetcher: HttpFetcher
  startAppId?: number
  maxPages?: number
  shouldCancel?: () => boolean
  onPage?: (info: { page: number; entries: number }) => void
}): Promise<FetchAppNamesResult> {
  const maxPages = input.maxPages ?? APP_LIST_MAX_PAGES
  const entries: AppNameEntry[] = []
  let lastAppId = input.startAppId ?? 0
  let pages = 0

  for (let page = 1; page <= maxPages; page += 1) {
    if (input.shouldCancel?.()) {
      break
    }
    const response = await input.fetcher(buildUrl(input.apiKey, lastAppId))
    pages += 1
    if (!response.ok) {
      throw new Error(`Steam API 返回 ${response.status}`)
    }
    const body = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new Error('Steam API 返回的不是 JSON（可能是密钥无效或被网关拦截）')
    }
    const pageData = parsePage(parsed)
    if (pageData.entries.length === 0) {
      return { entries, pages, lastAppId, exhausted: true }
    }
    entries.push(...pageData.entries)
    input.onPage?.({ page, entries: entries.length })
    if (!pageData.haveMore || pageData.lastAppId === lastAppId) {
      return { entries, pages, lastAppId: pageData.lastAppId, exhausted: !pageData.haveMore }
    }
    lastAppId = pageData.lastAppId
  }

  return { entries, pages, lastAppId, exhausted: false }
}

/** 把抓到的名称写进本地缓存表，返回写入条数。 */
export function saveAppNames(db: SqliteDatabase, entries: readonly AppNameEntry[], now: string): number {
  const upsert = db.prepare(
    `INSERT INTO steam_app_names (app_id, name, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(app_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`
  )
  let written = 0
  db.transaction(() => {
    for (const item of entries) {
      upsert.run(item.appId, item.name, now)
      written += 1
    }
  })
  return written
}

/** 缓存表里已有的名称数量，供设置页显示。 */
export function appNameCacheStats(db: SqliteDatabase): { count: number } {
  const row = db.prepare('SELECT COUNT(*) AS count FROM steam_app_names').get() as
    | { count: number }
    | undefined
  return { count: Number(row?.count ?? 0) }
}

/**
 * 用缓存把缺失的游戏名补上（不改用户别名，也不会覆盖更高优先级的名字）。
 * 返回补全的游戏数量。
 */
export function completeGameNamesFromCache(db: SqliteDatabase, now: string): number {
  const rows = db
    .prepare(
      `SELECT g.game_key AS gameKey, g.app_id AS appId, g.kind AS kind,
              g.name AS name, g.name_source AS nameSource
         FROM games g
        WHERE g.app_id IS NOT NULL
          AND (g.name_source = 'fallback' OR g.name = '' OR g.name = g.game_key)`
    )
    .all() as { gameKey: string; appId: string; kind: string; name: string; nameSource: string }[]

  if (rows.length === 0) {
    return 0
  }

  const lookup = db.prepare('SELECT name FROM steam_app_names WHERE app_id = ?')
  const update = db.prepare('UPDATE games SET name = ?, name_source = ?, updated_at = ? WHERE game_key = ?')
  let updated = 0
  for (const row of rows) {
    const cached = lookup.get(String(row.appId)) as { name: string } | undefined
    if (!cached || cached.name.trim().length === 0) {
      continue
    }
    if (
      !shouldReplaceName(
        { name: String(row.name), source: String(row.nameSource) },
        { name: cached.name, source: 'steam-api' }
      )
    ) {
      continue
    }
    update.run(cached.name, 'steam-api', now, String(row.gameKey))
    updated += 1
  }
  return updated
}

/** 手动改名（用户别名优先级最高，自动补全不会覆盖它）。 */
export function setGameAlias(db: SqliteDatabase, gameKey: string, name: string, now: string): void {
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    // 清空别名：退回自动命名，交给下一次扫描/补全
    db.prepare("UPDATE games SET name_source = 'fallback', updated_at = ? WHERE game_key = ?").run(
      now,
      gameKey
    )
    const row = db
      .prepare('SELECT app_id AS appId, kind AS kind FROM games WHERE game_key = ?')
      .get(gameKey) as { appId: string | null; kind: string } | undefined
    const fallback =
      row && row.kind === 'steam' && row.appId ? `未知游戏（${row.appId}）` : gameKey
    db.prepare('UPDATE games SET name = ?, updated_at = ? WHERE game_key = ?').run(fallback, now, gameKey)
    completeGameNamesFromCache(db, now)
    return
  }
  db.prepare('UPDATE games SET name = ?, name_source = ?, updated_at = ? WHERE game_key = ?').run(
    trimmed,
    'user',
    now,
    gameKey
  )
}
