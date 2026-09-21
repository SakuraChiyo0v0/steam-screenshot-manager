/**
 * 图库视图的纯逻辑。
 *
 * 放在 shared 而不是渲染层，是为了让这些规则能在 node 测试工程里直接做单元测试：
 * 验收报告的三处缺陷都出在"分页追加、错误与列表的优先级、图片失败与可用状态"这类判断上，
 * 它们必须是可测的纯函数，而不是埋在组件里的分支。
 */

export interface AssetIdentityLike {
  readonly assetId: string
}

/**
 * 追加一页资产：按 assetId 去重，保留先出现的顺序。
 *
 * 防御场景：同一游标被请求两次、分页响应乱序到达、后端返回与已有数据重叠的条目。
 * 重复的 assetId 会产生重复 React key 与错误的计数。
 */
export function mergeAssetPages<T extends AssetIdentityLike>(
  existing: readonly T[],
  incoming: readonly T[]
): T[] {
  const seen = new Set<string>()
  const merged: T[] = []

  for (const item of [...existing, ...incoming]) {
    if (seen.has(item.assetId)) {
      continue
    }
    seen.add(item.assetId)
    merged.push(item)
  }

  return merged
}

/**
 * 图库主区域的渲染状态。
 *
 * 优先级刻意让错误独立于"列表是否为空"：已有结果时查询失败也必须显示错误，
 * 否则用户会把旧结果当成新筛选的结果（验收问题 2）。
 */
export type LibraryViewState =
  | 'no-api'
  | 'loading'
  | 'error'
  | 'empty-no-scan'
  | 'empty-scanned'
  | 'empty-filtered'
  | 'ready'

export interface LibraryViewInput {
  /** 是否存在桌面接口 */
  readonly hasApi: boolean
  /** 是否正在加载 */
  readonly loading: boolean
  /** 当前查询的错误信息（null 表示无错误） */
  readonly error: string | null
  /** 当前列表条数（游戏或资产） */
  readonly itemCount: number
  /** 是否已经至少成功建立过一次索引（用于区分"没扫描过"与"筛选没匹配"） */
  readonly hasAnyIndex: boolean
  /** 是否处于筛选/搜索状态 */
  readonly filtered: boolean
}

export function resolveLibraryViewState(input: LibraryViewInput): LibraryViewState {
  if (!input.hasApi) {
    return 'no-api'
  }
  if (input.loading && input.itemCount === 0) {
    return 'loading'
  }
  if (input.error) {
    return 'error'
  }
  if (input.itemCount > 0) {
    return 'ready'
  }
  if (!input.hasAnyIndex) {
    return 'empty-no-scan'
  }
  // 已经扫描过却没有任何资产：不能提示"还没有建立索引"，那是另一种情况
  return input.filtered ? 'empty-filtered' : 'empty-scanned'
}

/**
 * 图片是否应显示为不可用。
 *
 * available 来自查询时的索引状态（source_files.present），协议取图时还会再检查真实文件；
 * 两者可能不一致（文件被移走、来源断开、图片损坏），因此加载失败的事实优先。
 */
export function isAssetUnavailable(indexedAvailable: boolean, loadFailed: boolean): boolean {
  return loadFailed || !indexedAvailable
}

/**
 * 图片失败状态的键。
 *
 * 原图与缩略图必须分开记录：缩略图文件损坏时，原图往往仍然正常，
 * 共用同一个键会把已经正常显示的主图一起关掉（复验报告 [P2]）。
 */
export const IMAGE_FAILURE_KEYS = {
  /** 原图（相册网格与大图都用它判定可用性） */
  original: (assetId: string): string => `${assetId}:orig`,
  /** 缩略图（只影响缩略图自身，失败时回退原图） */
  thumbnail: (assetId: string): string => `${assetId}:thumb`,
  /** 游戏卡片封面（取该游戏最近一张截图的原图） */
  cover: (gameKey: string): string => `${gameKey}:cover`
} as const

/** 记录加载失败的资产；返回新的集合，便于 React 判断引用变化。 */
export function withFailedImage(
  failed: ReadonlySet<string>,
  assetId: string
): ReadonlySet<string> {
  if (failed.has(assetId)) {
    return failed
  }
  const next = new Set(failed)
  next.add(assetId)
  return next
}

/** 清除某个资产的失败记录（重试时使用）。 */
export function withoutFailedImage(
  failed: ReadonlySet<string>,
  assetId: string
): ReadonlySet<string> {
  if (!failed.has(assetId)) {
    return failed
  }
  const next = new Set(failed)
  next.delete(assetId)
  return next
}

/**
 * 重试时给图片地址追加一个版本参数，绕过浏览器对失败请求的缓存。
 * 协议的处理器只看 pathname，因此多余的查询参数不影响解析。
 */
export function withRetryToken(url: string, attempt: number): string {
  if (attempt <= 0) {
    return url
  }
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}retry=${attempt}`
}
