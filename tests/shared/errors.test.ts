import { describe, expect, it } from 'vitest'
import { AppError, toErr } from '@shared/errors'

describe('错误码与文案', () => {
  it('AppError 的 message 只带一次错误码文案，detail 保留原始细节', () => {
    const error = new AppError('DAV_PATH_INVALID', '创建目录返回 404：http://nas/webdav')
    expect(error.message).toBe('远端路径不可用：创建目录返回 404：http://nas/webdav')
    expect(error.detail).toBe('创建目录返回 404：http://nas/webdav')
  })

  it('toErr 不会把前缀叠第二遍（界面上的「远端路径不可用：」只出现一次）', () => {
    const error = new AppError('DAV_PATH_INVALID', '创建目录返回 404')
    const result = toErr(error)
    expect(result.code).toBe('DAV_PATH_INVALID')
    expect(result.message).toBe('远端路径不可用：创建目录返回 404')
    expect(result.message.match(/远端路径不可用/g)?.length).toBe(1)
  })

  it('重抛一个已经带前缀的异常链，也不会累积', () => {
    const inner = new AppError('DAV_AUTH', '远端返回 401')
    const outer = toErr(inner)
    const again = toErr(new AppError(outer.code, inner.detail))
    expect(again.message).toBe('远端认证失败，请检查账号或应用密码：远端返回 401')
  })

  it('没有 detail 时只给固定文案；非 AppError 归为内部错误', () => {
    expect(toErr(new AppError('APP_INTERNAL')).message).toBe('应用内部错误')
    expect(toErr(new Error('boom')).code).toBe('APP_INTERNAL')
    expect(toErr(new Error('boom')).message).toContain('boom')
  })
})
