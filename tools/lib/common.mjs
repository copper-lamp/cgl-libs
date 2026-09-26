// cgl-libs 工具链共享库。
//
// 契约依据 docs/cgl-libs.md：2.1 目录树、2.3.3 分片清单、2.3.4 分片切分规则、
// 2.8.2 CI 校验、2.8.4 合并后自动生成索引、1.8 一致性要求。
//
// 约束：
// - 只使用 Node 内置模块，禁止任何 npm 运行时依赖（2.1 tools 说明）。
// - 本文件不做任何网络访问；确定性生成所需的全部输入都来自工作区与命令行。

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// ---------------------------------------------------------------------------
// 仓库常量
// ---------------------------------------------------------------------------

/** 元数据契约版本。客户端只做大小比较，见 2.1 / 3.1。 */
export const SCHEMA_VERSION = 1;

/** index.json 声明的服务该索引所需的最低启动器版本，见 2.2。 */
export const MIN_LAUNCHER = '0.1.0';

/** 索引层镜像模板使用的 GitHub 仓库坐标，见 2.8.4 第 3 步。 */
export const REPO_SLUG = 'copper-lamp/cgl-libs';

/** 索引层镜像固定使用的分支名，见 2.6：索引层不走用户在设置里配置的第三方镜像。 */
export const REPO_BRANCH = 'main';

/** 单分片字节上限 256 KB，见 1.8 / 2.3.4。超出必须由 CI 失败，不自动再切分。 */
export const SHARD_MAX_BYTES = 262144;

/** 生成物清单，与文档 2.2 / 2.3.3 / 2.8.2 第 3 步一致。 */
export const GENERATED_FILES = [
  'index.json',
  'index.json.sha256',
  'index.json.minisig',
  'modules/_index.json',
  'modules/by-id.json',
];

/** build-index.mjs 自身负责写出的文件（不含由 sign.mjs 产出的 minisig）。 */
export const BUILD_INDEX_OUTPUTS = [
  'index.json',
  'index.json.sha256',
  'modules/_index.json',
  'modules/by-id.json',
];

/** 确定性比对时需要忽略的"生成时刻"字段，理由见 build-index.mjs 头部注释。 */
export const VOLATILE_TIME_FIELDS = new Set(['generated_at']);

export const SHARD_FILE_INDEX = 'modules/_index.json';
export const SHARD_FILE_BY_ID = 'modules/by-id.json';
export const MCBE_MANIFEST_PATH = 'mcbe/manifest.json';

/** kind -> cache_ttl_sec，照 2.2 示例：分片与索引 3600s，MCBE 清单 21600s。 */
export const CACHE_TTL_SEC = {
  module_index: 3600,
  module_by_id: 3600,
  module_shard: 3600,
  mcbe_manifest: 21600,
};

/**
 * 字母范围表，来自 2.1 目录树与 2.3.4。
 * 修改此表是仓库级决策，必须人工确认后随 PR 落地（2.3.4）。
 */
export const SHARD_RANGES = [
  { range: '0-9', test: (ch) => ch >= '0' && ch <= '9' },
  { range: 'a-b', test: (ch) => ch >= 'a' && ch <= 'b' },
  { range: 'c-d', test: (ch) => ch >= 'c' && ch <= 'd' },
  { range: 'e-g', test: (ch) => ch >= 'e' && ch <= 'g' },
  { range: 'h-l', test: (ch) => ch >= 'h' && ch <= 'l' },
  { range: 'm-o', test: (ch) => ch >= 'm' && ch <= 'o' },
  { range: 'p-r', test: (ch) => ch >= 'p' && ch <= 'r' },
  { range: 's-u', test: (ch) => ch >= 's' && ch <= 'u' },
  { range: 'v-z', test: (ch) => ch >= 'v' && ch <= 'z' },
  { range: '_other', test: () => true },
];

/** 模块 id 的两段式规范，2.3.2。 */
export const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;

/** i18n_namespace 规范：单段、无点号，2.3.2。 */
export const I18N_NAMESPACE_PATTERN = /^[a-z][a-z0-9-]{2,31}$/;

/** 权威平台枚举，2.3.6 三。 */
export const PLATFORMS = [
  'windows-x86_64',
  'windows-aarch64',
  'android-arm64',
  'linux-x86_64',
];

/** 权威权限枚举，共 9 项，2.3.6 四。 */
export const PERMISSIONS = [
  'filesystem:read',
  'filesystem:write',
  'filesystem:game-dir',
  'network',
  'process:spawn',
  'download:enqueue',
  'settings:write',
  'intents:request',
  'account:read',
];

/** 通道枚举，2.3.2。 */
export const CHANNELS = ['stable', 'beta', 'dev'];

/** 审核状态枚举，2.3.2。 */
export const STATUSES = ['approved', 'pending', 'rejected'];

/** 仓库当前支持的 api_version 集合，2.8.2 第 9 步。 */
export const SUPPORTED_API_VERSIONS = new Set([1, 2]);

// ---------------------------------------------------------------------------
// 路径与 JSON 读写
// ---------------------------------------------------------------------------

/** 仓库根目录 = 本文件所在目录的上一级的上一级（tools/lib/ -> 仓库根）。 */
export const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** 把平台路径规范化为以 / 分隔的相对路径（报告与 JSON 内一律使用）。 */
export function toPosix(p) {
  return p.split(sep).join('/');
}

/** 相对仓库根的 POSIX 风格路径。 */
export function repoRelative(absPath) {
  return toPosix(relative(REPO_ROOT, absPath));
}

export function readJson(absPath) {
  return JSON.parse(readFileSync(absPath, 'utf8'));
}

/** 读取 JSON，失败时抛出带文件名的明确错误。 */
export function readJsonFile(absPath) {
  let text;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch (err) {
    throw new Error(`无法读取 ${repoRelative(absPath)}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${repoRelative(absPath)} 不是合法 JSON: ${err.message}`);
  }
}

/**
 * 确定性序列化：2 空格缩进 + 末尾换行，键顺序沿用对象插入顺序。
 *
 * 之所以不用 JSON.stringify(obj, null, 2) 后手写换行：Node 的 JSON.stringify
 * 已保证按插入顺序输出、不排序，且不产生尾随空格，正是 1.8 要求的"键顺序与缩进固定"。
 */
export function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** 按序列化规则编码为 Buffer，供写盘与 sha256 计算共用，避免两处规则漂移。 */
export function serializeJsonBuffer(value) {
  return Buffer.from(serializeJson(value), 'utf8');
}

// ---------------------------------------------------------------------------
// 摘要与字节
// ---------------------------------------------------------------------------

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha256OfFile(absPath) {
  return sha256Hex(readFileSync(absPath));
}

/** 确定性比较器：按 UTF-8 字节序（id 规范限定了字符集，等价于字典序且与 locale 无关）。 */
export function compareByBytes(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function formatBytes(n) {
  return `${n} bytes (${(n / 1024).toFixed(2)} KB)`;
}

/** 当前 UTC 时间，RFC3339 秒精度（与 2.2 示例的格式一致）。 */
export function nowRfc3339(date = new Date()) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** 校验 RFC3339 date-time，纯本地实现（不依赖 Date 的宽松解析）。 */
export function isRfc3339(value) {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return false;
  const [, y, mo, d, h, mi, s] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 60) return false;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return false;
  // 交叉验证：Date.parse 可能把 2026-02-30 规范化成 3 月，故回读 UTC 分量。
  const round = new Date(t);
  const offsetMin = m[7] === 'Z' ? 0 : (m[7][0] === '-' ? -1 : 1) * (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(4, 6)));
  const asUtc = new Date(round.getTime() + offsetMin * 60000);
  return asUtc.getUTCFullYear() === Number(y) && asUtc.getUTCMonth() + 1 === month && asUtc.getUTCDate() === day;
}

// ---------------------------------------------------------------------------
// 分片归属（2.3.4）
// ---------------------------------------------------------------------------

/**
 * 取 id 的首字符所属分片范围标识。
 *
 * 键取 id 的首字符：id 已保证全局唯一，是分片的稳定键；两条首字符相同的条目必然同片。
 * 首字符 ∈ [0-9] -> 0-9；∈ [a-z] -> 七段字母范围；其余（CJK 等）-> _other（防御性保留）。
 */
export function shardRangeForId(id) {
  const ch = String(id).charAt(0);
  for (const entry of SHARD_RANGES) {
    if (entry.test(ch)) return entry.range;
  }
  return '_other';
}

/** 范围标识 -> 仓库内相对路径。 */
export function shardPathForRange(range) {
  return `modules/${range}.json`;
}

/** 仓库内相对路径 -> 范围标识；非分片路径返回 null。 */
export function rangeForShardPath(path) {
  const m = /^modules\/([^/]+)\.json$/.exec(path);
  if (!m) return null;
  if (m[1] === '_index' || m[1] === 'by-id') return null;
  return m[1];
}

/** 判断 id 的首字符是否落在给定 range 内。 */
export function idMatchesRange(id, range) {
  return shardRangeForId(id) === range;
}

// ---------------------------------------------------------------------------
// semver（严格子集，2.8.2 第 8/9 步）
// ---------------------------------------------------------------------------

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * 解析严格 semver。
 *
 * 返回 { major, minor, patch, prerelease: string[], build: string[] } 或 null。
 * 严格含义：不允许前导 v、不允许多余前导零、必须三段（与 2.3.2 "必须严格 semver" 一致）。
 */
export function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const m = SEMVER_PATTERN.exec(value);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
    build: m[5] ? m[5].split('.') : [],
  };
}

export function isValidSemver(value) {
  return parseSemver(value) !== null;
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // 有预发布标识者优先级更低
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    if (xNum !== yNum) return xNum ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length === 0 ? 0 : a.length < b.length ? -1 : 1;
}

/** semver 比较（忽略 build metadata，符合 semver 2.0.0 第 10 条）。非法输入返回 null。 */
export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  return comparePrerelease(x.prerelease, y.prerelease);
}

// ---------------------------------------------------------------------------
// 权限派生（2.3.6 四，唯一映射规则）
// ---------------------------------------------------------------------------

export function derivePermissions(permissions) {
  const set = new Set(Array.isArray(permissions) ? permissions : []);
  return {
    network: set.has('network'),
    spawn_process: set.has('process:spawn'),
    write_outside_module_dir: set.has('filesystem:game-dir') || set.has('settings:write'),
  };
}

// ---------------------------------------------------------------------------
// index.json 镜像模板（2.8.4 第 3 步 / 2.6）
// ---------------------------------------------------------------------------

/**
 * 生成索引层镜像地址列表。
 *
 * jsdelivr 使用固定 commit sha 而非 @main，利用其不可变缓存；另两个固定走 main 以保证最新。
 * 索引层不得混入用户在设置里配置的第三方镜像（2.6）。
 */
export function buildMirrorUrls(commit, path) {
  const c = commit || REPO_BRANCH;
  return [
    `https://cdn.jsdelivr.net/gh/${REPO_SLUG}@${c}/${path}`,
    `https://gh-proxy.com/https://raw.githubusercontent.com/${REPO_SLUG}/refs/heads/${REPO_BRANCH}/${path}`,
    `https://raw.githubusercontent.com/${REPO_SLUG}/refs/heads/${REPO_BRANCH}/${path}`,
  ];
}

export function buildIndexEntry({ kind, path, sha256, size, commit }) {
  return {
    kind,
    path,
    sha256,
    size,
    cache_ttl_sec: CACHE_TTL_SEC[kind],
    urls: buildMirrorUrls(commit, path),
  };
}

// ---------------------------------------------------------------------------
// 模块分片扫描
// ---------------------------------------------------------------------------

const SHARD_FILE_EXCLUDES = new Set(['_index.json', 'by-id.json']);

/**
 * 扫描 modules/*.json 分片文件（排除 _index.json 与 by-id.json 两个生成物）。
 *
 * 返回 [{ name, range, absPath, relativePath, exists }]；range 为文件名去扩展名。
 * 目录不存在时返回空数组，不抛错（空仓库必须能跑通，见 2.8.4 与任务要求）。
 */
export function listShardFiles() {
  const dir = join(REPO_ROOT, 'modules');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .filter((name) => !SHARD_FILE_EXCLUDES.has(name))
    .sort(compareByBytes)
    .map((name) => {
      const range = name.slice(0, -'.json'.length);
      return {
        name,
        range,
        absPath: join(dir, name),
        relativePath: `modules/${name}`,
      };
    });
}

/**
 * 收集全仓库模块条目。
 *
 * 返回 { entries: Array<{ entry, shardRange, shardPath, sourcePath }>, errors: string[] }。
 * 只做结构性收集，不做字段级语义校验（那是 validate.mjs 的职责）。
 */
export function collectModuleEntries() {
  const entries = [];
  const errors = [];
  const shardFiles = listShardFiles();

  for (const shard of shardFiles) {
    let doc;
    try {
      doc = readJsonFile(shard.absPath);
    } catch (err) {
      errors.push(err.message);
      continue;
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      errors.push(`${shard.relativePath} 顶层必须是 JSON 对象`);
      continue;
    }
    if (!Array.isArray(doc.modules)) {
      errors.push(`${shard.relativePath} 缺少 modules 数组`);
      continue;
    }
    for (const entry of doc.modules) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`${shard.relativePath} 的 modules[] 中存在非对象元素`);
        continue;
      }
      const range = typeof entry.id === 'string' ? shardRangeForId(entry.id) : null;
      entries.push({
        entry,
        shardRange: range,
        shardPath: range ? shardPathForRange(range) : null,
        sourcePath: shard.relativePath,
        declaredRange: shard.range,
      });
    }
  }

  return { entries, errors, shardFiles };
}

/** 按 id 分组为"应生成的分片 -> 条目数组"，只保留 approved。 */
export function groupApprovedEntries(entries) {
  const groups = new Map();
  for (const item of entries) {
    if (item.entry.status !== 'approved') continue;
    const id = item.entry.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const range = shardRangeForId(id);
    if (!groups.has(range)) groups.set(range, []);
    groups.get(range).push(item.entry);
  }
  for (const [, list] of groups) {
    list.sort((a, b) => compareByBytes(a.id, b.id));
  }
  return groups;
}

/**
 * 判断 modules/<name>.json 是否为生成工具自己的产物。
 *
 * 背景：build-index.mjs 的产物就写在 modules/ 下，而 2.8.4 又要求"扫描 modules/*.json"。
 * 若不加区分，第二次运行会把上一次的产物当成新的条目来源，导致条目被重复计入
 * （实测：4 条会被读成 8 条；validate 会误报 id 重复）。
 *
 * 判据（全部满足才算生成物）：
 *   1. 顶层键恰好是 { schema_version, generated_at, range, modules }；
 *   2. range 等于文件名去扩展名；
 *   3. 文件内所有条目的 id 首字符都落在该 range 内（归属正确）；
 *   4. 至少存在一条条目。
 *
 * 任何一条不满足都按"源分片"处理，从而让归属错误或含异类条目的文件继续参与校验，
 * 不会静默消失。
 */
export function isGeneratedShardFile(relativePath) {
  const range = rangeForShardPath(relativePath);
  if (range === null) return false;
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(REPO_ROOT, relativePath), 'utf8'));
  } catch {
    return false;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return false;

  const keys = Object.keys(doc).sort();
  const expectedKeys = ['generated_at', 'modules', 'range', 'schema_version'];
  if (keys.length !== expectedKeys.length || keys.some((k, i) => k !== expectedKeys[i])) return false;
  if (doc.range !== range) return false;
  if (!Array.isArray(doc.modules) || doc.modules.length === 0) return false;

  return doc.modules.every(
    (m) => m !== null && typeof m === 'object' && !Array.isArray(m)
      && typeof m.id === 'string' && shardRangeForId(m.id) === range,
  );
}
