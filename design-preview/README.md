# 夜席 v3 · 高保真静态预览

纯 HTML/CSS 静态稿，不连服务器、不含游戏逻辑。设计说明见 [`docs/design/v3-visual.md`](../docs/design/v3-visual.md)。

| 文件 | 内容 |
| --- | --- |
| `01-table-flop.html` | 桌面 · 电子牌 · 6 人翻牌圈进行中 |
| `02-phone-action.html` | 手机 · 轮到你（加注面板） |
| `03-showdown-split.html` | 桌面 · 电子牌摊牌、主池/边池自动判定待确认 |
| `04-create-room.html` | 桌面 · 创建房间 |
| `05-phone-join.html` | 手机 · 扫码入座（补充） |
| `06-table-physical.html` | 桌面 · 实体牌模式翻前（补充） |

```sh
node design-preview/tools/build.mjs                 # 由 tools/parts.mjs 生成上面的 HTML
node design-preview/tools/shoot.mjs <输出目录> [前缀]  # Playwright 截图：桌面 1440×900@2x，手机 390×844@3x
node design-preview/tools/capture-current.mjs <目录>  # 启动本地服务，截 v2 现状（审视用）
```

## 资源来源

- 花色、卡牌、牌背、筹码、图标、毡面/纸面噪点：本仓库原创（`tools/parts.mjs`、`v3.css`），HTML/CSS/内联 SVG。
- 字体：预览直接引用 `../public/fonts/fonts.css`，即真实前端使用的 woff2 子集（SIL OFL 1.1，见 `public/fonts/README.md`）。旧的 `fonts/` 整包副本（约 22MB）已加入 `.gitignore`，不随仓库提交。
- 实机截图：`node design-preview/tools/shoot-real.mjs <输出目录>` 启动真实服务，打一手电子牌和一手实体牌并截图。
