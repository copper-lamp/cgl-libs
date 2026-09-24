# cgl-libs · 铜傀儡官方元数据仓库

`cgl-libs` 是铜傀儡（CopperGolem）生态的**唯一官方元数据源**：启动器运行时需要的、会随时间变化且不由用户本机产生的数据，全部从这里拉取。本仓库只存放元数据与索引，不存放体积庞大的二进制本体。

本仓库的完整规格见设计文档 `docs/cgl-libs.md`（在铜傀儡主仓库 `docs/` 下）。本 README 面向模块作者与提交者。

## 一、三层职责

| 层 | 承载内容 | 存放位置 |
|---|---|---|
| 索引层 | 各清单/分片的路径、大小、摘要、生成时间 | 本仓库内（小文件，秒级拉取） |
| 元数据层 | 模块条目、MCBE 版本条目、校验摘要 | 本仓库内（分片 JSON） |
| 资产层 | 模块安装包、图标、游戏版本整包 | GitHub Releases 资产 / 模块作者自有 CDN / 微软 CDN，本仓库只存 URL 与 sha256 |

## 二、目录结构

```
cgl-libs/
├─ README.md                      # 本文件：仓库说明 + 如何提交模块
├─ LICENSE                        # 仓库元数据许可（CC0-1.0）
├─ CODEOWNERS                     # modules/** 与 schema/** 的必需审核人
├─ schema/                        # 全部数据契约的 JSON Schema（draft 2020-12）
│  ├─ index.schema.json           # index.json
│  ├─ module-entry.schema.json    # 单条模块条目
│  ├─ module-shard.schema.json    # 模块分片
│  ├─ module-index.schema.json    # modules/_index.json
│  ├─ by-id.schema.json           # modules/by-id.json
│  ├─ mcbe-manifest.schema.json   # mcbe/manifest.json
│  ├─ mcbe-meta.schema.json       # mcbe/meta.json
│  └─ README.md                   # schema 变更与 schema_version 演进规则
├─ modules/                       # 模块元数据分片（含生成物，见下）
├─ mcbe/                          # MCBE 版本元数据（manifest.json 与 meta.json）
├─ assets/icons/                  # 模块图标 <module-id>.png（<= 32 KB）
├─ index.json                     # 顶层索引（唯一稳定入口，CI 生成）
├─ index.json.sha256              # index.json 摘要（防降级锚点）
├─ index.json.minisig             # index.json 的 minisign 签名
├─ .github/
│  ├─ workflows/                  # validate.yml / build-index.yml / sync-mcbe.yml
│  └─ PULL_REQUEST_TEMPLATE.md    # 模块提交模板
└─ tools/                         # 校验与生成脚本（Node，无第三方运行时依赖）
```

### 生成物：不要手工编辑

以下文件全部由 CI 生成，人工修改会被 `validate.yml` 直接拒绝：

`index.json`、`index.json.sha256`、`index.json.minisig`、`modules/_index.json`、`modules/by-id.json`，以及 `modules/<range>.json` 全部内容（由 `tools/build-index.mjs` 从提交数据重写）。

模块作者**只需要**新增/修改分片内的条目与图标；索引与分片格式由工具统一产出。

## 三、客户端如何使用（一句话链路）

```
拉取 index.json                     → 校验 sha256 + minisign 验签 → 缓存，并写入防降级锚点
  → 读 modules/_index.json          → 校验 sha256 → 得到分片清单
  → 按需拉取 modules/<range>.json    → 校验 sha256 → 合并进本地缓存
  → 展示：与本地已注册模块按 id 关联
  → 安装：下载 assets[].url → 校验 sha256 → 解包到 modules_dir() → 登记并启用
```

三级校验链缺一不可：`index.json`（sha256 + minisign）→ 分片/清单（sha256）→ 安装包与图标（sha256）。客户端**不提供**任何「忽略校验」开关。

## 四、如何提交一个模块

### 4.1 前置条件（重要）

模块隔离能力落地前，本仓库**只接受官方（`author.verified: true`）条目**，第三方 PR 一律 `rejected` 并附指向隔离能力进度的说明。

原因：当前内核的附加模块是动态库加载进启动器进程的形态，模块与内核共享同一地址空间与同一组权限，模块可以绕过 `permissions` 声明直接调用任意系统 API——此时 `permissions` 只是一份君子协定，审核红线第 7 条**无法被强制执行**。在缺少强制手段时开放投递，等于把用户暴露在无约束的任意代码执行之下，且 yank 只能事后补救（已安装的模块不会因 yank 而卸载）。权限强制侧（沙箱）已在内核落地；尚未落地的是受管控子进程托管与 IPC 传输。第三方投递的开放时间点绑定在后一项就绪之后。

### 4.2 提交步骤

1. Fork 本仓库，新建分支。
2. 在 `modules/<range>.json` 的 `modules` 数组中新增条目（`range` 由模块 id 的首字符决定：`[0-9]` 归 `0-9.json`，`[a-z]` 按字母范围归片）。条目字段表见 `docs/cgl-libs.md` 2.3.2，JSON Schema 见 `schema/module-entry.schema.json`。
3. 把图标放到 `assets/icons/<module-id>.png`（PNG，建议 128x128，单文件 <= 32 KB）。
4. 在 Release 中附带安装包与 `<资产名>.sha256` 校验文件；安装包文件名遵循 `<id>-<version>-<platform>.cglm`。
5. **不要**修改 `index.json` 等生成物。
6. 按 `.github/PULL_REQUEST_TEMPLATE.md` 逐项填写 PR 描述。
7. 等待 CI 通过（目标 15 分钟内）与维护者审核。首个来自新作者的模块需两名维护者复核。

### 4.3 提交者需要手工填写的字段

| 字段 | 来源 |
|---|---|
| `id` / `i18n_namespace` / `display_name` / `author.name` | 模块 manifest 直取 |
| `author.contact` | manifest 的 `author.url`（优先）或 `author.email`；二者皆缺则提审失败 |
| `repo` / `license` / `version` / `api_version` / `platforms` | manifest 直取 |
| `min_launcher` / `max_launcher` | manifest 的 `launcher.min` / `launcher.max` 展平 |
| `summary` / `changelog` | manifest 描述与 Release 正文，折叠为 locale map |
| `assets[]` | Release 资产矩阵（每个平台一条，缺一则提审失败） |
| `published_at` | Release 的 `published_at` |

### 4.4 必须留给维护者 / CI 的字段（提交者不得自行填写）

| 字段 | 填写方 | 值 |
|---|---|---|
| `channel` | cgl-libs CI 注入 | 依据 Release 是否为预发布与审核结论判定 |
| `status` | 审核流程 | 提交时写 `pending`，仅维护者可置 `approved` / `rejected` |
| `yanked` | 维护者 | 提交时写 `false` |
| `yank_reason` | 维护者 | `yanked` 为 `true` 时必填，否则为 `null` |
| `author.verified` | 维护者 | 提交时写 `false`，不得自行置 `true` |
| `icon.sha256` / `icon.size` / `permissions_derived` | cgl-libs CI 计算 | 只读派生值 |

任何无法由 manifest 与 Release 唯一确定的字段，一律**失败**而非猜测——提审链路不允许「猜一个默认值」。

## 五、审核红线（任一条不满足即拒绝合并，无例外）

1. 条目 `id` 与既有条目冲突，或不符合命名规范（两段式 `author.module`）。
2. 缺少 `sha256`，或 `sha256` 与 CI 实际下载计算值不符。
3. `license` 为空或为未明确的开源/商业许可标识；闭源模块必须显式标注 `proprietary` 且只允许出现在 `beta` / `dev` 通道，不得进入 `stable`。
4. 声明的 `min_launcher` / `max_launcher` 区间非法（语义倒挂、无法解析为 semver）。
5. 模块作者未在本仓库留可追责的联系方式（`author.contact`）。
6. 下载地址不可达，或指向会被覆盖的可变地址（如 `.../latest/download/...`），除非该地址同时提供 pin 死的 sha256。
7. 模块声明的 `permissions` 枚举与实际行为不一致（如声明无 `network` 却发起出站请求），或声明了 `filesystem:game-dir` / `account:read` / `process:spawn` 等高危权限但未在 PR 中说明理由。
8. 模块隔离能力落地前，只接受 `author.verified` 为 `true` 的条目。

## 六、关键字段约定

### 6.1 两段式 `id` 与单段 `i18n_namespace`

- `id` 规范：`^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$`，形如 `author.module`，全局唯一。**`id` 只用于身份识别**：目录名、条目主键、DB scope。因含点号，它**不可**用作 i18n 键前缀。
- `i18n_namespace` 规范：`^[a-z][a-z0-9-]{2,31}$`，**单段、无点号**，在全仓库内全局唯一。框架文案键一律写作 `module.<i18n_namespace>.<flatKey>`。
- 二者必须**显式声明**，不允许由 `id` 隐式推导。原因：内核 `lookup` 与前端 `lookup` 都按 `.` 切分键路径，`module.copper-lamp.server-manager.navTitle` 会被切成 4 段而永远查不到。

### 6.2 平台枚举（权威）

`windows-x86_64` | `windows-aarch64` | `android-arm64` | `linux-x86_64`

旧枚举 `windows-x64` / `windows-arm64` / `linux-x64` / `macos-arm64` **全部作废**；macOS 不在本项目路线内。

### 6.3 权限枚举（权威，共 9 项）

`filesystem:read` / `filesystem:write` / `filesystem:game-dir` / `network` / `process:spawn` / `download:enqueue` / `settings:write` / `intents:request` / `account:read`

`permissions_derived` 三布尔为**只读派生摘要**，由 CI 生成、不接受人工填写，映射规则唯一：

| 摘要布尔 | 为 `true` 的条件 |
|---|---|
| `network` | `permissions` 含 `network` |
| `spawn_process` | `permissions` 含 `process:spawn` |
| `write_outside_module_dir` | `permissions` 含 `filesystem:game-dir` 或 `settings:write` |

细粒度枚举是唯一权威模型，三布尔仅为列表页渲染横幅的加速摘要：细粒度枚举能表达「只读应用数据」与「读写游戏目录」这种风险截然不同的诉求，且支持增量同意；三布尔只能整包接受。

### 6.4 `channel` 与 `status`

- `channel`：`stable` | `beta` | `dev`。客户端默认只展示 `stable`，其余需用户在设置中显式开启。
- `status`：`approved` | `pending` | `rejected`。只有 `approved` 会进 `index.json`。

### 6.5 分片

- 分片键取 `id` 的**首字符**；单分片上限 256 KB。
- 分片超过上限时 `tools/build-index.mjs` **不**自动再切分（自动切分会改变 `range` 语义，导致客户端缓存失效、URL 不稳定），而是让 CI 失败并提示维护者调整字母范围表。切分策略是仓库级决策，必须人工确认后随 PR 落地。

## 七、yank 与回滚

| 场景 | 处置 |
|---|---|
| 新版本有 bug 但无安全影响 | 提 PR 把条目 `version` 回退到上一可用版本，并在 `changelog` 说明；不删历史 |
| 有安全问题 | 提 yank PR：`yanked: true` + `yank_reason`；**保留条目**，不改 `version` |
| 模块整个不可用/作者要求下架 | 在分片中删除条目，并在设计文档侧记录 |
| 索引本身被污染 | revert 产生它的 single merge commit，CI 重新生成索引；同时轮换 minisign 密钥并发布新启动器 |

关键原则：**yank 优先于删除**。删除条目会让已安装该模块的用户失去「这个模块曾被官方收录后被移除」的解释链；yank 保留了可审计性，同时阻断新安装。yank 类 PR 走快速通道：允许一名维护者在 CI 的 `--assets` 步骤失败时跳过该步骤直接合并（安全事件不宜被网络问题阻塞），但必须在 PR 描述中记录原因。

## 八、本地开发

```bash
# 校验（schema + sha256 + 链接 + id 唯一 + semver）
node tools/validate.mjs --schema
node tools/validate.mjs --assets

# 重新生成索引与分片，并与仓库内已有文件比对（CI 用这条保证生成确定性）
node tools/build-index.mjs --check

# 生成 index.json.sha256 与 minisign 签名
node tools/sign.mjs
```

脚本只依赖 Node 20 标准库，无第三方运行时依赖。

## 九、许可证

- 仓库元数据（本仓库内的 JSON 数据）采用 **CC0-1.0**，见 [LICENSE](LICENSE)。事实性数据，最大化可用性。
- `tools/` 下的脚本采用 **MIT**，见 [tools/LICENSE](tools/LICENSE)。
- 每个模块条目**必须**填 `license`；`proprietary` 的模块不得进入 `stable`。
- 启动器需在设置「关于」Tab 提供「开源许可」页，列出所有已装模块的 `license` 与 `repo` 链接。
- 内核自身引入的闭源二进制与本仓库是**两条独立的合规线**，不可互相豁免。本仓库不应收录任何需要「随启动器分发闭源 DLL」的模块，除非已明确授权。

## 十、约定

- 提交信息头用英文，正文用中文。
- 禁止使用 emoji。
- 数据契约的变更规则见 [schema/README.md](schema/README.md)。
