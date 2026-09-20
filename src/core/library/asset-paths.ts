/**
 * 资产路径解析与边界校验。
 *
 * 渲染层永远只拿 assetId，文件系统路径在主进程内部解析；
 * 每次解析都必须通过词法边界检查，真实路径存在时再做一次 realpath 校验，
 * 防止 `..`、绝对路径与符号链接越界（docs/architecture.md §8）。
 */

import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { AppError } from '@shared/errors'

/** candidate 是否位于 root 之内（含 root 自身视为在内）。 */
export function isInsideRoot(rootPath: string, candidatePath: string): boolean {
  const root = resolve(rootPath)
  const candidate = resolve(candidatePath)
  const rel = relative(root, candidate)
  return rel.length === 0 || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 把来源根与相对路径解析为绝对路径，并做词法层面的越界检查。
 * 不访问文件系统，因此可以在单元测试中直接验证。
 */
export function resolveAssetPath(rootPath: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new AppError('LIB_PATH_INVALID', '资源相对路径为空')
  }
  if (relativePath.includes('\u0000')) {
    throw new AppError('LIB_PATH_INVALID', '资源路径包含非法字符')
  }
  if (isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
    throw new AppError('LIB_PATH_INVALID', '资源路径必须是相对路径')
  }

  const segments = relativePath.split(/[\\/]/)
  if (segments.some((segment) => segment === '..')) {
    throw new AppError('LIB_PATH_INVALID', '资源路径不允许包含上级目录')
  }

  const root = resolve(rootPath)
  const candidate = resolve(root, relativePath)
  if (!isInsideRoot(root, candidate)) {
    throw new AppError('LIB_PATH_INVALID', '资源路径越出来源根目录')
  }
  return candidate
}

/**
 * 解析并确认文件真实存在；对真实路径再做一次根内校验，挡住符号链接越界。
 * 返回真实路径，供读取文件使用。
 */
export async function resolveExistingAssetPath(
  rootPath: string,
  relativePath: string
): Promise<string> {
  const lexicalPath = resolveAssetPath(rootPath, relativePath)

  let realRoot: string
  let realTarget: string
  try {
    realRoot = await realpath(resolve(rootPath))
    realTarget = await realpath(lexicalPath)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new AppError('SRC_NOT_FOUND', `资源文件不可读：${detail}`)
  }

  if (!isInsideRoot(realRoot, realTarget)) {
    throw new AppError('LIB_PATH_INVALID', '资源真实路径越出来源根目录')
  }

  return realTarget
}

/**
 * 缩略图相对路径：`<game>/screenshots/<file>` → `<game>/screenshots/thumbnails/<file>`。
 *
 * 与 Steam 自带 thumbnails 目录布局一致；放在这里是为了能脱离 Electron 单独测试。
 */
export function thumbnailPathFor(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  if (index < 0) {
    return `thumbnails/${normalized}`
  }
  return `${normalized.slice(0, index)}/thumbnails/${normalized.slice(index + 1)}`
}
