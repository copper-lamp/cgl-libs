// sync-mcbe.mjs —— 从上游版本库同步 MCBE 版本元数据快照
//
// 契约依据 docs/cgl-libs.md 2.4（尤其是 2.4.1 索引式统一入口、2.4.3 结构、1.4 时效要求）。
//
// 用法：
//   node tools/sync-mcbe.mjs                联网抓取上游并写入 mcbe/manifest.json + mcbe/meta.json
//   node tools/sync-mcbe.mjs --check        只抓取并比对，不写盘；有变化则退出码 1
//   node tools/sync-mcbe.mjs --input <file> 用本地文件替代网络抓取（离线复现与测试）
//   node tools/sync-mcbe.mjs --upstream-commit <sha>
//                                           显式指定上游 commit（--input 模式常用）
//
// ---------------------------------------------------------------------------
// 设计要点
// ---------------------------------------------------------------------------
// 1. 依 2.4.1，本仓库**不镜像**上游内容、**不取代**三镜像。这里存的是"结构化快照
//    + sha256 完整性锚点"，让客户端在上游或镜像不可用时仍能拿到可验证的版本列表。
// 2. 依 2.4.2 第 4 点，上游只提供 md5，而 md5 不适合对抗性场景。本脚本对上游
//    historical_versions.json 的**原始字节**计算 sha256 写入 upstream.raw_sha256，
//    把清单从"尽力而为"升级为"可验证"。md5 原值保留在条目里供客户端沿用旧逻辑，
//    但不作为安全边界。
// 3. 抓取按镜像顺序重试，失败即切换下一个；sources 字段记录**本次实际尝试的顺序**
//    （2.4.3 要求"快照该次抓取的实际顺序"）。
// 4. 网络不可用时明确失败，不写半成品。--input 提供离线通路，便于 CI 之外的复现。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { REPO_ROOT, SCHEMA_VERSION, nowRfc3339, serializeJson, sha256Hex } from './lib/common.mjs';

const MCBE_DIR = 'mcbe';
const MANIFEST_PATH = 'mcbe/manifest.json';
const META_PATH = 'mcbe/meta.json';
const UPSTREAM_REPO = 'LiteLDev/minecraft-windows-gdk-version-db';
const UPSTREAM_FILE = 'historical_versions.json';

/**
 * 上游抓取镜像，按可达性排序（依 2.4.1：三镜像为传输通道）。
 * 顺序与 cgl-libs 索引层策略一致：jsdelivr 优先（国内可达性好），gh-proxy 次之，raw 兜底。
 */
const UPSTREAM_SOURCES = [
  `https://fastly.jsdelivr.net/gh/${UPSTREAM_REPO}@main/${UPSTREAM_FILE}`,
  `https://gh-proxy.com/https://raw.githubusercontent.com/${UPSTREAM_REPO}/refs/heads/main/${UPSTREAM_FILE}`,
  `https://raw.githubusercontent.com/${UPSTREAM_REPO}/refs/heads/main/${UPSTREAM_FILE}`,
];

const FETCH_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { check: false, input: null, upstreamCommit: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--input') opts.input = argv[++i] ?? null;
    else if (arg.startsWith('--input=')) opts.input = arg.slice('--input='.length);
    else if (arg === '--upstream-commit') opts.upstreamCommit = argv[++i] ?? null;
    else if (arg.startsWith('--upstream-commit=')) opts.upstreamCommit = arg.slice('--upstream-commit='.length);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      fail(`未知参数 "${arg}"，用 --help 查看用法。`, 2);
    }
  }
  if (opts.upstreamCommit !== null && !/^[0-9a-f]{40}$/.test(opts.upstreamCommit)) {
    fail(`--upstream-commit 必须是 40 位小写十六进制 sha，实际 ${JSON.stringify(opts.upstreamCommit)}`, 2);
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`sync-mcbe.mjs - 同步 MCBE 版本元数据

用法:
  node tools/sync-mcbe.mjs [选项]

选项:
  --check                      只比对不写盘，有变化退出码 1
  --input <file>               用本地文件替代网络抓取（离线复现）
  --upstream-commit <sha>      显式指定上游 commit（40 位十六进制）
  --json                       以 JSON 输出结果
  -h, --help                   显示本帮助

产出:
  ${MANIFEST_PATH}   结构化快照（2.4.3）
  ${META_PATH}       同步元信息 + manifest 的 sha256 锚点
`);
}

function fail(message, code = 1) {
  process.stderr.write(`[sync-mcbe] 失败: ${message}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// 抓取
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** 按镜像顺序抓取上游清单，返回原始字节与本次实际使用的地址顺序。 */
async function fetchUpstreamRaw() {
  const attempted = [];
  const failures = [];
  for (const url of UPSTREAM_SOURCES) {
    attempted.push(url);
    try {
      const buf = await fetchWithTimeout(url);
      return { buffer: buf, sources: attempted.slice(), failures };
    } catch (err) {
      const reason = err.name === 'AbortError' ? `超时（> ${FETCH_TIMEOUT_MS / 1000}s）` : err.message;
      failures.push(`${url} -> ${reason}`);
    }
  }
  fail(
    `全部镜像均无法抓取上游 ${UPSTREAM_FILE}：\n  - ${failures.join('\n  - ')}\n` +
      '  MCBE 版本同步是每日定时任务（1.4）；本次失败不会写入任何半成品文件。\n' +
      '  如需离线复现，请用 --input <file> 指定本地清单。',
  );
  return null;
}

/**
 * 查询上游仓库 HEAD commit。
 *
 * 依 2.4.3，upstream.commit 是"同步时的上游 commit sha"。拿不到时**不猜**：
 * 宁可失败，也不写一个假 sha 破坏溯源链。--input 模式可显式传入。
 */
async function fetchUpstreamCommit() {
  const api = `https://api.github.com/repos/${UPSTREAM_REPO}/commits?per_page=1`;
  try {
    const buf = await fetchWithTimeout(api);
    const list = JSON.parse(buf.toString('utf8'));
    if (Array.isArray(list) && list[0]?.sha && /^[0-9a-f]{40}$/.test(list[0].sha)) {
      return list[0].sha;
    }
    throw new Error('响应中没有可用的 sha');
  } catch (err) {
    fail(
      `无法获取上游 commit（${err.message}）。\n` +
        '  upstream.commit 是 2.4.3 的必填字段且用于溯源，本脚本不会用占位值填充。\n' +
        '  请在 CI 中授予 GITHUB_TOKEN，或用 --input 配合 --upstream-commit 指定。',
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// 转换
// ---------------------------------------------------------------------------

/** 校验并规范化单条上游版本条目。字段依 2.4.3：version / urls / timestamp / md5。 */
function normalizeEntry(raw, where) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${where} 不是对象：${JSON.stringify(raw)}`);
  }
  if (typeof raw.version !== 'string' || raw.version.trim() === '') {
    fail(`${where} 缺少 version 字段`);
  }
  if (!Array.isArray(raw.urls) || raw.urls.length === 0) {
    fail(`${where}（${raw.version}）缺少 urls 数组`);
  }
  for (const u of raw.urls) {
    if (typeof u !== 'string') {
      fail(`${where}（${raw.version}）的 urls 中存在非字符串项：${JSON.stringify(u)}`);
    }
    // 上游对微软自家 CDN（assets1.xboxlive.com / .cn）的下载地址使用 http（下载阶段
    // 走 Store 认证/签名逻辑），这些是合法地址；其余地址必须是 https，避免任意明文下载。
    const isMicrosoftCdn = /^http:\/\/[a-z0-9-]+\.xboxlive\.(com|cn)\//.test(u);
    if (!isMicrosoftCdn && !/^https:\/\//.test(u)) {
      fail(`${where}（${raw.version}）的 urls 中存在非合法下载地址：${JSON.stringify(u)}`);
    }
  }
  if (!Number.isInteger(raw.timestamp) || raw.timestamp < 0) {
    fail(`${where}（${raw.version}）的 timestamp 必须是非负整数，实际 ${JSON.stringify(raw.timestamp)}`);
  }
  if (typeof raw.md5 !== 'string' || !/^[0-9a-fA-F]{32}$/.test(raw.md5)) {
    fail(`${where}（${raw.version}）的 md5 不是 32 位十六进制：${JSON.stringify(raw.md5)}`);
  }

  // 依 2.4.3：urls 中 .xboxlive.cn 在前；同时保持其余地址的原有相对顺序。
  const sortedUrls = [...raw.urls].sort((a, b) => {
    const ax = a.includes('.xboxlive.cn') ? 0 : 1;
    const bx = b.includes('.xboxlive.cn') ? 0 : 1;
    return ax - bx;
  });

  return {
    version: raw.version,
    urls: sortedUrls,
    timestamp: raw.timestamp,
    md5: raw.md5.toLowerCase(),
  };
}

/**
 * 解析上游清单。
 *
 * 依 2.4.3：顶层键为 file_version，条目为 {version, urls, timestamp, md5}，
 * 且分 preview / release 两组。上游的键名兼容多种写法（preview_versions /
 * previewVersion / preview），以免上游改名就直接中断同步。
 */
function parseUpstream(buffer) {
  // 上游或本地 --input 文件可能带 UTF-8 BOM（Windows 工具常见）。
  // 依 1.8 的"失败而不是静默漂移"精神，这里不是忽略解析错误，而是先剥掉 BOM 再解析；
  // 真正的语法错误仍然照常失败。
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    fail(`上游 ${UPSTREAM_FILE} 不是合法 JSON：${err.message}`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    fail('上游清单顶层必须是对象。');
  }

  const fileVersion = doc.file_version ?? doc.fileVersion;
  if (!Number.isInteger(fileVersion)) {
    fail(
      `上游清单缺少整数型 file_version（实际 ${JSON.stringify(fileVersion)}）。` +
        '该字段用于判断上游 schema 变更，缺失时无法安全同步。',
    );
  }

  const pick = (...keys) => {
    for (const k of keys) {
      if (Array.isArray(doc[k])) return doc[k];
    }
    return null;
  };

  const previewRaw = pick('preview_versions', 'previewVersions', 'previewVersion', 'preview');
  const releaseRaw = pick('release_versions', 'releaseVersions', 'releaseVersion', 'release');

  if (previewRaw === null && releaseRaw === null) {
    fail(
      `上游清单中找不到版本数组。已知顶层键：${Object.keys(doc).join(', ')}。\n` +
        '  上游 schema 可能已变更，需人工确认后再放行同步（2.4.3 的 file_version 即为此设计）。',
    );
  }

  const preview = (previewRaw ?? []).map((e, i) => normalizeEntry(e, `preview_versions[${i}]`));
  const release = (releaseRaw ?? []).map((e, i) => normalizeEntry(e, `release_versions[${i}]`));

  return { fileVersion, preview, release };
}

// ---------------------------------------------------------------------------
// 组装产物
// ---------------------------------------------------------------------------

function buildArtifacts({ rawBuffer, sources, upstreamCommit, fileVersion, preview, release, generatedAt }) {
  const manifest = {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    upstream: {
      repo: UPSTREAM_REPO,
      commit: upstreamCommit,
      raw_sha256: sha256Hex(rawBuffer),
      sources,
      file_version: fileVersion,
    },
    preview_versions: preview,
    release_versions: release,
  };

  const manifestText = serializeJson(manifest);
  const manifestSha = createHash('sha256').update(Buffer.from(manifestText, 'utf8')).digest('hex');

  const meta = {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    upstream: manifest.upstream,
    counts: { preview: preview.length, release: release.length },
    manifest_path: MANIFEST_PATH,
    manifest_sha256: manifestSha,
  };

  return { manifest, manifestText, meta, metaText: serializeJson(meta) };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
const generatedAt = nowRfc3339();

let rawBuffer;
let sources;
let upstreamCommit;

if (opts.input) {
  if (!existsSync(opts.input)) fail(`--input 指定的文件不存在：${opts.input}`, 2);
  rawBuffer = readFileSync(opts.input);
  sources = [`file://${opts.input}`];
  upstreamCommit = opts.upstreamCommit;
  if (!upstreamCommit) {
    fail(
      '使用了 --input 但未提供 --upstream-commit。upstream.commit 是 2.4.3 的必填字段，' +
        '本脚本不会用占位 sha 填充（那会破坏溯源链）。',
      2,
    );
  }
} else {
  const fetched = await fetchUpstreamRaw();
  rawBuffer = fetched.buffer;
  sources = fetched.sources;
  upstreamCommit = opts.upstreamCommit ?? (await fetchUpstreamCommit());
}

const { fileVersion, preview, release } = parseUpstream(rawBuffer);
const artifacts = buildArtifacts({
  rawBuffer,
  sources,
  upstreamCommit,
  fileVersion,
  preview,
  release,
  generatedAt,
});

// --check：与仓库内已有文件比对，忽略 generated_at（该字段每次都不同）。
if (opts.check) {
  const changes = [];
  for (const [file, text] of [
    [MANIFEST_PATH, artifacts.manifestText],
    [META_PATH, artifacts.metaText],
  ]) {
    const abs = join(REPO_ROOT, file);
    if (!existsSync(abs)) {
      changes.push(`${file}: 不存在`);
      continue;
    }
    const onDisk = JSON.parse(readFileSync(abs, 'utf8'));
    const rebuilt = JSON.parse(text);
    delete onDisk.generated_at;
    delete rebuilt.generated_at;
    if (JSON.stringify(onDisk) !== JSON.stringify(rebuilt)) {
      changes.push(`${file}: 内容与重新同步的结果不一致`);
    }
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ changed: changes.length > 0, changes, counts: artifacts.meta.counts }, null, 2)}\n`);
  } else if (changes.length === 0) {
    process.stdout.write(
      `[sync-mcbe] --check 通过：快照与上游一致（preview ${artifacts.meta.counts.preview} / release ${artifacts.meta.counts.release}）\n`,
    );
  } else {
    process.stdout.write(`[sync-mcbe] --check 发现 ${changes.length} 项差异：\n`);
    for (const c of changes) process.stdout.write(`  - ${c}\n`);
  }
  process.exit(changes.length > 0 ? 1 : 0);
}

mkdirSync(join(REPO_ROOT, MCBE_DIR), { recursive: true });
writeFileSync(join(REPO_ROOT, MANIFEST_PATH), artifacts.manifestText);
writeFileSync(join(REPO_ROOT, META_PATH), artifacts.metaText);

const result = {
  ok: true,
  upstream_repo: UPSTREAM_REPO,
  upstream_commit: upstreamCommit,
  upstream_raw_sha256: artifacts.manifest.upstream.raw_sha256,
  file_version: fileVersion,
  counts: artifacts.meta.counts,
  manifest_path: MANIFEST_PATH,
  manifest_sha256: artifacts.meta.manifest_sha256,
  sources,
};

if (opts.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(`[sync-mcbe] 已写入 ${MANIFEST_PATH} 与 ${META_PATH}\n`);
  process.stdout.write(`[sync-mcbe] 上游 commit: ${upstreamCommit}\n`);
  process.stdout.write(`[sync-mcbe] 上游原始字节 sha256: ${result.upstream_raw_sha256}\n`);
  process.stdout.write(`[sync-mcbe] file_version: ${fileVersion}\n`);
  process.stdout.write(`[sync-mcbe] 条目数: preview ${result.counts.preview} / release ${result.counts.release}\n`);
  process.stdout.write(`[sync-mcbe] manifest sha256: ${result.manifest_sha256}\n`);
}
