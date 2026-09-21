## Why

前面几个阶段功能跑通了，但没有量化过内存占用。实测（600 张相册）发现三个具体浪费：查看器缩略图带把整册 600 张全部渲染且不做懒加载、游戏封面解码 4K 原图、模态背景的毛玻璃要求浏览器栅格化整页。打开查看器时进程 RSS 达到 745 MB，其中 GPU 进程 410 MB。

## What Changes

- **迷你预览**：新增 200px 尺寸（`cache/minis/`）与 `ssm-asset://mini/<id>` 通道，供查看器缩略图带使用（4.5 KB/张，而 800px 预览约 40 KB）。
- **缩略图带窗口化**：只渲染当前项前后各 30 张，窗口外用等宽占位保持滚动几何；600 张 → 31 个图片元素。
- **封面改走缩略图通道**：游戏封面使用预览而不是 4K 原图。
- **离屏卡片跳过渲染**：`.game-card` / `.shot-card` 使用 `content-visibility: auto` + `contain-intrinsic-size`。
- **去掉模态毛玻璃**：保留压暗背景，去掉 `dialog::backdrop` 的 `backdrop-filter: blur()`。
- **网格图片异步解码**：`decoding="async"`。
- **量化脚本**：`docs/evidence/measure-memory.mjs` + 按进程类型采样的 RSS，作为后续回归基线。

### 非目标

- 不做 Electron 运行时的深度调优（禁用 GPU 进程、限制 V8 堆等），它们会牺牲渲染性能。
- 不改变预览的视觉尺寸策略（卡片仍用 800px 预览，保证不发虚）。
- 不引入虚拟滚动替换现有分页（当前是 200 张/页 + 加载更多）。

## Capabilities

### Modified Capabilities

- `preview-cache`：新增迷你尺寸与对应协议通道；批量生成支持选择尺寸。
- `desktop-shell`：离屏卡片跳过渲染、去掉模态毛玻璃、网格图片异步解码。

## Impact

- **改动文件**：`src/core/library/previews.ts`、`src/main/asset-protocol.ts`、`src/main/preview-queue.ts`、`src/main/build-previews.ts`、`src/shared/types.ts`、`src/main/ipc.ts`、`src/renderer/src/{Viewer.tsx,App.tsx,view-model.ts,styles.css}`。
- **数据库**：无变化。
- **实测收益**：相册阶段 −102.8 MB（GPU −33%），查看器阶段 **−220 MB（−30%）**、GPU −53%、缩略图元素 −95%。
- **观感**：模态背景由毛玻璃改为纯压暗，已截图确认界面正常。
