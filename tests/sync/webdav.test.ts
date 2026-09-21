import { describe, expect, it } from 'vitest'
import { AppError } from '@shared/errors'
import { basicAuthHeader, classifyDavFailure, joinRemotePath, parseRetryAfterMs } from '@core/sync/webdav'

describe('远端路径拼接', () => {
  it('把根路径与相对路径拼成编码后的绝对路径', () => {
    expect(joinRemotePath('', 'steam-gallery-v1/abc/library.json')).toBe(
      '/steam-gallery-v1/abc/library.json'
    )
    expect(joinRemotePath('screenshots', 'originals/a/b/c.jpg')).toBe(
      '/screenshots/originals/a/b/c.jpg'
    )
  })

  it('中文与空格被正确编码', () => {
    expect(joinRemotePath('', '中文 目录/文件.txt')).toBe(
      `/${encodeURIComponent('中文 目录')}/${encodeURIComponent('文件.txt')}`
    )
  })

  it('拒绝绝对路径、上级目录与空字节', () => {
    expect(() => joinRemotePath('', '/etc/passwd')).toThrow(AppError)
    expect(() => joinRemotePath('', '../outside.json')).toThrow(AppError)
    expect(() => joinRemotePath('root', 'a/../../b')).toThrow(AppError)
    expect(() => joinRemotePath('', 'C:/windows/system32')).toThrow(AppError)
    expect(() => joinRemotePath('', 'a\u0000b')).toThrow(AppError)
  })
})

describe('Retry-After 解析', () => {
  it('支持秒数与 HTTP 日期，并封顶', () => {
    expect(parseRetryAfterMs({ 'retry-after': '2' })).toBe(2000)
    expect(parseRetryAfterMs({ 'retry-after': '99999' })).toBe(5 * 60 * 1000)
    expect(parseRetryAfterMs({})).toBeNull()
    expect(parseRetryAfterMs({ 'retry-after': 'not-a-value' })).toBeNull()
  })
})

describe('故障分类', () => {
  const context = { contentType: 'application/xml', bodyHead: '', retryAfterMs: null }

  it('认证与权限快速失败且不可重试', () => {
    expect(classifyDavFailure(401, context).code).toBe('DAV_AUTH')
    expect(classifyDavFailure(403, context).code).toBe('DAV_FORBIDDEN')
  })

  it('限流与容量不足归为可重试', () => {
    expect(classifyDavFailure(429, { ...context, retryAfterMs: 1000 }).code).toBe('DAV_RATE_LIMIT')
    expect(classifyDavFailure(429, { ...context, retryAfterMs: 1000 }).retryAfterMs).toBe(1000)
    expect(classifyDavFailure(507, context).code).toBe('DAV_CAPACITY')
    expect(classifyDavFailure(500, context).code).toBe('DAV_TIMEOUT')
  })

  it('409 归为路径错误（父目录不存在），不可重试', () => {
    const failure = classifyDavFailure(409, context)
    expect(failure.code).toBe('LIB_PATH_INVALID')
    expect(failure.message).toContain('父目录不存在')
  })

  it('网页内容识别为非 WebDAV，即使是 200', () => {
    expect(
      classifyDavFailure(200, {
        contentType: 'text/html',
        bodyHead: '<!doctype html>',
        retryAfterMs: null
      }).code
    ).toBe('DAV_NOT_WEBDAV')
  })
})

describe('凭据代持', () => {
  it('用户名与密码都为空时不生成 Authorization（交给前置网关注入）', () => {
    expect(basicAuthHeader({ username: '', password: '' })).toBeNull()
  })

  it('只要有一侧非空就生成 Basic 头', () => {
    const expected = `Basic ${Buffer.from('user:pass', 'utf8').toString('base64')}`
    expect(basicAuthHeader({ username: 'user', password: 'pass' })).toBe(expected)
    expect(basicAuthHeader({ username: 'user', password: '' })).not.toBeNull()
    expect(basicAuthHeader({ username: '', password: 'pass' })).not.toBeNull()
  })
})
