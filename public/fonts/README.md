# 字体子集

全部为 SIL Open Font License 1.1，许可证见同目录 `LICENSE-*.txt`。来源为 [google/fonts](https://github.com/google/fonts) 的可变字体，经 `tools/subset-fonts.py` 实例化并裁成 woff2 子集。子集以 `NT …` 为字体族名注册，避免与系统里装的完整版同名字体混用。

| 文件 | 来源 | 实例 | 字符 |
| --- | --- | --- | --- |
| `noto-sans-sc-400.woff2` / `-700` | Noto Sans SC | wght 400 / 700 | 界面用字 + ASCII + 标点 + GB2312 一级字（3755），覆盖常见中文名 |
| `noto-serif-sc-600.woff2` | Noto Serif SC | wght 600 | 界面用字 + GB2312 一级字（头像首字、房间名） |
| `noto-serif-sc-700.woff2` | Noto Serif SC | wght 700 | 仅界面用字（标题） |
| `inter-var.woff2` | Inter | opsz 14，wght 400–700 | ASCII（数字） |
| `fraunces-rank.woff2` | Fraunces | opsz 72，SOFT 30，WONK 0，wght 620 | `AKQJ0-9`（牌面点数） |

生僻字不在子集内时回退到系统中文字体。改了界面文案后重跑：

```sh
python3 tools/subset-fonts.py <放着上述 TTF 和 OFL 文本的目录>
```
