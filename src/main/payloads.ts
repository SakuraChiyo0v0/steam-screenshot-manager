/**
 * 新通道的输入运行时校验。
 *
 * 所有来自渲染层的输入都在这里校验；非法输入抛 IPC_INVALID_INPUT，
 * 由 IPC 层统一转成稳定错误码返回。
 */

import { AppError } from '@shared/errors'
import type {
  AssetIdPayload,
  ListAssetsPayload,
  ListGamesPayload,
  RemoveSourcePayload
} from '@shared/ipc'
import type { AssetSortType } from '@shared/types'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACCOUNT_ID_PATTERN = /^\d{1,20}$/
const ASSET_SORTS: readonly AssetSortType[] = ['captured-desc', 'captured-asc', 'imported-desc']

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('IPC_INVALID_INPUT', `${what}必须是对象`)
  }
  return value as Record<string, unknown>
}

function optionalString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new AppError('IPC_INVALID_INPUT', `${field} 必须是字符串或 null`)
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function optionalBoolean(value: unknown, field: string): boolean | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  if (typeof value !== 'boolean') {
    throw new AppError('IPC_INVALID_INPUT', `${field} 必须是布尔值或 null`)
  }
  return value
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AppError('IPC_INVALID_INPUT', `${field} 格式非法`)
  }
  return value
}

export function parseScanStart(value: unknown): { sourceId: string; accountIds: string[] } {
  const payload = asObject(value, '扫描参数')
  const sourceId = requireUuid(payload['sourceId'], '来源标识')

  const rawAccounts = payload['accountIds']
  if (rawAccounts === undefined || rawAccounts === null) {
    return { sourceId, accountIds: [] }
  }
  if (!Array.isArray(rawAccounts)) {
    throw new AppError('IPC_INVALID_INPUT', '账号列表必须是数组')
  }
  const accountIds: string[] = []
  for (const item of rawAccounts) {
    if (typeof item !== 'string' || !ACCOUNT_ID_PATTERN.test(item)) {
      throw new AppError('IPC_INVALID_INPUT', '账号标识格式非法')
    }
    accountIds.push(item)
  }
  return { sourceId, accountIds }
}

export function parseRemoveSource(value: unknown): RemoveSourcePayload {
  const payload = asObject(value, '来源参数')
  return { sourceId: requireUuid(payload['sourceId'], '来源标识') }
}

export function parseAssetId(value: unknown): AssetIdPayload {
  const payload = asObject(value, '资产参数')
  return { assetId: requireUuid(payload['assetId'], '资产标识') }
}

export function parseListGames(value: unknown): ListGamesPayload {
  if (value === undefined || value === null) {
    return {}
  }
  const payload = asObject(value, '筛选参数')
  const query = optionalString(payload['query'], '搜索词')
  const installed = optionalBoolean(payload['installed'], '安装状态')
  const accountKey = optionalString(payload['accountKey'], '账号')

  return {
    ...(query === undefined ? {} : { query }),
    ...(installed === undefined ? {} : { installed }),
    ...(accountKey === undefined ? {} : { accountKey })
  }
}

export function parseListAssets(value: unknown): ListAssetsPayload {
  if (value === undefined || value === null) {
    return {}
  }
  const payload = asObject(value, '筛选参数')

  const gameKey = optionalString(payload['gameKey'], '游戏')
  const accountKey = optionalString(payload['accountKey'], '账号')
  const installed = optionalBoolean(payload['installed'], '安装状态')
  const query = optionalString(payload['query'], '搜索词')
  const cursor = optionalString(payload['cursor'], '游标')

  let sort: AssetSortType | undefined
  if (payload['sort'] !== undefined) {
    const rawSort = payload['sort']
    if (typeof rawSort !== 'string' || !ASSET_SORTS.includes(rawSort as AssetSortType)) {
      throw new AppError('IPC_INVALID_INPUT', '排序方式不受支持')
    }
    sort = rawSort as AssetSortType
  }

  let limit: number | undefined
  if (payload['limit'] !== undefined) {
    const rawLimit = payload['limit']
    if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 500) {
      throw new AppError('IPC_INVALID_INPUT', '分页大小必须是 1 到 500 的整数')
    }
    limit = rawLimit
  }

  return {
    ...(gameKey === undefined ? {} : { gameKey }),
    ...(accountKey === undefined ? {} : { accountKey }),
    ...(installed === undefined ? {} : { installed }),
    ...(query === undefined ? {} : { query }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(sort === undefined ? {} : { sort }),
    ...(limit === undefined ? {} : { limit })
  }
}
