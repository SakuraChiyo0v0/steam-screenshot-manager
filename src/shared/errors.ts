/**
 * 稳定错误码与统一返回结构。
 *
 * 与 docs/architecture.md 第 7.1 节一致：code 是稳定标识，界面文案由 code 映射产生，
 * 不解析 message，也不依赖服务端返回文本判定结果。新增 code 只追加，不修改已有语义。
 */

export const ERROR_CODES = {
  /** 渲染层传入的参数类型或取值非法 */
  IPC_INVALID_INPUT: 'IPC_INVALID_INPUT',
  /** 路径不合法、与来源重叠或指向受保护目录 */
  LIB_PATH_INVALID: 'LIB_PATH_INVALID',
  /** 目标磁盘空间不足 */
  LIB_DISK_FULL: 'LIB_DISK_FULL',
  /** 数据库损坏或迁移失败 */
  LIB_DB_CORRUPT: 'LIB_DB_CORRUPT',
  /** 来源根目录不存在或不可读 */
  SRC_NOT_FOUND: 'SRC_NOT_FOUND',
  /** 来源目录权限不足或读取失败 */
  SRC_UNREADABLE: 'SRC_UNREADABLE',
  /** VDF/ACF/shortcuts.vdf 解析失败 */
  SRC_VDF_PARSE: 'SRC_VDF_PARSE',
  /** 已有同类任务在执行 */
  JOB_RUNNING: 'JOB_RUNNING',
  /** 主进程未预期的内部错误 */
  APP_INTERNAL: 'APP_INTERNAL'
} as const

export type ErrorCode = keyof typeof ERROR_CODES

export interface ErrorCodeMeta {
  /** 面向用户的中文说明 */
  readonly message: string
  /** 是否属于可重试错误 */
  readonly retriable: boolean
}

export const ERROR_META: Readonly<Record<ErrorCode, ErrorCodeMeta>> = {
  IPC_INVALID_INPUT: { message: '请求参数不合法', retriable: false },
  LIB_PATH_INVALID: { message: '路径不合法或与来源重叠', retriable: false },
  LIB_DISK_FULL: { message: '目标磁盘空间不足', retriable: true },
  LIB_DB_CORRUPT: { message: '数据库损坏或迁移失败', retriable: false },
  SRC_NOT_FOUND: { message: '来源目录不存在或不可读', retriable: true },
  SRC_UNREADABLE: { message: '来源目录读取失败', retriable: true },
  SRC_VDF_PARSE: { message: 'VDF/ACF 文件解析失败', retriable: false },
  JOB_RUNNING: { message: '已有同类任务正在执行', retriable: true },
  APP_INTERNAL: { message: '应用内部错误', retriable: false }
}

export interface Ok<T> {
  readonly ok: true
  readonly data: T
}

export interface Err {
  readonly ok: false
  readonly code: ErrorCode
  readonly message: string
  readonly retriable: boolean
}

export type Result<T> = Ok<T> | Err

export function ok<T>(data: T): Ok<T> {
  return { ok: true, data }
}

export function err(code: ErrorCode, detail?: string): Err {
  const meta = ERROR_META[code]
  return {
    ok: false,
    code,
    message: detail ? `${meta.message}：${detail}` : meta.message,
    retriable: meta.retriable
  }
}

/** 核心层抛出的领域错误，携带稳定错误码。 */
export class AppError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, detail?: string) {
    const meta = ERROR_META[code]
    super(detail ? `${meta.message}：${detail}` : meta.message)
    this.name = 'AppError'
    this.code = code
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}

/** 把任意异常转换成统一错误返回，未识别的异常归为不可重试的内部错误。 */
export function toErr(value: unknown): Err {
  if (isAppError(value)) {
    return err(value.code, value.message)
  }
  const detail = value instanceof Error ? value.message : String(value)
  return err('APP_INTERNAL', detail)
}
