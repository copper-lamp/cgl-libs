// sign.mjs —— 生成/校验 index.json 的 sha256 与 minisign (ed25519) 签名
//
// 契约依据 docs/cgl-libs.md 2.5 签名与完整性、2.8.4 第 4 步。
//
// 用法：
//   node tools/sign.mjs                        生成 index.json.sha256 与 index.json.minisig
//   node tools/sign.mjs --sha256-only          只生成/刷新 index.json.sha256
//   node tools/sign.mjs --verify               用公钥校验 index.json.minisig
//   node tools/sign.mjs --print-public-key     从私钥推导并打印公钥（用于首次配置 Secret）
//
// 密钥来源（两种都支持，按优先级）：
//   1. 环境变量 MINISIGN_SECRET_KEY：值是 base64（可直接是 minisign 密钥文件的两行 base64 部分）
//      或一段原始的 minisign 私钥文件内容（含 "untrusted comment:" 行），或一个文件路径。
//   2. --secret-key <path>：私钥文件路径。
//
// 公钥来源（--verify 用）：
//   1. --public-key <path>
//   2. 环境变量 MINISIGN_PUBLIC_KEY（内容、base64 或路径）
//   3. 默认 schema 同级约定路径 tools/minisign.pub（若存在）
//
// ---------------------------------------------------------------------------
// 关于 minisign 格式的真实实现说明
// ---------------------------------------------------------------------------
// minisign 的签名文件（.minisig）是 4 行文本：
//
//   untrusted comment: <任意说明文本>
//   <base64(签名结构，74 字节)>
//   trusted comment: <被签名的说明文本>
//   <base64(对 (签名结构 || trusted comment) 的 ed25519 签名，64 字节)>
//
// 其中"签名结构"74 字节的布局为（见 minisign 源码 public_key.c / signature.c）：
//   [0..1]   signature_algorithm，2 字节小端，'Ed' = 0x6445 表示纯 ed25519（预哈希为 'ED'）
//   [2..9]   key_id，8 字节小端，取公钥随机部分的低 8 字节
//   [10..73] ed25519 对 **消息本体** 的 64 字节签名
//
// 关键点：纯 ed25519 模式下（算法 'Ed'），签名对象是**文件原始字节**，不是哈希；
// 而 trusted comment 的签名对象是 (签名结构 || trusted comment 的 UTF-8 字节)。
// 本实现按此语义生成与校验，因此产物可被真正的 minisign 工具验证。
//
// 若系统安装了 minisign 可执行文件，则优先调用它（兼容性与信任度更高）；
// 否则回落到本文件内的 Node crypto 等价实现。两条路径产出的文件结构一致。
//
// 无密钥时**明确失败**，绝不生成假签名（否则会让客户端信任一个无效锚点）。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, sign as cryptoSign, verify as cryptoVerify, createPublicKey, createPrivateKey } from 'node:crypto';
import { join } from 'node:path';

import { REPO_ROOT } from './lib/common.mjs';

const INDEX_PATH = 'index.json';
const SIG_PATH = 'index.json.minisig';
const SHA_PATH = 'index.json.sha256';

/** minisign 的密钥 id 是公钥 32 字节随机部分的低 8 字节，小端读取。 */
const ALG_ED25519 = 0x6445; // 'Ed' 小端：纯 ed25519，签名对象是原始消息
const ALG_ED25519_PREHASHED = 0x4445; // 'ED' 小端：预哈希模式（本仓库不使用）

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { verify: false, sha256Only: false, printPublicKey: false, secretKey: null, publicKey: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--verify') opts.verify = true;
    else if (arg === '--sha256-only') opts.sha256Only = true;
    else if (arg === '--print-public-key') opts.printPublicKey = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--secret-key') opts.secretKey = argv[++i] ?? null;
    else if (arg.startsWith('--secret-key=')) opts.secretKey = arg.slice('--secret-key='.length);
    else if (arg === '--public-key') opts.publicKey = argv[++i] ?? null;
    else if (arg.startsWith('--public-key=')) opts.publicKey = arg.slice('--public-key='.length);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      fail(`未知参数 "${arg}"，用 --help 查看用法。`, 2);
    }
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`sign.mjs - 生成 index.json 的 sha256 与 minisign 签名

用法:
  node tools/sign.mjs                     生成 ${SHA_PATH} 与 ${SIG_PATH}
  node tools/sign.mjs --sha256-only       只生成 ${SHA_PATH}
  node tools/sign.mjs --verify            用公钥校验 ${SIG_PATH}
  node tools/sign.mjs --print-public-key  从私钥推导公钥（首次配置 Secret 时用）

选项:
  --secret-key <path>   minisign 私钥文件（也可用 env MINISIGN_SECRET_KEY）
  --public-key <path>   公钥文件（也可用 env MINISIGN_PUBLIC_KEY）
  --json                以 JSON 输出结果
  -h, --help            显示本帮助

退出码: 0 成功 / 1 签名或校验失败 / 2 用法或环境错误
`);
}

function fail(message, code = 1) {
  process.stderr.write(`[sign] 失败: ${message}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// 密钥解析
// ---------------------------------------------------------------------------

/**
 * 读取密钥文本。来源顺序：显式参数 -> 环境变量。
 * 环境变量的值可以是：文件路径、密钥文件全文、或单个 base64 串。
 */
function readKeySource(explicitPath, envName) {
  if (explicitPath) {
    if (!existsSync(explicitPath)) fail(`密钥文件不存在：${explicitPath}`, 2);
    return { text: readFileSync(explicitPath, 'utf8'), from: explicitPath };
  }
  const envVal = process.env[envName];
  if (!envVal || envVal.trim() === '') return null;

  const trimmed = envVal.trim();
  // 恰好是一个存在的文件路径
  if (!trimmed.includes('\n') && existsSync(trimmed)) {
    return { text: readFileSync(trimmed, 'utf8'), from: `env ${envName} (路径)` };
  }
  // 密钥文件全文（含 untrusted comment 行）
  if (trimmed.includes('comment:')) {
    return { text: trimmed, from: `env ${envName} (文件内容)` };
  }
  // 单个 base64 串：补回 minisign 文件应有的两行结构
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    return { text: `untrusted comment: minisign encrypted secret key\n${trimmed}\n`, from: `env ${envName} (base64)` };
  }
  fail(`环境变量 ${envName} 的内容无法识别为路径、密钥文件或 base64。`, 2);
  return null;
}

/** 从密钥文件文本里抽出最后一行非注释的 base64 负载。 */
function extractBase64Payload(text, label) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  const payloads = lines.filter((l) => !l.startsWith('untrusted comment:') && !l.startsWith('trusted comment:'));
  if (payloads.length === 0) fail(`${label} 中没有找到 base64 负载。`, 2);
  // minisign 密钥文件格式：第一行注释，第二行 base64。
  return payloads[payloads.length - 1];
}

/**
 * 解析 minisign 私钥。
 *
 * 私钥结构（104 字节，见 minisign 源码）：
 *   [0..1]   签名算法（小端）
 *   [2..9]   key_id（小端 8 字节）
 *   [10..41] ed25519 私钥种子（32 字节）
 *   [42..73] ed25519 公钥（32 字节）
 *   [74..103] 校验和（32 字节）
 *
 * 注意：minisign 的标准私钥文件默认是**加密**的（scrypt 保护，注释为
 * "minisign encrypted secret key"）。本脚本不实现 scrypt 解密——那会引入
 * 非内置密码学实现的风险。因此：
 *   - 若检测到未加密私钥，直接使用；
 *   - 若检测到加密私钥，明确报错并提示改用未加密私钥或系统 minisign。
 * 这是刻意的"失败而不是猜"。
 */
function parseSecretKey(base64Payload) {
  const raw = Buffer.from(base64Payload, 'base64');
  if (raw.length < 74) {
    fail(`私钥负载长度异常：${raw.length} 字节（至少需要 74）。请确认提供的是 minisign 私钥而非公钥。`, 2);
  }
  const algorithm = raw.readUInt16LE(0);
  const keyId = raw.readUInt32LE(2); // 低 4 字节
  const keyIdBytes = raw.subarray(2, 10);
  const secretSeed = raw.subarray(10, 42);
  const publicKey = raw.subarray(42, 74);

  if (algorithm !== ALG_ED25519 && algorithm !== ALG_ED25519_PREHASHED) {
    fail(
      `私钥算法标识 0x${algorithm.toString(16)} 不受支持（期望 0x${ALG_ED25519.toString(16)} = 'Ed'）。` +
        '若这是加密私钥，请用 minisign -G 重新生成未加密密钥，或改用系统 minisign。',
      2,
    );
  }
  if (algorithm === ALG_ED25519_PREHASHED) {
    fail(
      '检测到预哈希模式私钥（算法 ED）。本仓库按 2.5 使用纯 ed25519 模式以保持与客户端实现一致；' +
        '请使用 minisign 默认参数生成并导出的密钥。',
      2,
    );
  }

  // 用 Node 构造 ed25519 私钥：PKCS#8 包裹 32 字节种子。
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const privateKeyObject = createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, secretSeed]),
    format: 'der',
    type: 'pkcs8',
  });
  const derivedPublic = createPublicKey(privateKeyObject).export({ format: 'der', type: 'spki' }).subarray(-32);

  if (!derivedPublic.equals(publicKey)) {
    fail(
      '私钥中内嵌的公钥与由私钥种子推导出的公钥不一致，密钥文件可能损坏。' +
        `内嵌 ${publicKey.toString('hex').slice(0, 16)}...，推导 ${derivedPublic.toString('hex').slice(0, 16)}...`,
      2,
    );
  }

  return { privateKeyObject, publicKey, keyId, keyIdBytes };
}

/** 解析 minisign 公钥文件（2 行：注释 + base64）。 */
function parsePublicKey(base64Payload) {
  const raw = Buffer.from(base64Payload, 'base64');
  if (raw.length < 42) {
    fail(`公钥负载长度异常：${raw.length} 字节（应为 42）。请确认提供的是 minisign 公钥（.pub）。`, 2);
  }
  const algorithm = raw.readUInt16LE(0);
  if (algorithm !== ALG_ED25519) {
    fail(`公钥算法标识 0x${algorithm.toString(16)} 不受支持（期望 'Ed'）。`, 2);
  }
  const keyIdBytes = raw.subarray(2, 10);
  const publicKey = raw.subarray(10, 42);
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const publicKeyObject = createPublicKey({
    key: Buffer.concat([spkiPrefix, publicKey]),
    format: 'der',
    type: 'spki',
  });
  return { publicKeyObject, publicKey, keyId: keyIdBytes.readUInt32LE(0), keyIdBytes };
}

// ---------------------------------------------------------------------------
// minisign 签名文件构造与解析
// ---------------------------------------------------------------------------

/**
 * 构造 74 字节 minisign 签名结构。
 * 注意算法字段固定写明文 'Ed'（纯 ed25519，不预哈希）——与 2.5 的校验链一致。
 */
function buildSignatureStruct(signature64, keyIdBytes) {
  const buf = Buffer.alloc(74);
  buf.writeUInt16LE(ALG_ED25519, 0);
  keyIdBytes.copy(buf, 2, 0, 8);
  signature64.copy(buf, 10, 0, 64);
  return buf;
}

/** 把签名结构 + trusted comment 组装为 .minisig 文件内容。 */
function buildMinisigFile({ signatureStruct, trustedComment, globalSignature, untrustedComment }) {
  return [
    `untrusted comment: ${untrustedComment}`,
    signatureStruct.toString('base64'),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString('base64'),
    '',
  ].join('\n');
}

/** 解析 .minisig 文件。返回 null 表示格式不合法。 */
function parseMinisigFile(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length < 4) return null;
  const untrusted = /^untrusted comment: (.*)$/.exec(lines[0]);
  const sigB64 = lines[1].trim();
  const trusted = /^trusted comment: (.*)$/.exec(lines[2]);
  const globalB64 = lines[3].trim();
  if (!untrusted || !trusted || !sigB64 || !globalB64) return null;
  return {
    untrustedComment: untrusted[1],
    signatureStruct: Buffer.from(sigB64, 'base64'),
    trustedComment: trusted[1],
    globalSignature: Buffer.from(globalB64, 'base64'),
  };
}

// ---------------------------------------------------------------------------
// 签名 / 校验核心
// ---------------------------------------------------------------------------

/** 优先使用系统 minisign（若存在）。返回 null 表示环境无 minisign。 */
function findSystemMinisign() {
  for (const exe of ['minisign', 'minisign.exe']) {
    try {
      execFileSync(exe, ['-v'], { stdio: 'ignore' });
      return exe;
    } catch (err) {
      // 命令存在但返回非 0（-v 的常见行为）也算找到。
      if (err.code !== 'ENOENT') return exe;
    }
  }
  return null;
}

function signMessage(privateKeyObject, message) {
  // ed25519 是"纯"签名方案：crypto.sign 传入 null 算法即可，不做预哈希。
  return cryptoSign(null, message, privateKeyObject);
}

function verifyMessage(publicKeyObject, message, signature) {
  return cryptoVerify(null, message, publicKeyObject, signature);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
const indexPath = join(REPO_ROOT, INDEX_PATH);

if (!existsSync(indexPath)) {
  fail(`${INDEX_PATH} 不存在。请先运行 node tools/build-index.mjs 生成索引。`, 2);
}

const indexBytes = readFileSync(indexPath);
const indexSha = createHash('sha256').update(indexBytes).digest('hex');

// ---------------------------------------------------------------------------
// --verify
// ---------------------------------------------------------------------------

if (opts.verify) {
  const sigAbs = join(REPO_ROOT, SIG_PATH);
  if (!existsSync(sigAbs)) fail(`${SIG_PATH} 不存在，无法校验。`, 2);

  const keySource = readKeySource(opts.publicKey, 'MINISIGN_PUBLIC_KEY');
  if (!keySource) {
    fail(
      '未提供公钥。请用 --public-key <path> 或设置环境变量 MINISIGN_PUBLIC_KEY。' +
        '（若尚未生成密钥对，请先参照 2.5 与 3.6 建立 minisign 密钥。）',
      2,
    );
  }
  const publicKey = parsePublicKey(extractBase64Payload(keySource.text, `公钥（${keySource.from}）`));
  const parsed = parseMinisigFile(readFileSync(sigAbs, 'utf8'));
  if (!parsed) fail(`${SIG_PATH} 格式不合法（应为 untrusted comment / base64 / trusted comment / base64 四行）。`);

  // 1) 文件本体签名
  const messageSignature = parsed.signatureStruct.subarray(10, 74);
  const bodyOk = verifyMessage(publicKey.publicKeyObject, indexBytes, messageSignature);

  // 2) trusted comment 的全局签名：签名对象是 (签名结构 || trusted comment)
  const trustedBytes = Buffer.concat([parsed.signatureStruct, Buffer.from(parsed.trustedComment, 'utf8')]);
  const commentOk = verifyMessage(publicKey.publicKeyObject, trustedBytes, parsed.globalSignature);

  // 3) key_id 必须与公钥一致（防止拿错误密钥去验）
  const keyIdOk = parsed.signatureStruct.subarray(2, 10).equals(publicKey.keyIdBytes);

  // 4) sha256 锚点也必须一致
  const shaAbs = join(REPO_ROOT, SHA_PATH);
  let shaOk = null;
  if (existsSync(shaAbs)) {
    shaOk = readFileSync(shaAbs, 'utf8').trim() === indexSha;
  }

  const ok = bodyOk && commentOk && keyIdOk && shaOk !== false;

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok, body_signature: bodyOk, global_signature: commentOk, key_id: keyIdOk, sha256: shaOk, trusted_comment: parsed.trustedComment, index_sha256: indexSha }, null, 2)}\n`);
  } else {
    process.stdout.write(`[sign] 验签 ${INDEX_PATH}\n`);
    process.stdout.write(`[sign] 文件签名: ${bodyOk ? '通过' : '失败'}\n`);
    process.stdout.write(`[sign] trusted comment 全局签名: ${commentOk ? '通过' : '失败'}\n`);
    process.stdout.write(`[sign] key_id 与公钥匹配: ${keyIdOk ? '是' : '否'}\n`);
    process.stdout.write(`[sign] trusted comment: ${parsed.trustedComment}\n`);
    process.stdout.write(`[sign] index.json sha256: ${indexSha}\n`);
    process.stdout.write(`[sign] ${SHA_PATH} 锚点: ${shaOk === null ? '文件不存在（跳过）' : shaOk ? '一致' : '不一致'}\n`);
    process.stdout.write(`[sign] 结论: ${ok ? '验签通过' : '验签失败'}\n`);
  }
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// --print-public-key
// ---------------------------------------------------------------------------

if (opts.printPublicKey) {
  const keySource = readKeySource(opts.secretKey, 'MINISIGN_SECRET_KEY');
  if (!keySource) {
    fail('未提供私钥（--secret-key 或 env MINISIGN_SECRET_KEY），无法推导公钥。', 2);
  }
  const secret = parseSecretKey(extractBase64Payload(keySource.text, `私钥（${keySource.from}）`));
  const pubRaw = Buffer.concat([
    Buffer.from([ALG_ED25519 & 0xff, (ALG_ED25519 >> 8) & 0xff]),
    secret.keyIdBytes,
    secret.publicKey,
  ]);
  const content = `untrusted comment: minisign public key ${secret.keyId.toString(16).toUpperCase()}\n${pubRaw.toString('base64')}\n`;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ key_id: secret.keyId, public_key_base64: pubRaw.toString('base64'), file_content: content }, null, 2)}\n`);
  } else {
    process.stdout.write('[sign] 公钥（可写入启动器内嵌常量，见 2.5 规则 2）：\n');
    process.stdout.write(content);
    process.stdout.write(`[sign] key_id: ${secret.keyId.toString(16).toUpperCase()}\n`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 生成 sha256（默认与 --sha256-only 都会做）
// ---------------------------------------------------------------------------

writeFileSync(join(REPO_ROOT, SHA_PATH), `${indexSha}\n`);
process.stdout.write(`[sign] 已写入 ${SHA_PATH}: ${indexSha}\n`);

if (opts.sha256Only) {
  if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, sha256: indexSha, signed: false }, null, 2)}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 生成 minisig
// ---------------------------------------------------------------------------

const keySource = readKeySource(opts.secretKey, 'MINISIGN_SECRET_KEY');
if (!keySource) {
  fail(
    '未提供签名私钥：请设置环境变量 MINISIGN_SECRET_KEY（base64、密钥文件内容或文件路径），' +
      '或使用 --secret-key <path>。\n' +
      '  本脚本不会生成任何占位或伪造签名——2.5 规定 index.json.minisig 是客户端的安全锚点，\n' +
      '  假签名会让客户端信任一份无效索引。\n' +
      `  ${SHA_PATH} 已正常生成；minisig 步骤失败是正确的失败行为。`,
    2,
  );
}

const secret = parseSecretKey(extractBase64Payload(keySource.text, `私钥（${keySource.from}）`));

const systemMinisign = findSystemMinisign();
let signatureStruct;
let globalSignature;
let signerUsed;

if (systemMinisign) {
  // 有系统 minisign 时优先使用它：产出的文件可被官方工具互相验证，信任度更高。
  // 通过临时文件交互，避免把密钥内容塞进命令行参数（进程列表可见）。
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const work = mkdtempSync(join(tmpdir(), 'cgl-sign-'));
  try {
    const keyFile = join(work, 'minisign.key');
    const sigFile = join(work, SIG_PATH);
    writeFileSync(keyFile, `${keySource.text.trimEnd()}\n`);
    writeFileSync(join(work, INDEX_PATH), indexBytes);
    execFileSync(systemMinisign, ['-S', '-s', keyFile, '-m', join(work, INDEX_PATH), '-x', sigFile, '-t', buildTrustedComment(indexBytes)], {
      cwd: work,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const produced = parseMinisigFile(readFileSync(sigFile, 'utf8'));
    if (!produced) fail('系统 minisign 产出的签名文件无法解析。');
    signatureStruct = produced.signatureStruct;
    globalSignature = produced.globalSignature;
    signerUsed = `system minisign (${systemMinisign})`;
  } catch (err) {
    // 系统 minisign 存在但调用失败（如加密私钥需要交互输入密码）时，明确报告而不是静默回落。
    fail(
      `调用系统 minisign 失败：${err.message.split('\n')[0]}\n` +
        '  若私钥是加密的，minisign 会要求交互式输入密码，在 CI 中不可用。\n' +
        '  请改用未加密私钥（minisign -G 时不设密码）并存入 Secret MINISIGN_SECRET_KEY。',
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
} else {
  // 回落：用 Node crypto 实现等价的 ed25519 签名。
  const messageSignature = signMessage(secret.privateKeyObject, indexBytes);
  signatureStruct = buildSignatureStruct(messageSignature, secret.keyIdBytes);

  const trustedComment = buildTrustedComment(indexBytes);
  const trustedBytes = Buffer.concat([signatureStruct, Buffer.from(trustedComment, 'utf8')]);
  globalSignature = signMessage(secret.privateKeyObject, trustedBytes);
  signerUsed = 'node:crypto ed25519 (minisign 兼容格式)';
}

const trustedComment = buildTrustedComment(indexBytes);
const untrustedComment = `cgl-libs metadata index schema_version=1 sha256=${indexSha}`;
const sigContent = buildMinisigFile({
  signatureStruct,
  trustedComment,
  globalSignature,
  untrustedComment,
});
writeFileSync(join(REPO_ROOT, SIG_PATH), sigContent);

// ---------------------------------------------------------------------------
// 自校验：生成后立即用公钥验一遍，避免写出一个自己都验不过的签名。
// ---------------------------------------------------------------------------

const selfPub = parsePublicKey(
  Buffer.concat([
    Buffer.from([ALG_ED25519 & 0xff, (ALG_ED25519 >> 8) & 0xff]),
    secret.keyIdBytes,
    secret.publicKey,
  ]).toString('base64'),
);
const selfBody = verifyMessage(selfPub.publicKeyObject, indexBytes, signatureStruct.subarray(10, 74));
const selfGlobal = verifyMessage(
  selfPub.publicKeyObject,
  Buffer.concat([signatureStruct, Buffer.from(trustedComment, 'utf8')]),
  globalSignature,
);

if (!selfBody || !selfGlobal) {
  fail(
    `生成后的自校验失败（文件签名 ${selfBody}，全局签名 ${selfGlobal}）。` +
      '已写入的签名不可信，请勿提交；这通常意味着密钥文件损坏。',
  );
}

const result = {
  ok: true,
  signed: true,
  signer: signerUsed,
  index_sha256: indexSha,
  key_id: secret.keyId,
  trusted_comment: trustedComment,
  sha256_file: SHA_PATH,
  signature_file: SIG_PATH,
};

if (opts.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(`[sign] 已写入 ${SIG_PATH}（签名者：${signerUsed}）\n`);
  process.stdout.write(`[sign] key_id: ${secret.keyId.toString(16).toUpperCase()}\n`);
  process.stdout.write(`[sign] trusted comment: ${trustedComment}\n`);
  process.stdout.write('[sign] 自校验: 通过（文件签名与全局签名均可被对应公钥验证）\n');
}

/**
 * trusted comment 内容。
 * 依 2.5 防降级与 1.4 时效要求，把索引的关键标识写进被签名的 comment，
 * 客户端与审计者无需解析 JSON 即可看到"这份签名对应哪次生成"。
 */
function buildTrustedComment(bytes) {
  const sha = createHash('sha256').update(bytes).digest('hex');
  let generatedAt = 'unknown';
  let entries = 'unknown';
  try {
    const doc = JSON.parse(bytes.toString('utf8'));
    generatedAt = doc.generated_at ?? 'unknown';
    entries = Array.isArray(doc.entries) ? String(doc.entries.length) : 'unknown';
  } catch {
    // 索引无法解析时仍允许签名（校验阶段会拦住），comment 里如实标注。
    generatedAt = 'unparsable';
  }
  return `cgl-libs index.json sha256=${sha} generated_at=${generatedAt} entries=${entries}`;
}
