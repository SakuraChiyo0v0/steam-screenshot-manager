import { describe, expect, it } from 'vitest'
import { AppError, ERROR_CODES, ERROR_META, err, ok, toErr } from '@shared/errors'
import { EXPOSED_METHODS, IPC_CHANNELS, METHOD_TO_CHANNEL } from '@shared/ipc'

describe('IPC 白名单契约', () => {
  it('每个暴露方法都映射到一个已声明的通道', () => {
    const declared = new Set<string>(Object.values(IPC_CHANNELS))
    for (const method of EXPOSED_METHODS) {
      expect(declared.has(METHOD_TO_CHANNEL[method])).toBe(true)
    }
  })

  it('映射表与暴露方法清单完全一致，不多不少', () => {
    expect(Object.keys(METHOD_TO_CHANNEL).sort()).toEqual([...EXPOSED_METHODS].sort())
  })

  it('通道名唯一，且使用「域:动作」命名', () => {
    const channels = Object.values(IPC_CHANNELS)
    expect(new Set(channels).size).toBe(channels.length)
    for (const channel of channels) {
      expect(channel).toMatch(/^[a-z]+:[a-zA-Z]+$/)
    }
  })

  it('不暴露通用文件读写或命令执行通道', () => {
    const forbidden = ['fs', 'path', 'exec', 'shell', 'spawn', 'readFile', 'writeFile']
    for (const channel of Object.values(IPC_CHANNELS)) {
      for (const token of forbidden) {
        expect(channel.toLowerCase().includes(token.toLowerCase())).toBe(false)
      }
    }
  })
})

describe('错误返回契约', () => {
  it('每个错误码都有中文说明与可重试标记', () => {
    for (const code of Object.values(ERROR_CODES)) {
      const meta = ERROR_META[code]
      expect(meta).toBeDefined()
      expect(meta.message.length).toBeGreaterThan(0)
      expect(typeof meta.retriable).toBe('boolean')
    }
  })

  it('ok 与 err 产生稳定的判别结构', () => {
    expect(ok({ value: 1 })).toEqual({ ok: true, data: { value: 1 } })

    const failure = err('LIB_PATH_INVALID', '位于来源目录之内')
    expect(failure.ok).toBe(false)
    expect(failure.code).toBe('LIB_PATH_INVALID')
    expect(failure.retriable).toBe(false)
    expect(failure.message).toContain('位于来源目录之内')
  })

  it('AppError 保留错误码，未知异常归为 APP_INTERNAL', () => {
    expect(toErr(new AppError('LIB_DB_CORRUPT', '迁移失败')).code).toBe('LIB_DB_CORRUPT')
    expect(toErr(new Error('意外崩溃')).code).toBe('APP_INTERNAL')
    expect(toErr('字符串异常').code).toBe('APP_INTERNAL')
  })

  it('磁盘空间不足属于可重试错误', () => {
    expect(err('LIB_DISK_FULL').retriable).toBe(true)
  })
})
