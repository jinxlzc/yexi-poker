# 开源 / 发布前检查清单

每次公开仓库或打版本前按顺序走一遍。带 **[维护者]** 的项只能由仓库所有者决定或操作。

## 1. 法律与素材

- [x] 已选择 MIT：仓库根目录有 `LICENSE`，`package.json` 的 `license` 字段为 `MIT`。没有 LICENSE 不要公开。若改许可证，需同步这两处。
- [ ] `THIRD_PARTY_NOTICES.md` 覆盖仓库里每个非手写素材；`public/fonts/LICENSE-*.txt` 都在。
- [ ] 新增素材都能用仓库里的脚本重新生成，或有兼容许可证。

## 2. 敏感信息

- [ ] 当前文件与**全部 git 历史**里没有密钥、令牌、私钥、数据库、玩家数据、真实局域网地址、个人路径或邮箱：

  ```bash
  git log --all -p | rg -n -i '(api[_-]?key|secret\s*[:=]|password\s*[:=]|ghp_|github_pat_|sk-[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|xox[bpa]-)'
  git log --all --name-only --format= | sort -u | rg -i '(^data/|\.sqlite|\.db$|\.env|\.pem$|\.key$)'
  ```

  检查个人目录、工作目录的绝对路径和私有网段里的具体地址。文档和视觉稿用占位符表示局域网地址。
- [ ] 提交作者邮箱是 GitHub noreply 或你愿意公开的地址：`git log --all --format='%an <%ae>' | sort -u`。
- [ ] `.gitignore` 含 `data/`、`*.sqlite*`、`.env*`、`test-results/`。

## 3. 质量

- [ ] 干净目录里按 README 安装能跑起来：`npm ci && npm start`，电脑打开 `http://localhost:8787`，手机从局域网地址加入。
- [ ] `npm test` 全绿（Node 22.13 与 24 都跑）。
- [ ] `npx playwright install chromium && npm run test:e2e` 全绿。
- [ ] `npm audit --omit=dev` 无已知漏洞。
- [ ] 至少用一台 iPhone 和一台安卓机在真实 Wi-Fi 上打完一晚流程（开房 → 入座 → 几手 → 散场），确认二维码、底牌隐私、重连、散场总结。

## 4. 文档与版本

- [ ] `package.json` 的 `version`、`CHANGELOG.md` 最新一节标题、要打的 tag 三者一致。
- [ ] README 的安装命令、Node 版本、已知限制与实际一致；没有虚构的徽章、演示地址或截图。
- [ ] `SECURITY.md` 写明的私密报告入口确实可用。

## 5. 仓库设置（[维护者]）

- [ ] 开启 GitHub 私密漏洞报告（Settings → Code security → Private vulnerability reporting），否则改 `SECURITY.md` 里的说法。
- [ ] 确认 GitHub Actions 在公开后能跑（`.github/workflows/ci.yml`）。
- [ ] 仓库描述、话题标签；设为公开；需要时打 tag `vX.Y.Z` 并发布 Release，正文从 CHANGELOG 复制。
