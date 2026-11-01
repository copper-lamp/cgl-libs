// validate.mjs —— cgl-libs CI 校验脚本（离线部分 + 可选的资产复核）
//
// 契约依据 docs/cgl-libs.md 2.8.2 的十三步、2.5 签名与完整性、1.8 一致性要求。
//
// 用法：
//   node tools/validate.mjs --schema               JSON Schema 校验 + 语义校验（离线，CI 主入口）
//   node tools/validate.mjs --generated-guard      仅检查生成物是否被人工改动（需 git，必须在生成前运行）
//   node tools/validate.mjs --schema --source-only
//                                                  仅校验输入元数据，不要求旧索引与新输入一致
//   node tools/validate.mjs --schema --generated-guard
//                                                  schema / 语义 / 摘要校验，并检查生成物改动
//   node tools/validate.mjs --schema --assets      追加资产下载复核（需网络，超时 60s）
//   node tools/validate.mjs --links                追加链接可达性 HEAD 探测（需网络）
//   node tools/validate.mjs --schema --strict       把 warning 也当作失败
//
// 退出码：0 通过；1 存在 error；2 用法/环境错误。
//
// 与 2.8.2 十三步的对应关系：
//   第 3 步  拒绝人工改动生成物        -> --generated-guard
//   第 4 步  JSON Schema 校验          -> --schema（本脚本自实现的 draft 2020-12 子集）
//   第 5 步  id 唯一性                 -> stepIdUnique
//   第 6 步  i18n 命名空间唯一性       -> stepNamespaceUnique
//   第 7 步  命名规范与分片归属        -> stepNamingAndShard
//   第 8 步  semver 合法性             -> stepSemver
//   第 9 步  兼容区间与 api_version    -> stepCompat
//   第 10 步 sha256 复核               -> --assets / stepAssetIntegrity（图标可离线校验）
//   第 11 步 链接可达性                -> --links
//   第 12 步 许可证合规                -> stepLicense
//   第 13 步 本地可重复性              -> 由 build-index.mjs --check 承担（workflow 中调用）
//
// 无第三方运行时依赖：JSON Schema 校验用 tools/lib/json-schema.mjs 自实现的子集，
// 摘要用 node:crypto，HTTP 用内置 fetch。

import { readFileSync, existsSync, mkdirSync, rmSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';

import {
  REPO_ROOT,
  GENERATED_FILES,
  SHARD_MAX_BYTES,
  MCBE_MANIFEST_PATH,
  SCHEMA_VERSION,
  ID_PATTERN,
  I18N_NAMESPACE_PATTERN,
  PLATFORMS,
  PERMISSIONS,
  CHANNELS,
  STATUSES,
  SUPPORTED_API_VERSIONS,
  repoRelative,
  readJsonFile,
  toPosix,
  listShardFiles,
  collectModuleEntries,
  shardRangeForId,
  isGeneratedShardFile,
  derivePermissions,
  compareSemver,
  isValidSemver,
  isRfc3339,
  sha256OfFile,
  sha256Hex,
  formatBytes,
} from './lib/common.mjs';
import { validateAgainstSchema, formatSchemaErrors, SchemaUnsupportedError } from './lib/json-schema.mjs';

// ---------------------------------------------------------------------------
// 结果收集
// ---------------------------------------------------------------------------

const problems = [];
const warnings = [];
const passed = [];

function error(step, where, field, expected, actual) {
  problems.push({ level: 'error', step, where, field, expected, actual });
}

function warn(step, where, detail) {
  warnings.push({ level: 'warning', step, where, detail });
}

function ok(step, detail) {
  passed.push({ step, detail });
}

// 2.8.2 末句要求："CI 校验失败时，工作流输出结构化摘要（哪一条目、哪一字段、期望值 vs 实际值）"。
function renderProblems(list, heading) {
  if (list.length === 0) return;
  process.stdout.write(`\n${heading}\n`);
  process.stdout.write('| # | 级别 | 条目/文件 | 字段 | 期望 | 实际 |\n');
  process.stdout.write('|---|---|---|---|---|---|\n');
  list.forEach((p, i) => {
    if (p.level === 'error') {
      process.stdout.write(
        `| ${i + 1} | error | ${esc(p.where)} | ${esc(p.field)} | ${esc(p.expected)} | ${esc(p.actual)} |\n`,
      );
    } else {
      process.stdout.write(`| ${i + 1} | warning | ${esc(p.where)} | ${esc(p.step)} | - | ${esc(p.detail)} |\n`);
    }
  });
}

function esc(v) {
  const s = v === undefined || v === null ? '-' : String(v);
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 220);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    schema: false,
    generatedGuard: false,
    sourceOnly: false,
    assets: false,
    links: false,
    strict: false,
    json: false,
    schemaDir: join(REPO_ROOT, 'schema'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--schema') opts.schema = true;
    else if (arg === '--generated-guard') opts.generatedGuard = true;
    else if (arg === '--source-only') opts.sourceOnly = true;
    else if (arg === '--assets') opts.assets = true;
    else if (arg === '--links') opts.links = true;
    else if (arg === '--strict') opts.strict = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--schema-dir') opts.schemaDir = argv[++i] ?? opts.schemaDir;
    else if (arg.startsWith('--schema-dir=')) opts.schemaDir = arg.slice('--schema-dir='.length);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      process.stderr.write(`[validate] 未知参数 "${arg}"，用 --help 查看用法。\n`);
      process.exit(2);
    }
  }
  if (opts.sourceOnly) opts.schema = true;
  if (!opts.schema && !opts.assets && !opts.links && !opts.generatedGuard) {
    // 无参数时默认做离线全量校验，避免"什么都不做还返回 0"的假通过。
    opts.schema = true;
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`validate.mjs - cgl-libs CI 校验

用法:
  node tools/validate.mjs [选项]

选项:
  --schema              JSON Schema 校验 + 全部离线语义校验（默认）
  --source-only         仅校验输入元数据（隐含 --schema，不比对尚未重建的索引）
  --generated-guard     拒绝人工改动生成物；单独使用时仅检查 diff（生成前执行）
  --assets              下载资产并复核 sha256/size（需网络，单文件超时 60s）
  --links               对 assets[].url / mirrors 做 HEAD 可达性探测（需网络）
  --strict              把 warning 也视为失败
  --json                以 JSON 输出结构化结果
  --schema-dir <dir>    schema 目录，默认 <仓库根>/schema
  -h, --help            显示本帮助

退出码: 0 通过 / 1 校验失败 / 2 用法或环境错误
`);
}

// ---------------------------------------------------------------------------
// Schema 装载
// ---------------------------------------------------------------------------

function loadSchema(name) {
  const abs = join(REPO_ROOT, 'schema', name);
  if (!existsSync(abs)) return null;
  return { abs, doc: readJsonFile(abs) };
}

/**
 * 组装"外部 $ref 解析器"。
 *
 * schema 之间用绝对 $id 互相引用（module-shard -> module-entry），
 * 因此先按 $id 建索引，再按 $id 反查本地文件。
 */
function buildExternalResolver() {
  const byId = new Map();
  const dir = join(REPO_ROOT, 'schema');
  if (!existsSync(dir)) return { resolve: () => undefined, schemas: byId };

  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const doc = readJsonFile(join(dir, name));
    if (typeof doc.$id === 'string') byId.set(doc.$id, doc);
  }
  return { resolve: (ref) => byId.get(ref), schemas: byId };
}

// ---------------------------------------------------------------------------
// 第 3 步：拒绝人工改动生成物
// ---------------------------------------------------------------------------

function stepGeneratedGuard() {
  const step = 'step3-generated-guard';
  let base = 'origin/main';
  try {
    execFileSync('git', ['rev-parse', '--verify', base], { cwd: REPO_ROOT, stdio: 'ignore' });
  } catch {
    try {
      execFileSync('git', ['rev-parse', '--verify', 'main'], { cwd: REPO_ROOT, stdio: 'ignore' });
      base = 'main';
    } catch {
      warn(step, 'git', `无法解析 origin/main 或 main，跳过生成物守卫（请确认 checkout fetch-depth: 0）`);
      return;
    }
  }

  let changed = [];
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    changed = out.split('\n').map((s) => s.trim()).filter(Boolean).map(toPosix);
    // 工作区未提交的改动也要覆盖（本地跑时常见）。
    const out2 = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
    changed = changed.concat(out2.split('\n').map((s) => s.trim()).filter(Boolean).map(toPosix));
  } catch (err) {
    warn(step, 'git', `git diff 执行失败：${err.message}`);
    return;
  }

  const offenders = [...new Set(changed)].filter((f) => GENERATED_FILES.includes(f));
  for (const f of offenders) {
    error(
      step,
      f,
      '文件',
      '生成物不得人工改动（由 CI 产出）',
      `出现在 diff 中；这些文件由 CI 生成：${GENERATED_FILES.join(', ')}。请回退该文件的改动。`,
    );
  }
  if (offenders.length === 0) ok(step, `未发现被人工改动的生成物（比对基准 ${base}）`);
}

// ---------------------------------------------------------------------------
// 第 4 步：JSON Schema 校验
// ---------------------------------------------------------------------------

function stepSchema(opts) {
  const step = 'step4-schema';
  const resolver = buildExternalResolver();

  const shardSchema = loadSchema('module-shard.schema.json');
  const indexSchema = loadSchema('module-index.schema.json');
  const entrySchema = loadSchema('module-entry.schema.json');
  const byIdSchema = loadSchema('by-id.schema.json');
  const mcbeSchema = loadSchema('mcbe-manifest.schema.json');
  const mcbeMetaSchema = loadSchema('mcbe-meta.schema.json');
  const topIndexSchema = loadSchema('index.schema.json');

  // schema/ 缺失时必须如实报告，而不是跳过校验假装通过（任务明确要求）。
  const required = [
    ['module-shard.schema.json', shardSchema],
    ['module-entry.schema.json', entrySchema],
    ['module-index.schema.json', indexSchema],
    ['index.schema.json', topIndexSchema],
  ];
  const missing = required.filter(([, s]) => s === null).map(([n]) => n);
  if (missing.length > 0) {
    error(
      step,
      'schema/',
      '文件',
      required.map(([n]) => n).join(', '),
      `缺失 ${missing.join(', ')}。schema 由另一条轨道提供；缺失时本步骤拒绝通过（不做"跳过即通过"）。`,
    );
    return;
  }

  const run = (label, data, schema) => {
    try {
      const errs = validateAgainstSchema(data, schema.doc, { externalResolver: resolver.resolve });
      for (const e of errs) {
        error(step, label, e.pointer === '#' ? '(根)' : e.pointer, '符合 schema', e.message);
      }
      return errs.length === 0;
    } catch (err) {
      if (err instanceof SchemaUnsupportedError) {
        error(step, label, 'schema', 'schema 关键字受支持', err.message);
      } else {
        error(step, label, 'schema', '可校验', err.message);
      }
      return false;
    }
  };

  let checked = 0;

  // 分片
  for (const shard of listShardFiles()) {
    let doc;
    try {
      doc = readJsonFile(shard.absPath);
    } catch (err) {
      error(step, shard.relativePath, '(文件)', '合法 JSON', err.message);
      continue;
    }
    run(shard.relativePath, doc, shardSchema);
    checked += 1;
  }

  // 生成物（存在才校验：本地未生成时不算错，CI 的 build-index 步骤会产出）
  for (const [name, schema] of [
    ['modules/_index.json', indexSchema],
    ['modules/by-id.json', byIdSchema],
    [MCBE_MANIFEST_PATH, mcbeSchema],
    ['mcbe/meta.json', mcbeMetaSchema],
    ['index.json', topIndexSchema],
  ]) {
    if (!schema) continue;
    if (opts.sourceOnly && GENERATED_FILES.includes(name)) continue;
    const abs = join(REPO_ROOT, name);
    if (!existsSync(abs)) continue;
    const doc = readJsonFile(abs);
    run(name, doc, schema);
    checked += 1;
  }

  ok(step, `已按 schema 校验 ${checked} 份文件（schema 目录：${repoRelative(join(REPO_ROOT, 'schema'))}）`);
}

// ---------------------------------------------------------------------------
// 离线语义校验：第 5~12 步
// ---------------------------------------------------------------------------

function collectEntries() {
  const { entries, errors: readErrors } = collectModuleEntries();
  for (const msg of readErrors) error('step4-schema', 'modules/', '(文件)', '可解析', msg);

  // 与 build-index.mjs 保持一致：本工具自己产出的分片不是"新条目来源"，而是对已有条目的
  // 重新归位。若不过滤，同一条 id 会因为同时出现在源分片与生成分片里而被误判为重复。
  // 判据见 build-index.mjs 的 isOwnGeneratedShardFile，此处复用同一实现。
  const filtered = [];
  const skipped = new Set();
  for (const item of entries) {
    if (skipped.has(item.sourcePath)) continue;
    if (isGeneratedShardFile(item.sourcePath)) {
      skipped.add(item.sourcePath);
      continue;
    }
    filtered.push(item);
  }
  if (skipped.size > 0) {
    ok('step4-schema', `跳过 ${skipped.size} 个本工具产出的分片（不参与唯一性判定）：${[...skipped].join(', ')}`);
  }
  return filtered;
}

function stepIdUnique(entries) {
  const step = 'step5-id-unique';
  const seen = new Map();
  for (const item of entries) {
    const id = item.entry.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    if (seen.has(id)) {
      error(step, id, 'id', '全仓库唯一', `与 ${seen.get(id)} 重复（本条来自 ${item.sourcePath}）`);
    } else {
      seen.set(id, item.sourcePath);
    }
  }
  if (seen.size > 0) ok(step, `${seen.size} 个 id 全仓库唯一`);
}

function stepNamespaceUnique(entries) {
  const step = 'step6-namespace-unique';
  const seen = new Map();
  for (const item of entries) {
    const ns = item.entry.i18n_namespace;
    if (typeof ns !== 'string' || ns.length === 0) continue;
    if (seen.has(ns)) {
      error(
        step,
        item.entry.id ?? '(未知条目)',
        'i18n_namespace',
        '全仓库唯一',
        `与 ${seen.get(ns)} 重复；命名空间是语言包挂载名，重复会导致两个模块文案互相覆盖（2.8.2 第 6 步）`,
      );
    } else {
      seen.set(ns, item.entry.id ?? item.sourcePath);
    }
  }
  if (seen.size > 0) ok(step, `${seen.size} 个 i18n_namespace 全仓库唯一`);
}

function stepNamingAndShard(entries) {
  const step = 'step7-naming-shard';
  for (const item of entries) {
    const id = item.entry.id;
    const where = typeof id === 'string' && id ? id : `(${item.sourcePath} 中无 id 的条目)`;

    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      error(step, where, 'id', '匹配 ^[a-z0-9]+(-[a-z0-9]+)*(\\.[a-z0-9]+(-[a-z0-9]+)*)+$（两段式 author.module）', JSON.stringify(id));
    }

    const ns = item.entry.i18n_namespace;
    if (typeof ns !== 'string' || !I18N_NAMESPACE_PATTERN.test(ns)) {
      error(step, where, 'i18n_namespace', '匹配 ^[a-z][a-z0-9-]{2,31}$（单段、无点号）', JSON.stringify(ns));
    }

    // 分片归属：防"模块被放进错误分片导致客户端漏查"（2.8.2 第 7 步）。
    //
    // 判定范围有讲究：2.3.4 规定的是 **build-index 产出的分片文件名**必须与 id 首字符
    // 对应（`<range>.json`）。而 modules/ 下由维护者/提审 bot 手写的"源分片"并没有
    // 命名约束——build-index 会按 id 把它们重新归位到正确 range 的文件里。
    // 因此这里只对"生成物形态"的文件（文件名即 range、且 range 是合法范围标识）
    // 校验归属；源文件放错不影响客户端查询，强行报错只会让 CI 对合法 PR 误报。
    if (typeof id === 'string' && id.length > 0) {
      const declared = item.declaredRange;
      const isRangeLikeName = declared !== null && declared !== undefined
        && /^([a-z]-[a-z]|[0-9]-[0-9]|_other)$/.test(declared)
        && item.sourcePath === `modules/${declared}.json`;
      const expectedRange = shardRangeForId(id);
      if (isRangeLikeName && declared !== expectedRange) {
        error(
          step,
          where,
          `${item.sourcePath} 的 range`,
          expectedRange,
          `实际 ${JSON.stringify(declared)}；id 首字符 "${id[0]}" 应归属 ${expectedRange}（2.3.4）`,
        );
      }
    }
  }
  ok(step, `已校验 ${entries.length} 条条目的 id/命名空间规范与分片归属`);
}

function stepSemver(entries) {
  const step = 'step8-semver';
  for (const item of entries) {
    const e = item.entry;
    const where = typeof e.id === 'string' ? e.id : item.sourcePath;

    if (!isValidSemver(e.version)) {
      error(step, where, 'version', '严格 semver', JSON.stringify(e.version));
    }
    if (!isValidSemver(e.min_launcher)) {
      error(step, where, 'min_launcher', '严格 semver', JSON.stringify(e.min_launcher));
    }
    if (e.max_launcher !== null && e.max_launcher !== undefined) {
      if (!isValidSemver(e.max_launcher)) {
        error(step, where, 'max_launcher', '严格 semver 或 null', JSON.stringify(e.max_launcher));
      } else {
        const cmp = compareSemver(e.min_launcher, e.max_launcher);
        if (cmp !== null && cmp > 0) {
          error(
            step,
            where,
            'max_launcher',
            `>= min_launcher (${e.min_launcher})`,
            `${e.max_launcher}；语义倒挂（审核红线第 4 条）`,
          );
        }
      }
    }
  }
  ok(step, `已校验 ${entries.length} 条条目的 semver 合法性`);
}

function stepCompat(entries) {
  const step = 'step9-compat';
  for (const item of entries) {
    const e = item.entry;
    const where = typeof e.id === 'string' ? e.id : item.sourcePath;

    if (!SUPPORTED_API_VERSIONS.has(e.api_version)) {
      error(
        step,
        where,
        'api_version',
        `属于支持集合 {${[...SUPPORTED_API_VERSIONS].join(', ')}}`,
        JSON.stringify(e.api_version),
      );
    }

    if (typeof e.published_at === 'string') {
      if (!isRfc3339(e.published_at)) {
        error(step, where, 'published_at', 'RFC3339 日期时间', JSON.stringify(e.published_at));
      } else if (Date.parse(e.published_at) > Date.now() + 24 * 3600 * 1000) {
        error(step, where, 'published_at', '不晚于当前时间', `${e.published_at}（超出容差 24h）`);
      }
    }

    if (!Array.isArray(e.platforms) || e.platforms.length === 0) {
      error(step, where, 'platforms', '非空数组', JSON.stringify(e.platforms));
    } else {
      for (const p of e.platforms) {
        if (!PLATFORMS.includes(p)) {
          error(step, where, 'platforms[]', `属于 [${PLATFORMS.join(', ')}]`, JSON.stringify(p));
        }
      }
    }

    if (!Array.isArray(e.permissions)) {
      error(step, where, 'permissions', '数组（可为空）', JSON.stringify(e.permissions));
    } else {
      for (const p of e.permissions) {
        if (!PERMISSIONS.includes(p)) {
          error(step, where, 'permissions[]', `属于 9 项权威枚举 [${PERMISSIONS.join(', ')}]`, JSON.stringify(p));
        }
      }
      // permissions_derived 是 CI 派生值，必须与 permissions 严格一致（2.3.6 四）。
      const expectedDerived = derivePermissions(e.permissions);
      const actualDerived = e.permissions_derived;
      if (actualDerived === null || typeof actualDerived !== 'object') {
        error(step, where, 'permissions_derived', '对象（三布尔派生摘要）', JSON.stringify(actualDerived));
      } else {
        for (const key of ['network', 'spawn_process', 'write_outside_module_dir']) {
          if (actualDerived[key] !== expectedDerived[key]) {
            error(
              step,
              where,
              `permissions_derived.${key}`,
              String(expectedDerived[key]),
              `${JSON.stringify(actualDerived[key])}；派生值由 permissions 唯一决定，人工填写会被 CI 拒绝（2.3.6 四）`,
            );
          }
        }
      }
    }
  }
  ok(step, '已校验 api_version / published_at / platforms / permissions 与派生摘要一致性');
}

function stepLicense(entries) {
  const step = 'step12-license';
  // 常见 SPDX 标识 + proprietary（2.8.2 第 12 步 / 3.4）。
  const allowed = new Set([
    'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MPL-2.0',
    'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later',
    'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
    'AGPL-3.0-only', 'AGPL-3.0-or-later', 'Unlicense', 'CC0-1.0', 'CC-BY-4.0',
    'CC-BY-SA-4.0', 'Zlib', 'BSL-1.0', '0BSD', 'EPL-2.0', 'Artistic-2.0',
    'proprietary',
  ]);

  for (const item of entries) {
    const e = item.entry;
    const where = typeof e.id === 'string' ? e.id : item.sourcePath;

    if (typeof e.license !== 'string' || e.license.trim() === '') {
      error(step, where, 'license', '非空 SPDX 标识或 proprietary', JSON.stringify(e.license));
      continue;
    }
    if (!allowed.has(e.license)) {
      error(step, where, 'license', `属于允许集合（SPDX 常见标识 + proprietary）`, JSON.stringify(e.license));
    }
    // 2.3.5：proprietary 不得进入 stable。
    if (e.license === 'proprietary' && e.channel === 'stable') {
      error(
        step,
        where,
        'channel',
        'beta 或 dev',
        'stable；闭源条目不得进入默认通道（2.3.5 / 审核红线第 3 条）',
      );
    }
    if (!CHANNELS.includes(e.channel)) {
      error(step, where, 'channel', `属于 [${CHANNELS.join(', ')}]`, JSON.stringify(e.channel));
    }
    if (!STATUSES.includes(e.status)) {
      error(step, where, 'status', `属于 [${STATUSES.join(', ')}]`, JSON.stringify(e.status));
    }
  }
  ok(step, `已校验 ${entries.length} 条条目的许可证与通道合规性`);
}

function stepYankAndAssets(entries) {
  const step = 'step10-integrity';
  for (const item of entries) {
    const e = item.entry;
    const where = typeof e.id === 'string' ? e.id : item.sourcePath;

    // yanked 为 true 时 yank_reason 必填（2.3.2）。
    if (e.yanked === true) {
      if (typeof e.yank_reason !== 'string' || e.yank_reason.trim() === '') {
        error(step, where, 'yank_reason', '非空字符串（yanked 为 true 时必填）', JSON.stringify(e.yank_reason));
      }
    } else if (e.yanked === false) {
      if (e.yank_reason !== null && e.yank_reason !== undefined) {
        error(step, where, 'yank_reason', 'null（yanked 为 false 时）', JSON.stringify(e.yank_reason));
      }
    } else {
      error(step, where, 'yanked', 'boolean', JSON.stringify(e.yanked));
    }

    // icon.size <= 32768（2.3.2 / 2.1）。
    const icon = e.icon;
    if (icon === null || typeof icon !== 'object') {
      error(step, where, 'icon', '对象', JSON.stringify(icon));
    } else {
      if (typeof icon.size !== 'number' || !Number.isInteger(icon.size) || icon.size <= 0) {
        error(step, where, 'icon.size', '正整数', JSON.stringify(icon.size));
      } else if (icon.size > 32768) {
        error(step, where, 'icon.size', '<= 32768', `${icon.size}（${formatBytes(icon.size)}）`);
      }
      if (typeof icon.path === 'string' && !icon.path.startsWith('assets/icons/')) {
        error(step, where, 'icon.path', '位于 assets/icons/ 下', JSON.stringify(icon.path));
      }
      // 图标在仓库内时，离线复核 sha256 与 size（第 10 步的离线部分）。
      if (typeof icon.path === 'string') {
        const abs = join(REPO_ROOT, icon.path);
        if (!existsSync(abs)) {
          warn(step, where, `icon.path 指向的文件不存在：${icon.path}（若为本 PR 新增图标请确认已提交）`);
        } else {
          const actualSize = statSync(abs).size;
          const actualSha = sha256OfFile(abs);
          if (actualSize !== icon.size) {
            error(step, where, 'icon.size', String(actualSize), `${icon.size}（与 ${icon.path} 实际字节数不符）`);
          }
          if (actualSha !== icon.sha256) {
            error(step, where, 'icon.sha256', actualSha, `${icon.sha256}（与 ${icon.path} 实际摘要不符）`);
          }
        }
      }
    }

    // assets
    if (!Array.isArray(e.assets) || e.assets.length === 0) {
      error(step, where, 'assets', '非空数组', JSON.stringify(e.assets));
      continue;
    }
    const platforms = Array.isArray(e.platforms) ? e.platforms : [];
    const seenPlatforms = new Set();
    for (const [i, a] of e.assets.entries()) {
      const at = `${where}.assets[${i}]`;
      if (a === null || typeof a !== 'object') {
        error(step, where, `assets[${i}]`, '对象', JSON.stringify(a));
        continue;
      }
      if (!platforms.includes(a.platform)) {
        error(step, at, 'platform', `属于 platforms [${platforms.join(', ')}]`, JSON.stringify(a.platform));
      }
      if (seenPlatforms.has(a.platform)) {
        error(step, at, 'platform', '每个平台至多一条', `${a.platform} 重复`);
      }
      seenPlatforms.add(a.platform);

      if (typeof a.size !== 'number' || !Number.isInteger(a.size) || a.size <= 0) {
        error(step, at, 'size', '> 0 的整数', JSON.stringify(a.size));
      }
      if (typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256)) {
        error(step, at, 'sha256', '64 位小写十六进制', JSON.stringify(a.sha256));
      }
      if (typeof a.url !== 'string' || !/^https:\/\//.test(a.url)) {
        error(step, at, 'url', 'https 绝对地址', JSON.stringify(a.url));
      } else if (/\/latest\/download\//.test(a.url)) {
        // 审核红线第 6 条：可变地址除非 pin 死 sha256。
        if (typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256)) {
          error(step, at, 'url', '不可变下载地址', `${a.url}（.../latest/download/... 属可变地址，需提供 pin 死的 sha256）`);
        }
      }
      if (!Array.isArray(a.mirrors)) {
        error(step, at, 'mirrors', '数组（可为空）', JSON.stringify(a.mirrors));
      }
      // 每个已声明平台都必须有资产（2.3.6 三：Release 缺失某平台产物则提审失败）。
    }
    for (const p of platforms) {
      if (!seenPlatforms.has(p)) {
        error(step, where, 'assets', `覆盖全部 platforms，缺 ${p}`, `已覆盖 [${[...seenPlatforms].join(', ')}]`);
      }
    }
  }
  ok(step, `已校验 ${entries.length} 条条目的 yank 状态、图标与资产声明`);
}

// ---------------------------------------------------------------------------
// MCBE 输入对的一致性：生成前也必须验证，不能靠重建索引掩盖半份同步结果。
// ---------------------------------------------------------------------------

function stepMcbeConsistency() {
  const step = 'step10-mcbe-snapshot';
  const manifestAbs = join(REPO_ROOT, MCBE_MANIFEST_PATH);
  const metaPath = 'mcbe/meta.json';
  const metaAbs = join(REPO_ROOT, metaPath);
  const hasManifest = existsSync(manifestAbs);
  const hasMeta = existsSync(metaAbs);
  if (!hasManifest && !hasMeta) return;
  if (!hasManifest || !hasMeta) {
    error(step, 'mcbe/', '(文件)', 'manifest.json 与 meta.json 同时存在',
      `${hasManifest ? metaPath : MCBE_MANIFEST_PATH} 缺失`);
    return;
  }

  const manifest = readJsonFile(manifestAbs);
  const meta = readJsonFile(metaAbs);
  if (manifest === null || typeof manifest !== 'object' || meta === null || typeof meta !== 'object') return;

  const actualSha = sha256OfFile(manifestAbs);
  if (meta.manifest_sha256 !== actualSha) {
    error(step, metaPath, 'manifest_sha256', actualSha, String(meta.manifest_sha256));
  }
  if (meta.manifest_path !== MCBE_MANIFEST_PATH) {
    error(step, metaPath, 'manifest_path', MCBE_MANIFEST_PATH, String(meta.manifest_path));
  }
  for (const field of ['schema_version', 'generated_at', 'upstream']) {
    if (!isDeepStrictEqual(meta[field], manifest[field])) {
      error(step, metaPath, field, JSON.stringify(manifest[field]), JSON.stringify(meta[field]));
    }
  }
  for (const [channel, versions] of [['preview', manifest.preview_versions], ['release', manifest.release_versions]]) {
    if (Array.isArray(versions) && meta.counts?.[channel] !== versions.length) {
      error(step, metaPath, `counts.${channel}`, String(versions.length), String(meta.counts?.[channel]));
    }
  }
  ok(step, '已校验 MCBE 清单与同步元信息的摘要、上游、时间及条目数');
}

// ---------------------------------------------------------------------------
// 步骤：生成物内部一致性（分片大小、_index 与分片摘要吻合、index.json 锚点）
// ---------------------------------------------------------------------------

function stepGeneratedConsistency() {
  const step = 'step13-generated-consistency';

  for (const shard of listShardFiles()) {
    const size = statSync(shard.absPath).size;
    if (size > SHARD_MAX_BYTES) {
      error(
        step,
        shard.relativePath,
        'size',
        `<= ${SHARD_MAX_BYTES}`,
        `${size}；超出 256 KB 上限，请维护者调整 tools/lib/common.mjs 的字母范围表（2.3.4，不自动再切分）`,
      );
    }
  }

  const idxAbs = join(REPO_ROOT, 'modules/_index.json');
  const byIdAbs = join(REPO_ROOT, 'modules/by-id.json');
  const topIdxAbs = join(REPO_ROOT, 'index.json');

  if (existsSync(idxAbs)) {
    const doc = readJsonFile(idxAbs);
    if (doc.schema_version !== SCHEMA_VERSION) {
      error(step, 'modules/_index.json', 'schema_version', String(SCHEMA_VERSION), JSON.stringify(doc.schema_version));
    }
    if (Array.isArray(doc.shards)) {
      const sum = doc.shards.reduce((acc, s) => acc + (s.count ?? 0), 0);
      if (sum !== doc.total) {
        error(step, 'modules/_index.json', 'total', String(sum), `${doc.total}（与各分片 count 之和不符）`);
      }
      for (const s of doc.shards) {
        const abs = join(REPO_ROOT, s.path);
        if (!existsSync(abs)) {
          error(step, s.path, '(文件)', '存在', '在 _index.json 中被声明但文件不存在');
          continue;
        }
        const actualSha = sha256OfFile(abs);
        const actualSize = statSync(abs).size;
        if (actualSha !== s.sha256) {
          error(step, s.path, 'sha256', actualSha, `${s.sha256}（_index.json 中记录的值）`);
        }
        if (actualSize !== s.size) {
          error(step, s.path, 'size', String(actualSize), `${s.size}（_index.json 中记录的值）`);
        }
      }
    }
  }

  if (existsSync(topIdxAbs)) {
    const doc = readJsonFile(topIdxAbs);
    if (doc.schema_version !== SCHEMA_VERSION) {
      error(step, 'index.json', 'schema_version', String(SCHEMA_VERSION), JSON.stringify(doc.schema_version));
    }
    if (Array.isArray(doc.entries)) {
      const paths = new Set(doc.entries.map((e) => e.path));
      if (paths.has('index.json')) {
        error(step, 'index.json', 'entries[].path', '不含 index.json', 'index.json 不得自引用（2.2）');
      }
      for (const entry of doc.entries) {
        const abs = join(REPO_ROOT, entry.path);
        if (!existsSync(abs)) {
          error(step, entry.path, '(文件)', '存在', '在 index.json 中被声明但文件不存在');
          continue;
        }
        const actualSha = sha256OfFile(abs);
        if (actualSha !== entry.sha256) {
          error(step, entry.path, 'sha256', actualSha, `${entry.sha256}（index.json 中记录的值）`);
        }
        const actualSize = statSync(abs).size;
        if (actualSize !== entry.size) {
          error(step, entry.path, 'size', String(actualSize), `${entry.size}（index.json 中记录的值）`);
        }
      }
      for (const required of ['modules/_index.json', 'modules/by-id.json']) {
        if (!paths.has(required)) {
          error(step, 'index.json', 'entries[].path', `包含 ${required}`, '缺失');
        }
      }
      if (existsSync(join(REPO_ROOT, MCBE_MANIFEST_PATH)) && !paths.has(MCBE_MANIFEST_PATH)) {
        error(step, 'index.json', 'entries[].path', `包含 ${MCBE_MANIFEST_PATH}`, '文件存在但索引未声明');
      }
    }

    // index.json.sha256 防降级锚点（2.5 规则 2）。
    const shaAbs = join(REPO_ROOT, 'index.json.sha256');
    if (existsSync(shaAbs)) {
      const declared = readFileSync(shaAbs, 'utf8').trim();
      const actual = sha256OfFile(topIdxAbs);
      if (declared !== actual) {
        error(step, 'index.json.sha256', '摘要', actual, `${declared}（与 index.json 实际摘要不符）`);
      }
    } else {
      warn(step, 'index.json.sha256', '缺失（由 build-index.mjs 生成，CI 会补上）');
    }
  } else {
    warn(step, 'index.json', '尚未生成（由 build-index.mjs 产出，CI 会补上）');
  }

  // by-id.json 必须覆盖全部 approved 条目且指向正确分片。
  if (existsSync(byIdAbs)) {
    const byId = readJsonFile(byIdAbs);
    const { entries } = collectModuleEntries();
    const approved = entries.filter((i) => i.entry.status === 'approved');
    for (const item of approved) {
      const id = item.entry.id;
      const mapped = byId[id];
      if (mapped === undefined) {
        error(step, 'modules/by-id.json', id, '存在映射', '缺失');
      } else if (mapped !== `modules/${shardRangeForId(id)}.json`) {
        error(step, 'modules/by-id.json', id, `modules/${shardRangeForId(id)}.json`, String(mapped));
      }
    }
  }

  ok(step, '已校验分片体积、_index/by-id/index.json 摘要一致性与防降级锚点');
}

// ---------------------------------------------------------------------------
// 第 10 步（网络）：资产下载复核
// ---------------------------------------------------------------------------

const ASSET_TIMEOUT_MS = 60_000;

async function fetchToTemp(url, destPath) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASSET_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(destPath, buf);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

async function stepAssets(entries) {
  const step = 'step10-assets';
  const dir = join(tmpdir(), `cgl-assets-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  let checked = 0;

  try {
    for (const item of entries) {
      const e = item.entry;
      if (e.status !== 'approved') continue;
      const where = typeof e.id === 'string' ? e.id : item.sourcePath;
      for (const [i, a] of (e.assets ?? []).entries()) {
        if (typeof a?.url !== 'string') continue;
        const at = `${where}.assets[${i}]`;
        const dest = join(dir, `${i}-${createHash('sha1').update(a.url).digest('hex')}.bin`);
        try {
          const buf = await fetchToTemp(a.url, dest);
          const actualSha = sha256Hex(buf);
          if (actualSha !== a.sha256) {
            error(step, at, 'sha256', actualSha, `${a.sha256}（下载自 ${a.url}）`);
          }
          if (buf.byteLength !== a.size) {
            error(step, at, 'size', String(buf.byteLength), `${a.size}`);
          }
          checked += 1;
        } catch (err) {
          const reason = err.name === 'AbortError' ? `超时（> ${ASSET_TIMEOUT_MS / 1000}s）` : err.message;
          error(step, at, 'url', '可下载', `${a.url} 下载失败：${reason}`);
        } finally {
          rmSync(dest, { force: true });
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  ok(step, `已下载并复核 ${checked} 个资产`);
}

async function stepLinks(entries) {
  const step = 'step11-links';
  const urls = new Set();
  for (const item of entries) {
    for (const a of item.entry.assets ?? []) {
      if (typeof a?.url === 'string') urls.add(a.url);
      for (const m of a?.mirrors ?? []) if (typeof m === 'string') urls.add(m);
    }
  }

  let reachable = 0;
  let failed = 0;
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      let res = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
      // 部分 CDN 不支持 HEAD，退回 GET 但只读响应头。
      if (res.status === 405 || res.status === 501) {
        res = await fetch(url, { method: 'GET', signal: controller.signal, redirect: 'follow' });
      }
      if (res.ok) {
        reachable += 1;
      } else {
        // 2.8.2 第 11 步：部分不可达输出 warning 不阻断。
        warn(step, url, `HTTP ${res.status}`);
        failed += 1;
      }
    } catch (err) {
      warn(step, url, `不可达：${err.name === 'AbortError' ? '超时' : err.message}`);
      failed += 1;
    } finally {
      clearTimeout(timer);
    }
  }
  ok(step, `链接探测完成：${reachable} 可达 / ${failed} 不可达（不可达为 warning，按 2.8.2 第 11 步不阻断）`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));

try {
  if (opts.generatedGuard) stepGeneratedGuard();
  if (opts.schema) stepSchema(opts);

  // 守卫可独立运行：合法输入变更尚未生成索引时，不应因旧摘要失败。
  // 显式组合 --schema / --assets / --links 时仍执行完整元数据校验。
  if (opts.schema || opts.assets || opts.links) {
    const entries = collectEntries();
    stepIdUnique(entries);
    stepNamespaceUnique(entries);
    stepNamingAndShard(entries);
    stepSemver(entries);
    stepCompat(entries);
    stepLicense(entries);
    stepYankAndAssets(entries);
    stepMcbeConsistency();
    if (!opts.sourceOnly) stepGeneratedConsistency();

    if (opts.assets) await stepAssets(entries);
    if (opts.links) await stepLinks(entries);
  }
} catch (err) {
  if (err instanceof SchemaUnsupportedError) {
    error('step4-schema', 'schema', '(关键字)', '受支持', err.message);
  } else {
    process.stderr.write(`[validate] 环境错误: ${err.stack ?? err.message}\n`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

const failed = problems.length > 0 || (opts.strict && warnings.length > 0);

if (opts.json) {
  process.stdout.write(
    `${JSON.stringify({ ok: !failed, errors: problems, warnings, passed }, null, 2)}\n`,
  );
} else {
  process.stdout.write(`[validate] cgl-libs CI 校验（模式：${describeMode(opts)}）\n`);
  for (const p of passed) process.stdout.write(`[validate] 通过 ${p.step}: ${p.detail}\n`);
  renderProblems(problems, '[validate] 错误（结构化摘要）');
  renderProblems(warnings, '[validate] 警告');
  process.stdout.write(
    `\n[validate] 结论: ${failed ? '失败' : '通过'}；错误 ${problems.length} 项，警告 ${warnings.length} 项\n`,
  );
}

process.exit(failed ? 1 : 0);

function describeMode(o) {
  const parts = [];
  if (o.schema) parts.push('schema');
  if (o.generatedGuard) parts.push('generated-guard');
  if (o.sourceOnly) parts.push('source-only');
  if (o.assets) parts.push('assets');
  if (o.links) parts.push('links');
  if (o.strict) parts.push('strict');
  return parts.join(' + ') || 'none';
}
