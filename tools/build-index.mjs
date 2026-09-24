// build-index.mjs —— 生成 index.json / modules/_index.json / modules/by-id.json / index.json.sha256
//
// 契约依据 docs/cgl-libs.md 2.3.3、2.3.4、2.8.4、1.8。
//
// 用法：
//   node tools/build-index.mjs                   正常生成并写盘
//   node tools/build-index.mjs --check           重新生成后与仓库内已有生成物比对，不一致则退出码 1
//   node tools/build-index.mjs --frozen-time <RFC3339>
//                                                指定 generated_at，用于本地复现与调试
//   node tools/build-index.mjs --commit <sha>    指定 repo_commit（默认取 GITHUB_SHA 或本地 git）
//
// ---------------------------------------------------------------------------
// 确定性说明（对应 1.8「索引里记录的分片 sha256 与分片内容必须由同一次 CI 运行产出」）
// ---------------------------------------------------------------------------
// 核心事实：生成物之间存在**哈希依赖链**，而链上的下层文件自己带 generated_at：
//
//   index.json.sha256  ->  index.json  ->  entries[].sha256
//                                            |
//                                            +--> modules/_index.json（含 generated_at）
//                                            +--> modules/by-id.json
//                                            +--> modules/<range>.json（各分片，含 generated_at）
//                                            +--> mcbe/manifest.json（含 generated_at）
//
// 因此"重新生成一份新时间戳的文档再和磁盘比对"这种做法**必然失败**：只要下层的
// generated_at 变一秒，它的 sha256 就变，嵌在 index.json 里的那串哈希跟着变，
// index.json.sha256 也变。仅剔除"文档自己"的 generated_at 挡不住这种传递——
// 时间的影响是以**哈希**形式绕过结构比较的。
//
// 所以 --check 的语义定为：**校验仓库里现有生成物是否自洽**，而不是"再生成一份
// 新时间戳的产物"。具体做法是：--check 时把本次运行的生成时刻**锚定到磁盘上
// index.json 的 generated_at**（而不是当前时间），于是整条链与磁盘状态同源：
//
//   - 若内容确实没变，重建结果与磁盘逐字节一致（含所有派生哈希）-> 通过；
//   - 若内容变了、或有人手工改了生成物，某个哈希就对不上 -> 失败并指出位置。
//
// 这与 1.8 的本意一致：CI 要保证"索引记录的摘要"与"分片内容"出自同一次运行，
// 而不是要求不同时刻运行产出相同字节。
//
// 配套规则：
//   1. --frozen-time 显式指定时间（本地复现用），优先级高于上述锚定。
//   2. 结构比对仍会剔除生成时刻字段本身，作为第二道保险。
//   3. repo_commit 的处理见下面第 3 条（未 pin 时不参与结构比对）。
//   4. 整个脚本**不访问网络**：索引层 urls 是纯字符串模板拼接（2.8.4），
//      mcbe/manifest.json 缺失时跳过该 entry 而不报错。

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import {
  REPO_ROOT,
  SCHEMA_VERSION,
  MIN_LAUNCHER,
  GENERATED_FILES,
  VOLATILE_TIME_FIELDS,
  SHARD_MAX_BYTES,
  MCBE_MANIFEST_PATH,
  serializeJson,
  serializeJsonBuffer,
  sha256Hex,
  sha256OfFile,
  compareByBytes,
  formatBytes,
  nowRfc3339,
  isRfc3339,
  listShardFiles,
  collectModuleEntries,
  groupApprovedEntries,
  shardPathForRange,
  shardRangeForId,
  rangeForShardPath,
  isGeneratedShardFile,
  buildIndexEntry,
  repoRelative,
  buildMirrorUrls,
} from './lib/common.mjs';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { check: false, frozenTime: null, commit: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--frozen-time') opts.frozenTime = argv[++i] ?? null;
    else if (arg.startsWith('--frozen-time=')) opts.frozenTime = arg.slice('--frozen-time='.length);
    else if (arg === '--commit') opts.commit = argv[++i] ?? null;
    else if (arg.startsWith('--commit=')) opts.commit = arg.slice('--commit='.length);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      fail(`未知参数 "${arg}"。用 --help 查看用法。`);
    }
  }
  if (opts.frozenTime !== null && !isRfc3339(opts.frozenTime)) {
    fail(`--frozen-time 必须是 RFC3339 UTC 时间（示例 2026-09-14T03:12:40Z），实际为 ${JSON.stringify(opts.frozenTime)}`);
  }
  if (opts.commit !== null && !/^[0-9a-f]{7,40}$/.test(opts.commit)) {
    fail(`--commit 必须是 7~40 位小写十六进制 sha，实际为 ${JSON.stringify(opts.commit)}`);
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`build-index.mjs - 生成 cgl-libs 索引与分片

用法:
  node tools/build-index.mjs [选项]

选项:
  --check                重新生成并与仓库内已有生成物比对，不一致退出码为 1
  --frozen-time <RFC3339> 覆盖 generated_at（确定性复现）
  --commit <sha>         覆盖 repo_commit（默认 GITHUB_SHA -> git rev-parse HEAD）
  --json                 以 JSON 输出机器可读结果
  -h, --help             显示本帮助

生成物:
  ${GENERATED_FILES.filter((f) => f !== 'index.json.minisig').join('\n  ')}
  （index.json.minisig 由 tools/sign.mjs 生成，不在本脚本职责内）
`);
}

function fail(message) {
  process.stderr.write(`[build-index] 失败: ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// repo_commit 解析
// ---------------------------------------------------------------------------

function resolveCommit(explicit) {
  if (explicit) return { value: explicit, source: '--commit' };
  if (process.env.GITHUB_SHA && /^[0-9a-f]{7,40}$/.test(process.env.GITHUB_SHA)) {
    return { value: process.env.GITHUB_SHA, source: 'GITHUB_SHA' };
  }
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^[0-9a-f]{7,40}$/.test(out)) return { value: out, source: 'git rev-parse HEAD' };
  } catch {
    // 无 git 或无提交历史：属于合法情形（空仓库首次生成），继续走兜底。
  }
  // 兜底值必须明显区别于真实 sha，避免被误当作可信溯源信息。
  return { value: '0000000000000000000000000000000000000000', source: 'fallback(no git, no GITHUB_SHA)' };
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

/**
 * 执行一次完整生成，返回内存中的全部生成物（不碰磁盘）。
 *
 * 返回值：
 *   {
 *     files: Map<relativePath, { buffer, doc, allowShardRewrite }>,
 *     plan:  { total, shards: [...], commit, generatedAt, commitSource, notes: [...] },
 *   }
 */
function buildArtifacts({ commit, commitSource, generatedAt, strictShardSize }) {
  const notes = [];
  const files = new Map();

  const { entries, errors } = collectModuleEntries();

  // ---------------------------------------------------------------------------
  // 幂等性处理（关键设计点）
  // ---------------------------------------------------------------------------
  // 2.8.4 说"扫描 modules/*.json"，但 build-index **自己写出的分片也在 modules/ 下**。
  // 若不加区分，第二次运行会把上一次的产物当成新的输入来源，导致条目被重复计入
  // （实测：4 条会被读成 8 条）。这正是 1.8 要求"同一次 CI 运行产出、不允许人工改动"
  // 所指向的脆弱点。
  //
  // 判据：一个分片文件若"恰好像是本工具的产物"，即
  //   - 顶层键集合与生成格式完全一致，且
  //   - range 字段等于文件名，且
  //   - 内部每条 approved 条目的 id 首字符确实落在该 range 内
  // 就认定为生成物：它的内容是对已有条目的**重新归位**，而不是新条目来源。
  //
  // 归属正确的生成物可以安全跳过（其内容必然已由源分片提供）；归属错误或含异类条目的
  // 文件则会被当作源分片处理——这与 2.3.4"分片归属由 CI 校验"一致，validate.mjs 会
  // 对放错位置的分片报错。
  // ---------------------------------------------------------------------------
  // 逐个源文件做归属判定，而不是逐条判定：分片是文件级概念。
  const generatedShards = new Set(); // relativePath 集合
  const sourceEntries = [];
  for (const item of entries) {
    if (generatedShards.has(item.sourcePath)) continue;
    if (isGeneratedShardFile(item.sourcePath)) {
      generatedShards.add(item.sourcePath);
      continue;
    }
    sourceEntries.push(item);
  }

  if (errors.length > 0) {
    fail(`modules/ 下存在无法解析的分片文件，先修好再生成：\n  - ${errors.join('\n  - ')}`);
  }

  const totalOnDisk = sourceEntries.length;
  const approved = sourceEntries.filter((e) => e.entry.status === 'approved');
  const skipped = totalOnDisk - approved.length;
  if (skipped > 0) {
    notes.push(`跳过 ${skipped} 条非 approved 条目（仅 approved 会进 index.json，见 2.3.2/2.8.4）`);
  }

  const groups = groupApprovedEntries(sourceEntries);

  // 1) 各分片。只写有 approved 条目的分片；空分片不落盘（避免产生恒为空的文件）。
  const shards = [];
  const shardPathsToKeep = new Set();
  for (const range of [...groups.keys()].sort(compareByBytes)) {
    const modules = groups.get(range);
    const doc = {
      schema_version: SCHEMA_VERSION,
      generated_at: generatedAt,
      range,
      modules,
    };
    const buffer = serializeJsonBuffer(doc);
    const relativePath = shardPathForRange(range);
    shardPathsToKeep.add(relativePath);

    if (buffer.byteLength > SHARD_MAX_BYTES) {
      // 2.3.4：不自动再切分。自动切分会改变 range 语义，导致客户端缓存失效、URL 不稳定。
      const message =
        `分片 ${relativePath} 体积 ${formatBytes(buffer.byteLength)} 超过上限 ${formatBytes(SHARD_MAX_BYTES)}（2.3.4 / 1.8）。\n` +
        '  本脚本不会自动再切分：自动切分会改变 range 语义，导致客户端缓存失效与 URL 不稳定。\n' +
        '  请维护者人工调整 tools/lib/common.mjs 的 SHARD_RANGES 字母范围表（例如把 s-u 拆成 s-t / u），\n' +
        '  随 PR 落地后本步骤会重新生成全部受影响分片的 path 与 sha256。';
      if (strictShardSize) {
        fail(message);
      }
      notes.push('[警告] 体积超限但当前为 --check 模式，仅报告不失败');
      process.stderr.write(`[build-index] 分片超限: ${message}\n`);
      shards.push({ range, path: relativePath, count: modules.length, size: buffer.byteLength, sha256: sha256Hex(buffer), oversize: true });
      files.set(relativePath, { buffer, doc, kind: 'module_shard' });
      continue;
    }

    shards.push({ range, path: relativePath, count: modules.length, size: buffer.byteLength, sha256: sha256Hex(buffer) });
    files.set(relativePath, { buffer, doc, kind: 'module_shard' });
  }

  // 2) modules/_index.json
  const moduleIndexDoc = {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    total: shards.reduce((sum, s) => sum + s.count, 0),
    shards: shards.map(({ range, path, count, size, sha256 }) => ({ range, path, count, size, sha256 })),
  };
  const moduleIndexBuffer = serializeJsonBuffer(moduleIndexDoc);
  files.set('modules/_index.json', { buffer: moduleIndexBuffer, doc: moduleIndexDoc, kind: 'module_index' });

  // 3) modules/by-id.json —— 扁平映射 { schema_version, "<id>": "<shard-path>" }
  const byIdDoc = { schema_version: SCHEMA_VERSION };
  for (const shard of shards) {
    for (const entry of groups.get(shard.range)) byIdDoc[entry.id] = shard.path;
  }
  const byIdBuffer = serializeJsonBuffer(byIdDoc);
  files.set('modules/by-id.json', { buffer: byIdBuffer, doc: byIdDoc, kind: 'module_by_id' });

  // 4) index.json
  const indexEntries = [
    buildIndexEntry({
      kind: 'module_index',
      path: 'modules/_index.json',
      sha256: sha256Hex(moduleIndexBuffer),
      size: moduleIndexBuffer.byteLength,
      commit,
    }),
    buildIndexEntry({
      kind: 'module_by_id',
      path: 'modules/by-id.json',
      sha256: sha256Hex(byIdBuffer),
      size: byIdBuffer.byteLength,
      commit,
    }),
  ];
  for (const shard of shards) {
    indexEntries.push(
      buildIndexEntry({
        kind: 'module_shard',
        path: shard.path,
        sha256: shard.sha256,
        size: shard.size,
        commit,
      }),
    );
  }

  const mcbeAbs = join(REPO_ROOT, MCBE_MANIFEST_PATH);
  if (existsSync(mcbeAbs)) {
    const buffer = readFileSync(mcbeAbs);
    indexEntries.push(
      buildIndexEntry({
        kind: 'mcbe_manifest',
        path: MCBE_MANIFEST_PATH,
        sha256: sha256Hex(buffer),
        size: buffer.byteLength,
        commit,
      }),
    );
  } else {
    // 任务与 2.4.4 都允许 mcbe/ 尚未就绪；这里刻意不写占位文件，
    // 保证索引只声明真实存在的资源。
    notes.push(`未发现 ${MCBE_MANIFEST_PATH}，本次索引不含 mcbe_manifest 条目`);
  }

  const indexDoc = {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    repo_commit: commit,
    min_launcher: MIN_LAUNCHER,
    entries: indexEntries,
  };
  const indexBuffer = serializeJsonBuffer(indexDoc);
  files.set('index.json', { buffer: indexBuffer, doc: indexDoc, kind: 'index' });

  // 5) index.json.sha256 —— 仅摘要十六进制 + 换行（self-describing 的 "<hash>  <name>" 形式
  //    留给需要 sha256sum -c 的场景；这里客户端只做字符串比对，故格式从简且固定）。
  const indexSha = sha256Hex(indexBuffer);
  files.set('index.json.sha256', {
    buffer: Buffer.from(`${indexSha}\n`, 'utf8'),
    doc: null,
    kind: 'checksum',
  });

  return {
    files,
    plan: {
      commit,
      commitSource,
      generatedAt,
      total: totalOnDisk,
      approvedCount: approved.length,
      shards: shards.map(({ range, path, count, size, sha256 }) => ({ range, path, count, size, sha256 })),
      shardPaths: [...shardPathsToKeep].sort(compareByBytes),
      hasMcbe: existsSync(mcbeAbs),
      indexSha256: indexSha,
      notes,
    },
  };
}

// ---------------------------------------------------------------------------
// 比对辅助（确定性核心）
// ---------------------------------------------------------------------------

/**
 * 递归剔除易变时间字段后深拷贝，用于结构比对。
 * 只剔除 VOLATILE_TIME_FIELDS 中显式列出的键，其余字段一律参与比较。
 */
function stripVolatile(value, extraKeys = new Set()) {
  if (Array.isArray(value)) return value.map((v) => stripVolatile(v, extraKeys));
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (VOLATILE_TIME_FIELDS.has(k) || extraKeys.has(k)) continue;
    out[k] = stripVolatile(v, extraKeys);
  }
  return out;
}

/** 收集文档中所有 generated_at 值，供诊断输出使用。 */
function collectGeneratedAt(value, out = []) {
  if (Array.isArray(value)) {
    for (const v of value) collectGeneratedAt(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'generated_at') out.push(v);
      else collectGeneratedAt(v, out);
    }
  }
  return out;
}

function stableStringify(value) {
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
const commitInfo = resolveCommit(opts.commit);

/**
 * 决定本次重建使用的 generated_at。
 *
 * 优先级（见文件头"确定性说明"）：
 *   1. --frozen-time <t>           显式覆盖，本地复现用
 *   2. --check 模式：磁盘 index.json 的 generated_at
 *      —— 让整条哈希依赖链与磁盘状态同源。CI 里磁盘上的生成物是若干分钟/天前产出的，
 *         若这里用当前时间，_index.json 的 sha256 会变，进而污染 index.json 与
 *         index.json.sha256，导致每一个 PR 都必然误报失败。
 *   3. 其它情况：当前 UTC 时间（写入模式的正常行为）
 */
function resolveGeneratedAt() {
  if (opts.frozenTime !== null) {
    return { value: opts.frozenTime, source: '--frozen-time' };
  }
  if (opts.check) {
    const idxAbs = join(REPO_ROOT, 'index.json');
    if (existsSync(idxAbs)) {
      try {
        const doc = JSON.parse(readFileSync(idxAbs, 'utf8'));
        if (typeof doc.generated_at === 'string' && isRfc3339(doc.generated_at)) {
          return { value: doc.generated_at, source: '磁盘 index.json 的 generated_at' };
        }
        // 磁盘上的时间字段非法：不静默回退到当前时间（那会掩盖问题），
        // 而是在下面 --check 的守卫里被明确报出来。这里先用当前时间继续，
        // 保证后续比对仍能发现"时间字段损坏"。
        process.stderr.write(
          `[build-index] 警告: 磁盘 index.json 的 generated_at 非法（${JSON.stringify(doc.generated_at)}），` +
            '本次以当前时间为基准；该问题会由 --check 的时间守卫报出。\n',
        );
      } catch {
        process.stderr.write('[build-index] 警告: 磁盘 index.json 无法解析，暂以当前时间为基准。\n');
      }
    }
    return { value: nowRfc3339(), source: '当前时间（磁盘 index.json 缺失或不可用）' };
  }
  return { value: nowRfc3339(), source: '当前 UTC 时间' };
}

const generatedAtInfo = resolveGeneratedAt();
const generatedAt = generatedAtInfo.value;

const { files, plan } = buildArtifacts({
  commit: commitInfo.value,
  commitSource: commitInfo.source,
  generatedAt,
  // --check 下不因分片超限直接退出：CI 会先跑一次普通生成（strictShardSize=true）来阻断，
  // --check 的职责是报告漂移。但这里仍会打印醒目警告。
  strictShardSize: !opts.check,
});

const report = {
  mode: opts.check ? 'check' : 'write',
  commit: plan.commit,
  commit_source: plan.commitSource,
  generated_at: plan.generatedAt,
  generated_at_source: generatedAtInfo.source,
  modules_total: plan.total,
  modules_approved: plan.approvedCount,
  shards: plan.shards,
  mcbe_manifest_included: plan.hasMcbe,
  index_sha256: plan.indexSha256,
  notes: plan.notes,
};

if (!opts.check) {
  // 写盘模式：清理"本次不再产出、但确实是自己旧产物"的分片，避免幽灵分片残留。
  // 关键约束：只删 isOwnGeneratedShardFile 认定为产物的文件。维护者手写的源分片一律
  // 不动——哪怕它当前没有 approved 条目，也可能含着待审核的 pending 条目，
  // 静默删除等于丢数据。
  const expected = new Set(plan.shardPaths);
  for (const shard of listShardFiles()) {
    if (expected.has(shard.relativePath)) continue;
    if (!isGeneratedShardFile(shard.relativePath)) continue;
    rmSync(shard.absPath);
    process.stdout.write(`[build-index] 移除不再产出的旧分片 ${shard.relativePath}\n`);
  }

  for (const [relativePath, artifact] of files) {
    const abs = join(REPO_ROOT, relativePath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, artifact.buffer);
  }
  writeFileSync(join(REPO_ROOT, 'index.json.sha256'), files.get('index.json.sha256').buffer);
}

// --check 比对
let checkFailures = [];
if (opts.check) {
  const commitIsPinned = opts.commit !== null;
  const extraIgnored = commitIsPinned ? new Set() : new Set(['repo_commit']);

  for (const relativePath of [...files.keys()].sort(compareByBytes)) {
    const artifact = files.get(relativePath);
    const abs = join(REPO_ROOT, relativePath);
    if (!existsSync(abs)) {
      checkFailures.push(`${relativePath}: 仓库内缺少该生成物（应存在但未找到）`);
      continue;
    }
    const onDiskBuffer = readFileSync(abs);
    if (artifact.kind === 'checksum') {
      const expected = artifact.buffer.toString('utf8').trim();
      const actual = onDiskBuffer.toString('utf8').trim();
      if (expected !== actual) {
        checkFailures.push(`${relativePath}: 摘要不一致。期望 ${expected}，实际 ${actual}`);
      }
      continue;
    }

    let onDiskDoc;
    try {
      onDiskDoc = JSON.parse(onDiskBuffer.toString('utf8'));
    } catch (err) {
      checkFailures.push(`${relativePath}: 不是合法 JSON（${err.message}）`);
      continue;
    }

    // (a) 结构比对：剔除易变时间字段（+ 未 pin commit 时的 repo_commit）后深比较。
    const rebuilt = stripVolatile(artifact.doc, extraIgnored);
    const disk = stripVolatile(onDiskDoc, extraIgnored);
    const rebuiltText = stableStringify(rebuilt);
    const diskText = stableStringify(disk);
    if (rebuiltText !== diskText) {
      const diff = firstDifference(rebuiltText, diskText);
      checkFailures.push(`${relativePath}: 内容与重新生成的结果不一致（${diff}）`);
      continue;
    }

    // (b) 时间守卫。注意 modules/by-id.json 依 2.3.3 **没有** generated_at 字段（它是纯映射），
    //     所以判据是"重建结果里有 generated_at 的文档，磁盘上也必须有且可解析"，而不是
    //     "每个生成物都必须有"。
    //     这里刻意**不**做"磁盘时间不得晚于本次运行时间"的检查：CI runner 与开发机的时钟
    //     本就不同源，且当 --frozen-time 指向过去时会立刻误报。generated_at 被篡改的风险由
    //     第 (a) 步覆盖（除该字段外任何改动都会导致结构比对失败），而防篡改的权威手段是
    //     index.json.minisig 签名（2.5）。
    if (rebuilt !== null && typeof rebuilt === 'object' && !Array.isArray(rebuilt)
        && Object.prototype.hasOwnProperty.call(rebuilt, 'generated_at')) {
      if (!Object.prototype.hasOwnProperty.call(onDiskDoc, 'generated_at')) {
        checkFailures.push(`${relativePath}: 缺少 generated_at 字段`);
        continue;
      }
      if (!isRfc3339(onDiskDoc.generated_at)) {
        checkFailures.push(
          `${relativePath}: generated_at 不是合法 RFC3339 时间（${JSON.stringify(onDiskDoc.generated_at)}）`,
        );
        continue;
      }
    }

    // (c) 写入顺序守卫：磁盘上的键顺序必须与重新生成的一致（逐字节比对会因时间字段不等而失败，
    //     故这里对"剔除时间字段后的键路径序列"做单独比对）。
    const keyPathsRebuilt = keyPathSequence(rebuilt);
    const keyPathsDisk = keyPathSequence(disk);
    if (keyPathsRebuilt !== keyPathsDisk) {
      checkFailures.push(`${relativePath}: JSON 键顺序与生成结果不一致（1.8 要求键顺序固定）`);
    }
  }

  // --check 还要发现"幽灵生成物"：长得像本工具产物、但本次并不产出的分片文件。
  //
  // 注意不能把"含 approved 条目的源分片"当成错误：源分片本来就是输入，build-index 会
  // 把它们按 id 重新归位到正确的 range，这正是 2.3.4 的分配职责。误报会让 CI 永远红。
  // 真正该报的是"上次生成的、这次不该存在的产物"（例如某 range 的条目被全部移除后
  // 残留的文件），其判据就是 isOwnGeneratedShardFile。
  const expectedShards = new Set(plan.shardPaths);
  for (const shard of listShardFiles()) {
    if (expectedShards.has(shard.relativePath)) continue;
    if (!isGeneratedShardFile(shard.relativePath)) continue;
    checkFailures.push(
      `${shard.relativePath}: 是本工具的旧产物但本次不应产出（该 range 下已无 approved 条目）。` +
        '移除该文件后重新运行 build-index（见 2.3.4：range 归属由 build-index 决定）。',
    );
  }

  // 即使结构一致，也要报告 --assets 之外的一致性守卫：磁盘上的 repo_commit 合法性。
  const diskIndexAbs = join(REPO_ROOT, 'index.json');
  if (existsSync(diskIndexAbs)) {
    try {
      const original = JSON.parse(readFileSync(diskIndexAbs, 'utf8'));
      if (commitIsPinned && original.repo_commit !== opts.commit) {
        checkFailures.push(
          `index.json: repo_commit 应为 ${opts.commit}（--commit 已指定），实际 ${original.repo_commit}`,
        );
      }
      if (!/^[0-9a-f]{7,40}$/.test(String(original.repo_commit ?? ''))) {
        checkFailures.push(`index.json: repo_commit 不是合法 sha（${JSON.stringify(original.repo_commit)}）`);
      }
      // index.json.sha256 必须与磁盘上的 index.json 逐字节一致（防降级锚点，2.5 规则 2）。
      const shaFile = join(REPO_ROOT, 'index.json.sha256');
      if (existsSync(shaFile)) {
        const declared = readFileSync(shaFile, 'utf8').trim();
        const actual = sha256OfFile(diskIndexAbs);
        if (declared !== actual) {
          checkFailures.push(`index.json.sha256: 与磁盘上的 index.json 不匹配。期望 ${actual}，实际 ${declared}`);
        }
      }
    } catch (err) {
      checkFailures.push(`index.json: 无法解析（${err.message}）`);
    }
  }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

if (opts.json) {
  process.stdout.write(
    `${JSON.stringify({ ...report, check_failures: checkFailures }, null, 2)}\n`,
  );
} else {
  process.stdout.write(`[build-index] 模式: ${report.mode}\n`);
  process.stdout.write(`[build-index] repo_commit: ${report.commit} (来源: ${report.commit_source})\n`);
  process.stdout.write(`[build-index] generated_at: ${report.generated_at} (来源: ${report.generated_at_source})\n`);
  process.stdout.write(`[build-index] 模块条目: ${report.modules_approved} 条 approved / 共 ${report.modules_total} 条\n`);
  if (report.shards.length === 0) {
    process.stdout.write('[build-index] 分片: 0 个（modules/ 下没有 approved 条目，这是空仓库的合法状态）\n');
  }
  for (const shard of report.shards) {
    process.stdout.write(
      `[build-index] 分片 ${shard.path} (range ${shard.range}): ${shard.count} 条, ${shard.size} bytes, sha256=${shard.sha256}\n`,
    );
  }
  process.stdout.write(
    `[build-index] mcbe_manifest 条目: ${report.mcbe_manifest_included ? '已包含' : '未包含（mcbe/manifest.json 不存在）'}\n`,
  );
  process.stdout.write(`[build-index] index.json sha256: ${report.index_sha256}\n`);
  for (const note of report.notes) process.stdout.write(`[build-index] 提示: ${note}\n`);
  if (opts.check) {
    if (checkFailures.length === 0) {
      process.stdout.write('[build-index] --check 通过：生成物与重新生成的结果一致（已按确定性规则忽略 generated_at）\n');
    } else {
      process.stdout.write(`[build-index] --check 失败，共 ${checkFailures.length} 项：\n`);
      for (const f of checkFailures) process.stdout.write(`  - ${f}\n`);
    }
  }
}

process.exit(opts.check && checkFailures.length > 0 ? 1 : 0);

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 给出两个多行文本首个不同的行号与片段，方便定位差异。 */
function firstDifference(a, b) {  const la = a.split('\n');
  const lb = b.split('\n');
  const max = Math.max(la.length, lb.length);
  for (let i = 0; i < max; i += 1) {
    if (la[i] !== lb[i]) {
      return `第 ${i + 1} 行，期望 ${JSON.stringify(la[i] ?? '<缺少>')}，实际 ${JSON.stringify(lb[i] ?? '<缺少>')}`;
    }
  }
  return '差异在换行或尾随字符';
}

/** 把 JSON 值展开成"键路径序列"，用于校验键顺序（值不参与）。 */
function keyPathSequence(value, prefix = '') {
  if (Array.isArray(value)) {
    return value.map((v, i) => keyPathSequence(v, `${prefix}[${i}]`)).join('|');
  }
  if (value === null || typeof value !== 'object') return prefix;
  return Object.keys(value)
    .map((k) => keyPathSequence(value[k], prefix ? `${prefix}.${k}` : k))
    .join('|');
}
