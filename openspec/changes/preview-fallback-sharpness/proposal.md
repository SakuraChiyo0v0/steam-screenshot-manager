## Why

"全部截图"里的图片发虚。定位后分两层：反馈截图来自旧打包版本（占位游戏名 + schema 2 + Steam 缩略图），当前构建实测是 800px 预览；但**当前构建在预览尚未生成时也会发虚，并且不会自愈**——图片显示后即使预览生成也不替换，用户会一直看到糊的那张。

## What Changes

- 新增 `preview:ready` 事件：后台生成预览后通知渲染层，相册网格与查看器缩略图带重新请求该图，自动换成清晰且更轻的预览。
- 归档结束时把缺预览的资产放进后台队列预热，让图库在归档后自然变"热"。
- 预览队列按实测解码耗时自适应让出（忙 x 毫秒让出 x 毫秒），避免同步解码占满主进程。
- 保持缩略图的回退顺序为「自建预览 → Steam 缩略图 → 原图」。

### 非目标

- 不把回退改成"直接返回 4K 原图"：一屏 200 张会触发渲染层解码风暴，实测会把协议响应一起拖住（详见实施报告第 3 节）。
- 不为冷图库做"首屏必须立刻清晰"的同步生成：nativeImage 解码是同步的，会卡界面。
- 不改变预览尺寸策略。

## Capabilities

### Modified Capabilities

- `preview-cache`：新增预览就绪通知与归档后预热；明确回退顺序与队列占空比约束。

## Impact

- **改动文件**：`src/shared/ipc.ts`、`src/preload/index.ts`、`src/main/preview-queue.ts`、`src/main/archive-job.ts`、`src/main/asset-protocol.ts`、`src/renderer/src/{App.tsx,Viewer.tsx}`。
- **实测**：热图库相册图片 800px（卡片 396px）；预览就绪后图片地址出现 `?retry=N`，确认自动替换生效。
- **已知限制**：冷图库预热速度受 CPU 影响，尚未生成预览的图会先显示 Steam 缩略图再自动变清晰。
