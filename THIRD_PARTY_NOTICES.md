# 第三方素材与来源

本文件逐项列出仓库里所有不是手写代码的素材、它们的来源和许可。新增素材时必须同时更新这里；来源说不清的素材不能合并。

## 字体（随仓库分发）

全部来自 [google/fonts](https://github.com/google/fonts)，用 `tools/subset-fonts.py` 实例化并裁成 woff2 子集。字体内部名称表、版权与许可字段保持原样；CSS 里以 `NT …` 族名注册，只是为了不和系统里装的完整版混用。许可证全文在 `public/fonts/LICENSE-*.txt`，与上游 `ofl/<family>/OFL.txt` 逐字节一致（2026-11-18 核对）。

| 文件 | 字体 | 上游路径 | 版权（字体内嵌） | 许可 |
| --- | --- | --- | --- | --- |
| `public/fonts/noto-sans-sc-400.woff2`、`-700.woff2` | Noto Sans SC | `ofl/notosanssc/` | © 2014-2021 Adobe, with Reserved Font Name 'Source' | SIL OFL 1.1 |
| `public/fonts/noto-serif-sc-600.woff2`、`-700.woff2` | Noto Serif SC | `ofl/notoserifsc/` | © 2017-2024 Adobe（上游 OFL.txt 首行写的是 © 2012 Google Inc.，照原样保留） | SIL OFL 1.1 |
| `public/fonts/inter-var.woff2` | Inter | `ofl/inter/` | © 2016/2020 The Inter Project Authors | SIL OFL 1.1 |
| `public/fonts/fraunces-rank.woff2` | Fraunces | `ofl/fraunces/` | © 2018/2020 The Fraunces Project Authors | SIL OFL 1.1 |

OFL 要点：可以自由使用、修改、随软件分发；不能单独出售字体；修改版不能使用保留字体名（Noto Sans SC 的保留名是 `Source`，子集没有使用这个名字）；分发时附带版权声明和许可证（已附）。

## 运行时 npm 依赖（不在仓库里，`npm ci` 时下载）

| 包 | 许可 | 用途 |
| --- | --- | --- |
| [`ws`](https://github.com/websockets/ws) | MIT | WebSocket 服务端 |
| [`qrcode`](https://github.com/soldair/node-qrcode) | MIT | 服务端生成加入二维码 |

`qrcode` 的传递依赖均为 MIT 或 ISC（`npm ls --omit=dev --all` 核对）。开发依赖 `@playwright/test`（Apache-2.0）、`jsqr`（Apache-2.0）、`pngjs`（MIT）只用于测试，不随运行时分发。

## 本仓库自制素材

| 文件 | 怎么来的 | 重新生成 |
| --- | --- | --- |
| `public/audio/*.wav` | 正弦、噪声、包络合成，未采样任何外部音频 | `npm run sounds` |
| `public/icons/*.png` | 用本仓库 HTML/CSS 在 Chromium 里渲染截图 | `node tools/make-icons.mjs` |
| `public/night/awake.mp4` | 16×16 纯黑 4 秒、无音轨的 H.264 视频，只用于局域网 http 下没有 Wake Lock 时保持屏幕常亮 | `ffmpeg -f lavfi -i color=c=black:s=16x16:r=2:d=4 -c:v libx264 -profile:v baseline -pix_fmt yuv420p -movflags +faststart public/night/awake.mp4` |
| 牌面、牌背、筹码、花色、图标、毡面纹理 | HTML/CSS/内联 SVG 手写 | — |

没有使用任何商业游戏（包括 Balatro）的美术、音频或代码；视觉只参考了质感方向。
