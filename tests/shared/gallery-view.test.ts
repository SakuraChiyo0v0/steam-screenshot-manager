import { describe, expect, it } from 'vitest'
import {
  isAssetUnavailable,
  mergeAssetPages,
  resolveLibraryViewState,
  withFailedImage,
  withRetryToken,
  withoutFailedImage
} from '@shared/gallery-view'

describe('分页追加去重（验收问题 1）', () => {
  it('同一页被追加两次时不产生重复条目', () => {
    const page1 = [{ assetId: 'page1' }]
    const page2 = [{ assetId: 'page2-item' }]

    const once = mergeAssetPages(page1, page2)
    const twice = mergeAssetPages(once, page2)

    expect(twice.map((item) => item.assetId)).toEqual(['page1', 'page2-item'])
  })

  it('模拟两个并发响应各自追加，结果仍然只有一条', () => {
    const existing = [{ assetId: 'page1' }]
    const samePage = [{ assetId: 'page2-item' }]

    const afterA = mergeAssetPages(existing, samePage)
    const afterB = mergeAssetPages(afterA, samePage)

    expect(afterB).toHaveLength(2)
  })

  it('保留先出现的顺序，并保留后到条目的其他字段', () => {
    const merged = mergeAssetPages(
      [{ assetId: 'a', fileName: '旧' }],
      [
        { assetId: 'b', fileName: 'B' },
        { assetId: 'a', fileName: '新' }
      ]
    )

    expect(merged.map((item) => item.assetId)).toEqual(['a', 'b'])
    expect(merged[0]!.fileName).toBe('旧')
  })

  it('空输入不报错', () => {
    expect(mergeAssetPages([], [])).toEqual([])
  })
})

describe('图库视图状态优先级（验收问题 2）', () => {
  const base = {
    hasApi: true,
    loading: false,
    error: null,
    itemCount: 0,
    hasAnyIndex: true,
    filtered: false
  }

  it('没有桌面接口时给出环境提示', () => {
    expect(resolveLibraryViewState({ ...base, hasApi: false })).toBe('no-api')
  })

  it('首次加载且没有数据时显示加载中', () => {
    expect(resolveLibraryViewState({ ...base, loading: true })).toBe('loading')
  })

  it('已有结果时查询失败仍然显示错误，不被列表遮住', () => {
    expect(
      resolveLibraryViewState({ ...base, error: 'IPC_INVALID_INPUT：参数不合法', itemCount: 42 })
    ).toBe('error')
  })

  it('加载更多期间保留列表，不回到加载态', () => {
    expect(resolveLibraryViewState({ ...base, loading: true, itemCount: 42 })).toBe('ready')
  })

  it('从未建立索引的空库提示去登记来源', () => {
    expect(resolveLibraryViewState({ ...base, hasAnyIndex: false })).toBe('empty-no-scan')
  })

  it('筛选无匹配与未扫描空库区分开', () => {
    expect(resolveLibraryViewState({ ...base, hasAnyIndex: true, filtered: true })).toBe(
      'empty-filtered'
    )
    expect(resolveLibraryViewState({ ...base, hasAnyIndex: false, filtered: true })).toBe(
      'empty-no-scan'
    )
  })

  it('已扫描但没有资产时，不提示"还没有建立索引"', () => {
    expect(resolveLibraryViewState({ ...base, hasAnyIndex: true, filtered: false })).toBe(
      'empty-scanned'
    )
  })

  it('有数据时进入可渲染状态', () => {
    expect(resolveLibraryViewState({ ...base, itemCount: 3 })).toBe('ready')
  })
})

describe('图片可用状态（验收问题 3）', () => {
  it('索引说存在但加载失败时按不可用处理', () => {
    expect(isAssetUnavailable(true, true)).toBe(true)
  })

  it('索引说缺失时按不可用处理', () => {
    expect(isAssetUnavailable(false, false)).toBe(true)
  })

  it('索引存在且未失败时才可用', () => {
    expect(isAssetUnavailable(true, false)).toBe(false)
  })

  it('失败集合按资产记录、可清除、不重复', () => {
    const empty: ReadonlySet<string> = new Set()
    const once = withFailedImage(empty, 'a')
    const twice = withFailedImage(once, 'a')

    expect([...twice]).toEqual(['a'])
    expect(withFailedImage(twice, 'b').size).toBe(2)
    expect(withoutFailedImage(twice, 'a').size).toBe(0)
    expect(withoutFailedImage(empty, 'a')).toBe(empty)
  })

  it('重试地址带版本参数，首次不加参数', () => {
    expect(withRetryToken('ssm-asset://asset/x', 0)).toBe('ssm-asset://asset/x')
    expect(withRetryToken('ssm-asset://asset/x', 2)).toBe('ssm-asset://asset/x?retry=2')
    expect(withRetryToken('ssm-asset://asset/x?a=1', 1)).toBe('ssm-asset://asset/x?a=1&retry=1')
  })
})
