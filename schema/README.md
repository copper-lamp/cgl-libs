# schema 变更与 `schema_version` 演进规则

本目录存放 `cgl-libs` 全部数据契约的 JSON Schema（JSON Schema draft 2020-12）。本文件是 `docs/cgl-libs.md` 第三章「备注」中 3.1「数据契约与版本演进」在 schema 侧的落地说明，两者冲突时以设计文档为准。

## 一、文件清单

| 文件 | 约束对象 | 对应设计文档章节 |
|---|---|---|
| `index.schema.json` | 顶层索引 `index.json` | 2.2 |
| `module-entry.schema.json` | 单条模块条目（被分片引用） | 2.3.2 / 2.3.6 |
| `module-shard.schema.json` | 模块分片 `modules/<range>.json` | 2.3.1 |
| `module-index.schema.json` | 分片清单 `modules/_index.json` | 2.3.3 |
| `by-id.schema.json` | id 定位表 `modules/by-id.json` | 2.3.3 |
| `mcbe-manifest.schema.json` | MCBE 版本主清单 `mcbe/manifest.json` | 2.4.3 |
| `mcbe-meta.schema.json` | MCBE 同步元信息 `mcbe/meta.json` | 2.4.3 |

## 二、`$id` 与 `$schema` 约定

- `$schema` 一律为 `https://json-schema.org/draft/2020-12/schema`。
- `$id` 一律为 `https://raw.githubusercontent.com/copper-lamp/cgl-libs/main/schema/<name>.schema.json`，与客户端读取 raw 文件的通道一致，不引入需要在启动器内硬编码的第二个域名。
- 跨文件引用使用 `$id` 的绝对 URL（如 `module-shard.schema.json` 引用 `module-entry.schema.json`），保证校验器与 IDE 都能直接解析。

## 三、`schema_version` 语义

`schema_version` 是单个整数，客户端只做大小比较：

| 比较结果 | 含义 | 客户端行为 |
|---|---|---|
| 相同 | 完全兼容 | 正常解析 |
| 客户端更高（本地支持 > 文件声明） | 文件是旧格式 | 按旧规则解析。仓库需保证 `main` 上的文件总是最新版，此情况只出现在用户本地缓存中 |
| 客户端更低 | 文件是新格式 | **必须拒绝**，不尝试解析 |

为什么高版本必须拒绝而不能「尽力解析」：高版本 schema 可能重命名或改类型字段，「尽力解析」的结果是静默读到错误数据（例如把 `sha256` 读成空字符串后认为「此条目无需校验」），比直接拒绝危险得多。

## 四、向后兼容规则（对仓库侧的强制要求）

1. **只增不改**：新字段只能追加，不能重命名或改变已有字段的类型与语义。
2. **客户端必须忽略未知字段**：JSON 反序列化不得因未知字段而失败。这一条同时是「仓库先发字段、客户端后支持」的灰度基础。
3. **可选性**：除用于安全判断的字段（`sha256`、`version`、`id`、`assets`）外，新字段一律可选并带默认值。
4. **枚举扩展**：`kind` / `platforms` / `channel` / `status` 的枚举值可以新增；客户端遇到未知枚举值必须忽略该条目而非报错（例如未来新增 `platform: "linux-arm64"` 时，Windows 客户端应跳过该资产条目而不是崩溃）。
5. **`min_launcher` 是兼容的第二道闸**：需要客户端配合的变更（例如新增 `channel` 过滤行为），既要升 `schema_version`，也要把 `min_launcher` 提到实现该行为的版本。

### 关于 `additionalProperties` 的分层取舍

规则 2 与「强制契约」存在表面张力，本仓库的取舍是按层区分：

- **顶层对象**（`index.json` / `by-id.json`）：`additionalProperties` 保持默认（允许未知字段），满足规则 2 与灰度基础。`index.schema.json` 因此未把顶层锁死。
- **内层结构**（`index.entries[]`、模块条目本身及其子对象、`assets[]`、`upstream`、`counts` 等）：`additionalProperties: false`，强制契约，防止把字段写错层级后被静默丢弃。
- **本地化 map**（`summary` / `changelog`）：`additionalProperties` 用于约束值类型，并配 `propertyNames` 约束 locale 形态，是例外：这里的键是开放集合而非字段名。

变更 `additionalProperties` 的宽松程度视为**契约变化**，需按第五节流程处理。

## 五、变更流程

### 5.1 一般变更

1. 修改 `schema/*.schema.json`，并在 PR 模板中勾选「schema 变更」。
2. 同步更新 `docs/cgl-libs.md` 对应章节——schema 与设计文档不一致时，以设计文档为准，不允许只改 schema。
3. 若变更使既有文件不再合法，必须在同一次 PR 内修正仓库内全部受影响文件，CI 才有机会通过。
4. `schema_version` 是否递增见 5.2。

### 5.2 何时递增 `schema_version`

| 变更 | 是否递增 |
|---|---|
| 新增一个**可选**字段，且旧客户端忽略它不会有安全影响 | 不递增（规则 1 + 3 的灰度路径） |
| 新增枚举值（`kind` / `platforms` / `channel` / `status`） | 不递增（规则 4，客户端按忽略未知值处理） |
| 新增必填字段 | 递增 |
| 改变已有字段的类型或语义 | 递增 |
| 重命名或删除字段 | 递增（且必须先走字段废弃流程） |
| 收紧校验（如降低 `icon.size` 上限、缩短正则接受集） | 递增，并同步抬 `min_launcher` |

递增时的动作：改 `schema_version` 的 `minimum` / 描述文字、更新设计文档 3.1、在 PR 描述中写明「旧客户端会拒绝解析」并确认这是预期行为。

### 5.3 字段废弃流程（三步，跨三个发布周期）

1. **标记**：在该字段的 schema `description` 中加 `[deprecated since schema_version=N, use X]`；仓库开始同时写新旧字段；自 `generated_at` 起 90 天内两者必须一致。
2. **停止读取**：客户端发版后不再读取旧字段；仓库 CI 增加「旧字段已无客户端读取」的说明记录。
3. **移除**：至少经过一个启动器大版本（版本号第二位 +1）后，在升 `schema_version` 的同一次 PR 中移除旧字段。

不允许「先删后通知」。

## 六、CI 强制但 schema 不表达的约束

以下约束依赖跨字段或跨文件语义，纯 JSON Schema 无法表达，由 `tools/validate.mjs` 在 CI 中强制。schema 中已在这些字段的 `description` 内注明「由 CI 校验」：

| 约束 | 依据 |
|---|---|
| `permissions_derived` 三布尔与 `permissions` 逐项一致 | 2.3.6 四 |
| `yanked: true` 时 `yank_reason` 必填；`yanked: false` 时必须为 `null` | 2.3.2 |
| `license: "proprietary"` 不得出现在 `channel: "stable"` | 2.3.5 / 审核红线第 3 条 |
| `max_launcher` 非 null 时不得小于 `min_launcher` | 审核红线第 4 条 |
| `assets[].platform` 必须属于条目 `platforms` | 2.3.2 |
| `assets[]` 必须覆盖 `platforms` 的每一个平台 | 2.3.6 三 |
| `id` 与 `i18n_namespace` 全仓库唯一 | 2.8.2 第 5、6 步 |
| 分片归属：条目 `id` 首字符必须落在所在分片 `range` 内 | 2.8.2 第 7 步 |
| `api_version` 属于仓库声明的支持集合（当前仅 `1`） | 2.8.2 第 9 步 |
| `assets[].url` 实际下载内容的 sha256 与 `size` 与声明一致 | 2.8.2 第 10 步 |
| `icon.path` 存在、`icon.sha256` 与实际文件一致 | 2.8.2 第 10 步 |
| 单分片不得超过 262144 字节（256 KB） | 1.8 / 2.3.4 |

新增类似约束时，应同步在本表登记，避免「schema 里看不到、CI 里在拒绝」的认知落差。

## 七、本地校验

```bash
# 语法层面：确认每个 schema 都是合法 JSON 且 $schema 为 draft 2020-12
node -e "for (const f of require('fs').readdirSync('schema').filter(n=>n.endsWith('.json'))) { const s=JSON.parse(require('fs').readFileSync('schema/'+f,'utf8')); if (s.$schema !== 'https://json-schema.org/draft/2020-12/schema') throw new Error(f); console.log('OK', f); }"

# 契约层面：用 tools/validate.mjs 对仓库内文件做完整校验（含上表全部 CI 约束）
node tools/validate.mjs --schema
node tools/validate.mjs --assets
```
