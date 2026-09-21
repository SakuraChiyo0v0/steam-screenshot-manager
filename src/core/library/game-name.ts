/**
 * 游戏名称的取值优先级。
 *
 * 产品约定：用户别名 → 快捷方式名 → Steam API 补全名 → 安装清单 / 本地缓存名 → 未知。
 * 写入时必须按优先级比较，**不能**让"未知游戏（AppID）"或扫描的兜底值
 * 覆盖掉已经补全好的名字（重新扫描、同步到另一台电脑都不能把名字弄丢）。
 */

export type GameNameSource =
  | 'user'
  | 'shortcut'
  | 'steam-api'
  | 'app-manifest'
  | 'appinfo'
  | 'fallback'

const RANK: Record<GameNameSource, number> = {
  user: 5,
  shortcut: 4,
  'steam-api': 3,
  'app-manifest': 2,
  appinfo: 2,
  fallback: 0
}

export function nameSourceRank(source: string): number {
  return RANK[source as GameNameSource] ?? 0
}

export interface NameCandidate {
  readonly name: string
  readonly source: string
}

/**
 * 是否用新候选替换已有名称。
 *
 * - 新名字为空：不替换（空名不能覆盖已有名字）；
 * - 已有名字为空：替换；
 * - 其余按来源优先级，优先级相同则替换（例如清单名更新）。
 */
export function shouldReplaceName(existing: NameCandidate | undefined, next: NameCandidate): boolean {
  if (next.name.trim().length === 0) {
    return false
  }
  if (!existing || existing.name.trim().length === 0) {
    return true
  }
  return nameSourceRank(next.source) >= nameSourceRank(existing.source)
}
