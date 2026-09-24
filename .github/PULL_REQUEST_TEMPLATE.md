# 模块提交模板 · cgl-libs

> 依据 docs/cgl-libs.md 2.8.1。请逐项填写，留空项视为未完成。
> 提交前请先阅读 README.md 的「审核红线」一节：任一条不满足即拒绝合并，无例外。
> 禁止使用 emoji；请使用纯文本与 Markdown 表格。

## 一、变更类型

请勾选一项（多项变更请拆分为多个 PR）：

- [ ] 新增模块
- [ ] 更新模块版本
- [ ] yank（撤回条目）
- [ ] schema 变更
- [ ] 其他（请说明）

## 二、模块 id 与版本

| 项目 | 值 |
|---|---|
| 模块 id（两段式 `author.module`） | |
| i18n_namespace（单段、无点号） | |
| 变更前版本 | |
| 变更后版本 | |
| 目标 channel（stable / beta / dev） | |
| 涉及分片文件（如 `modules/s-u.json`） | |

## 三、安装包 sha256 的计算方式

请提供可复现的命令，并粘贴输出：

```
# 示例：sha256sum <file>
# Windows: certutil -hashfile <file> SHA256
```

| 平台 | 资产文件名 | sha256 | 字节数 |
|---|---|---|---|
|  |  |  |  |

## 四、首次提交必填：作者身份与来源

- 作者 / 组织名：
- 可追责联系方式（主页或邮箱，对应条目 `author.contact`）：
- 源码仓库地址（对应条目 `repo`）：
- 许可证（SPDX 标识；闭源填 `proprietary`）：
- 是否官方模块（`author.verified` 只能由维护者置位，请勿自行勾选）：

## 五、若含闭源二进制

- 二进制来源：
- 授权依据（许可协议 / 书面授权）：
- 是否已获维护者事前同意：
- 确认不在 `stable` 通道（依据 2.3.5，`proprietary` 只允许出现在 `beta` / `dev`）：

## 六、自查清单

- [ ] schema 校验通过（`node tools/validate.mjs --schema`）
- [ ] sha256 已复核（`node tools/validate.mjs --assets`，与实际下载计算值一致）
- [ ] 下载链接可达，且不是会被覆盖的可变地址（如 `.../latest/download/...`）
- [ ] 未修改 `index.json`（该文件由 CI 生成，人工修改会被 CI 拒绝）
- [ ] 未修改 `index.json.sha256` / `index.json.minisig` / `modules/_index.json` / `modules/by-id.json`（均为 CI 生成物）
- [ ] `permissions` 声明与模块实际行为一致（审核红线第 7 条）
- [ ] 若声明了 `filesystem:game-dir` / `account:read` / `process:spawn`，已在本 PR 中说明理由
- [ ] `min_launcher` / `max_launcher` 区间合法（可解析为 semver，且不语义倒挂）
- [ ] 分片归属正确（条目所在分片的 `range` 与 id 首字符匹配）

## 七、补充说明

请描述本 PR 的目的、影响范围，以及审核人需要重点核对的内容。
