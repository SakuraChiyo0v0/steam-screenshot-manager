/**
 * 图库根目录校验。
 *
 * 规则（docs/product-plan.md 第 3 节、docs/architecture.md 第 5 节）：
 * - 图库目录不能等于来源目录，也不能与来源互相嵌套，避免重复扫描自身产物；
 * - 不得把图库指向应用数据目录、安装目录或源码目录。
 */

import { isAbsolute, relative, resolve } from 'node:path'

export interface LibraryRootInput {
  readonly candidate: string
  /** 受保护目录：应用数据目录、安装目录、源码目录等 */
  readonly protectedRoots: readonly string[]
  /** 已登记的来源目录 */
  readonly sourceRoots: readonly string[]
}

export type LibraryRootCheck =
  | { readonly ok: true; readonly normalized: string }
  | { readonly ok: false; readonly reason: string }

/** 规范化用于比较：解析为绝对路径、去掉结尾分隔符、Windows 下忽略大小写。 */
export function normalizeForCompare(target: string): string {
  const resolved = resolve(target)
  const trimmed = resolved.replace(/[\\/]+$/, '')
  const safe = trimmed.length === 0 ? resolved : trimmed
  return process.platform === 'win32' ? safe.toLowerCase() : safe
}

/** parent 与 child 相同，或 child 位于 parent 之内。 */
export function isSameOrInside(parent: string, child: string): boolean {
  const from = normalizeForCompare(parent)
  const to = normalizeForCompare(child)
  if (from === to) {
    return true
  }
  const rel = relative(from, to)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

export function checkLibraryRoot(input: LibraryRootInput): LibraryRootCheck {
  const { candidate } = input

  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    return { ok: false, reason: '未选择目录' }
  }
  if (!isAbsolute(candidate)) {
    return { ok: false, reason: '必须是绝对路径' }
  }

  for (const protectedRoot of input.protectedRoots) {
    if (isSameOrInside(protectedRoot, candidate) || isSameOrInside(candidate, protectedRoot)) {
      return { ok: false, reason: `不能指向受保护目录（${protectedRoot}）或包含它` }
    }
  }

  for (const sourceRoot of input.sourceRoots) {
    if (isSameOrInside(sourceRoot, candidate)) {
      return { ok: false, reason: `不能位于来源目录之内（${sourceRoot}）` }
    }
    if (isSameOrInside(candidate, sourceRoot)) {
      return { ok: false, reason: `不能包含来源目录（${sourceRoot}）` }
    }
  }

  return { ok: true, normalized: resolve(candidate) }
}
