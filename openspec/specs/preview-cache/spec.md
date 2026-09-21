# preview-cache Specification

## Purpose
TBD - created by archiving change daily-use-polish. Update Purpose after archive.
## Requirements
### Requirement: 预览缓存

系统 MUST 为图库资产生成中等尺寸预览，MUST NOT 在图片请求里同步生成（避免阻塞界面）。
预览 MUST 至少提供两种尺寸：卡片用的预览与缩略图带用的迷你图。

#### Scenario: 请求缩略图
- **WHEN** 渲染层请求某资产的缩略图
- **THEN** 优先返回自建预览；没有预览时返回 Steam 缩略图；都没有时返回原图，并把该资产放入后台队列

#### Scenario: 请求迷你图
- **WHEN** 渲染层通过迷你通道请求某资产
- **THEN** 返回 200px 迷你图；没有时按同样顺序回退，并只把该尺寸放入队列

#### Scenario: 后台补齐
- **WHEN** 队列中存在缺预览的资产
- **THEN** 按限速逐个生成，生成后下一次请求命中预览

#### Scenario: 源文件不可解码
- **WHEN** 源文件损坏或格式不被支持
- **THEN** 该资产记为失败且不写入缓存文件，界面继续回退到原图

#### Scenario: 缓存可重建
- **WHEN** 预览缓存被删除
- **THEN** 系统不报错，浏览时重新生成

