// Offline CLI regressions. Fixtures contain only copied tools/schema and synthetic
// metadata; never copy repository data, signing keys, .local, or the real .git.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const FIXTURE_PREFIX = 'cgl-libs-metadata test-';
const FROZEN_TIME = '2024-01-02T03:04:05Z';
const NEXT_TIME = '2024-01-03T03:04:05Z';
const GENERATED_PATHS = [
  'index.json', 'index.json.sha256', 'modules/_index.json', 'modules/by-id.json',
];

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function createFixture(t) {
  // A space in the path exercises Windows argument handling without a shell.
  const root = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith(FIXTURE_PREFIX));
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  mkdirSync(join(root, 'tools'), { recursive: true });
  for (const entry of readdirSync(join(REPO_ROOT, 'tools'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) {
      copyFileSync(join(REPO_ROOT, 'tools', entry.name), join(root, 'tools', entry.name));
    }
  }
  cpSync(join(REPO_ROOT, 'tools', 'lib'), join(root, 'tools', 'lib'), { recursive: true });
  cpSync(join(REPO_ROOT, 'schema'), join(root, 'schema'), { recursive: true });
  assert.equal(existsSync(join(root, '.local')), false);
  assert.equal(existsSync(join(root, '.git')), false);

  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
    !/^GIT_/i.test(key) && !/^(GITHUB_SHA|NODE_OPTIONS)$/i.test(key)
  )));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'absent-global-gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  });

  const run = (command, args, expectedStatus = 0, extraEnv = {}) => {
    const result = spawnSync(command, args, {
      cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8',
      timeout: 15_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
    const detail = `${command} ${args.join(' ')}\nstdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`;
    assert.equal(result.error, undefined, detail);
    assert.equal(result.signal, null, detail);
    assert.equal(result.status, expectedStatus, detail);
    return result.stdout;
  };
  const git = (...args) => run('git', args).trim();
  const cli = (script, args = [], expectedStatus = 0, extraEnv = {}) => {
    const output = run(process.execPath, [join(root, 'tools', script), ...args, '--json'], expectedStatus, extraEnv);
    try {
      return JSON.parse(output);
    } catch (error) {
      assert.fail(`CLI did not return JSON: ${error.message}\n${output}`);
    }
  };
  const write = (path, bytes) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  const writeJson = (path, value) => write(path, serialize(value));
  const read = (path) => readFileSync(join(root, path));
  const readJson = (path) => JSON.parse(read(path).toString('utf8'));
  const commit = (message, ...args) => git(
    '-c', 'user.name=Metadata Regression', '-c', 'user.email=metadata-regression@example.invalid',
    '-c', 'commit.gpgSign=false', 'commit', '-m', message, ...args,
  );
  const writeSnapshot = (manifest) => {
    const bytes = Buffer.from(serialize(manifest), 'utf8');
    write('mcbe/manifest.json', bytes);
    writeJson('mcbe/meta.json', {
      schema_version: manifest.schema_version,
      generated_at: manifest.generated_at,
      upstream: manifest.upstream,
      counts: { preview: manifest.preview_versions.length, release: manifest.release_versions.length },
      manifest_path: 'mcbe/manifest.json',
      manifest_sha256: sha256(bytes),
    });
  };

  git('-c', 'init.templateDir=', 'init', '--initial-branch=main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'core.hooksPath', join(root, 'absent-hooks'));
  writeSnapshot({
    schema_version: 1,
    generated_at: FROZEN_TIME,
    upstream: {
      repo: 'LiteLDev/minecraft-windows-gdk-version-db',
      commit: 'a'.repeat(40),
      raw_sha256: sha256(Buffer.from('synthetic upstream bytes')),
      sources: ['https://example.invalid/historical_versions.json'],
      file_version: 1,
    },
    preview_versions: [],
    release_versions: [{
      version: '1.0.0', urls: ['https://example.invalid/synthetic-game.msixvc'],
      timestamp: 1, md5: '1'.repeat(32),
    }],
  });
  git('add', '--all');
  commit('test: seed isolated metadata inputs');
  const sourceCommit = git('rev-parse', 'HEAD');
  cli('build-index.mjs', ['--frozen-time', FROZEN_TIME]);
  // This tracked sentinel tests only the diff guard, not signature verification.
  // No private key or purported valid signature is needed by these tests.
  write('index.json.minisig', 'isolated diff-guard sentinel; not a signature\n');
  git('add', '--all');
  commit('test: record generated fixture artifacts');
  git('checkout', '-b', 'test/metadata-change');

  return { root, run, git, cli, write, writeJson, read, readJson, commit, writeSnapshot, sourceCommit };
}

function assertIndexedBytes(fixture) {
  const index = fixture.readJson('index.json');
  for (const entry of index.entries) {
    const bytes = fixture.read(entry.path);
    assert.equal(entry.sha256, sha256(bytes), entry.path);
    assert.equal(entry.size, bytes.length, entry.path);
  }
  assert.equal(fixture.read('index.json.sha256').toString('utf8').trim(), sha256(fixture.read('index.json')));
  assert.equal(fixture.readJson('mcbe/meta.json').manifest_sha256, sha256(fixture.read('mcbe/manifest.json')));
}

function assertError(report, where, field) {
  assert.ok(report.errors.some((error) => error.where === where && error.field === field), JSON.stringify(report));
}

test('initial generation is valid and frozen regeneration is byte-stable', (t) => {
  const fixture = createFixture(t);
  fixture.cli('validate.mjs', ['--schema']);
  fixture.cli('build-index.mjs', ['--check']);
  assertIndexedBytes(fixture);
  const originals = new Map(GENERATED_PATHS.map((path) => [path, fixture.read(path)]));
  fixture.cli('build-index.mjs', ['--frozen-time', FROZEN_TIME, '--commit', fixture.sourceCommit]);
  for (const [path, expected] of originals) {
    const actual = fixture.read(path);
    assert.deepEqual(actual, expected, path);
    assert.equal(actual.includes(13), false, `${path} must use LF, not CRLF`);
    assert.notEqual(actual.subarray(0, 3).toString('hex'), 'efbbbf', `${path} must not have a BOM`);
    assert.equal(actual.at(-1), 10, `${path} must end with LF`);
  }
  fixture.cli('build-index.mjs', ['--check']);
  assert.equal(fixture.git('status', '--short'), '');
});

test('new MCBE input passes guard/source checks, then full checks after generation', (t) => {
  const fixture = createFixture(t);
  const manifest = fixture.readJson('mcbe/manifest.json');
  manifest.generated_at = NEXT_TIME;
  manifest.release_versions[0].version = '1.0.0-synthetic-new-version';
  fixture.writeSnapshot(manifest);

  const stale = fixture.cli('validate.mjs', ['--schema'], 1);
  assertError(stale, 'mcbe/manifest.json', 'sha256');
  assertError(stale, 'mcbe/manifest.json', 'size');
  const guard = fixture.cli('validate.mjs', ['--generated-guard']);
  assert.deepEqual(guard.passed.map(({ step }) => step), ['step3-generated-guard']);
  assert.deepEqual(guard.warnings, []);
  const source = fixture.cli('validate.mjs', ['--schema', '--source-only']);
  assert.equal(source.passed.some(({ step }) => step === 'step13-generated-consistency'), false);
  assert.ok(source.passed.some(({ step }) => step === 'step10-mcbe-snapshot'));

  fixture.cli('build-index.mjs', ['--frozen-time', NEXT_TIME]);
  fixture.cli('validate.mjs', ['--schema']);
  fixture.cli('build-index.mjs', ['--check']);
  assertIndexedBytes(fixture);
  // Reordering the guard after generation would incorrectly reject CI's own output.
  fixture.cli('validate.mjs', ['--generated-guard'], 1);
});

test('the guard rejects each tracked generated-file edit before any rebuild', async (t) => {
  const fixture = createFixture(t);
  for (const path of [...GENERATED_PATHS, 'index.json.minisig']) {
    await t.test(path, () => {
      const original = fixture.read(path);
      try {
        fixture.write(path, Buffer.concat([original, Buffer.from('\n')]));
        const report = fixture.cli('validate.mjs', ['--generated-guard'], 1);
        assert.ok(report.errors.some((error) => error.step === 'step3-generated-guard' && error.where === path));
        assert.ok(report.errors.every((error) => error.step === 'step3-generated-guard'));
      } finally {
        fixture.write(path, original);
      }
    });
  }
  // Also exercise the committed PR diff, not just uncommitted working-tree edits.
  fixture.write('index.json', Buffer.concat([fixture.read('index.json'), Buffer.from('\n')]));
  fixture.git('add', 'index.json');
  fixture.commit('test: simulate a submitted generated-file edit');
  const committed = fixture.cli('validate.mjs', ['--generated-guard'], 1);
  assert.ok(committed.errors.some((error) => error.where === 'index.json'));
});

test('source-only skips stale generated documents, but still validates source schema', (t) => {
  const fixture = createFixture(t);
  for (const path of ['index.json', 'modules/_index.json', 'modules/by-id.json']) {
    fixture.write(path, 'deliberately stale generated document, not JSON\n');
  }
  const source = fixture.cli('validate.mjs', ['--source-only']);
  assert.ok(source.passed.some(({ step }) => step === 'step4-schema'));
  const manifest = fixture.readJson('mcbe/manifest.json');
  manifest.schema_version = '1';
  fixture.writeSnapshot(manifest);
  const invalid = fixture.cli('validate.mjs', ['--schema', '--source-only'], 1);
  assert.ok(invalid.errors.some((error) => error.step === 'step4-schema'
    && error.where === 'mcbe/manifest.json' && error.field.includes('schema_version')));
});

test('source-only rejects incomplete or internally inconsistent MCBE snapshots', async (t) => {
  const fixture = createFixture(t);
  const original = fixture.read('mcbe/meta.json');
  const cases = [
    { name: 'missing meta', field: '(文件)', where: 'mcbe/', apply: () => rmSync(join(fixture.root, 'mcbe/meta.json')) },
    { name: 'wrong manifest hash', field: 'manifest_sha256', apply: (meta) => { meta.manifest_sha256 = '0'.repeat(64); } },
    { name: 'wrong counts', field: 'counts.release', apply: (meta) => { meta.counts.release += 1; } },
    { name: 'wrong generation time', field: 'generated_at', apply: (meta) => { meta.generated_at = NEXT_TIME; } },
    { name: 'wrong upstream commit', field: 'upstream', apply: (meta) => { meta.upstream.commit = 'b'.repeat(40); } },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      fixture.write('mcbe/meta.json', original);
      const meta = fixture.readJson('mcbe/meta.json');
      scenario.apply(meta);
      if (scenario.name !== 'missing meta') fixture.writeJson('mcbe/meta.json', meta);
      const report = fixture.cli('validate.mjs', ['--schema', '--source-only'], 1);
      assertError(report, scenario.where ?? 'mcbe/meta.json', scenario.field);
    });
  }
  fixture.write('mcbe/meta.json', original);
});

function syntheticModule(fixture, status = 'pending') {
  const icon = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3X8AAAAASUVORK5CYII=', 'base64');
  fixture.write('assets/icons/audit.sample.png', icon);
  return {
    id: 'audit.sample', i18n_namespace: 'audit-sample', display_name: 'Synthetic module',
    summary: { 'zh-CN': 'Synthetic summary', 'en-US': 'Synthetic summary' },
    author: { name: 'Audit', contact: 'https://example.invalid/audit', verified: true },
    repo: 'https://example.invalid/audit/sample', license: 'MIT', channel: 'stable',
    version: '1.0.0', published_at: FROZEN_TIME, platforms: ['windows-x86_64'],
    min_launcher: '0.1.0', max_launcher: null, api_version: 1,
    icon: { path: 'assets/icons/audit.sample.png', sha256: sha256(icon), size: icon.length },
    assets: [{
      platform: 'windows-x86_64', url: 'https://example.invalid/audit/sample.cglm',
      mirrors: [], size: 1, sha256: sha256(Buffer.from('x')),
    }],
    permissions: [], permissions_derived: { network: false, spawn_process: false, write_outside_module_dir: false },
    changelog: { 'zh-CN': 'Synthetic change', 'en-US': 'Synthetic change' },
    status, yanked: false, yank_reason: null,
  };
}

function syntheticShard(entry) {
  return { schema_version: 1, generated_at: FROZEN_TIME, range: 'a-b', modules: [entry] };
}

function fixtureBytes(root) {
  const files = [];
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(directory, entry.name), relative);
      else if (entry.isFile()) files.push([relative, readFileSync(join(directory, entry.name))]);
    }
  };
  visit(root);
  return files;
}

function assertBuildRefusesWithoutWrites(fixture) {
  const before = fixtureBytes(fixture.root);
  fixture.run(process.execPath, [join(fixture.root, 'tools', 'build-index.mjs'), '--frozen-time', FROZEN_TIME], 1);
  assert.deepEqual(fixtureBytes(fixture.root), before, 'Failure must happen before any generated file is written or removed');
}

test('a sole canonical approved shard is never silently erased by generation', (t) => {
  const fixture = createFixture(t);
  const entry = syntheticModule(fixture, 'approved');
  fixture.writeJson('modules/a-b.json', syntheticShard(entry));
  fixture.cli('validate.mjs', ['--schema', '--source-only']);
  // Ownership is ambiguous without a separate input directory. Until migrated,
  // fail closed rather than discarding the only copy of an approved module.
  assertBuildRefusesWithoutWrites(fixture);
  assert.deepEqual(fixture.readJson('modules/a-b.json').modules, [entry]);
});

test('generation refuses to overwrite pending entries in an output-shaped shard', (t) => {
  const fixture = createFixture(t);
  const approved = syntheticModule(fixture, 'approved');
  fixture.writeJson('modules/source.json', syntheticShard(approved));
  const pending = structuredClone(approved);
  pending.id = 'audit.pending';
  pending.i18n_namespace = 'audit-pending';
  pending.status = 'pending';
  const mixed = syntheticShard(approved);
  mixed.modules.push(pending);
  fixture.writeJson('modules/a-b.json', mixed);
  assertBuildRefusesWithoutWrites(fixture);
  assert.deepEqual(fixture.readJson('modules/a-b.json').modules, [approved, pending]);
});

test('MCBE object key order is irrelevant but upstream source order is significant', (t) => {
  const fixture = createFixture(t);
  const manifest = fixture.readJson('mcbe/manifest.json');
  manifest.upstream.sources.push('https://example.invalid/fallback.json');
  fixture.writeSnapshot(manifest);
  const meta = fixture.readJson('mcbe/meta.json');
  meta.upstream = Object.fromEntries(Object.entries(meta.upstream).reverse());
  fixture.writeJson('mcbe/meta.json', meta);
  fixture.cli('validate.mjs', ['--schema', '--source-only']);
  meta.upstream.sources.reverse();
  fixture.writeJson('mcbe/meta.json', meta);
  const report = fixture.cli('validate.mjs', ['--schema', '--source-only'], 1);
  assertError(report, 'mcbe/meta.json', 'upstream');
});

test('source-only retains module semantic checks such as inverted launcher ranges', (t) => {
  const fixture = createFixture(t);
  const entry = syntheticModule(fixture);
  const writeSource = () => fixture.writeJson('modules/source.json', syntheticShard(entry));
  writeSource();
  fixture.cli('validate.mjs', ['--schema', '--source-only']);
  entry.min_launcher = '0.2.0';
  entry.max_launcher = '0.1.0';
  writeSource();
  const report = fixture.cli('validate.mjs', ['--schema', '--source-only'], 1);
  assert.equal(report.errors.some((error) => error.step === 'step4-schema'), false, JSON.stringify(report));
  assert.ok(report.errors.some((error) => error.step === 'step8-semver' && error.field === 'max_launcher'));
});

test('--check anchors commit-dependent URLs/checksums after HEAD and GITHUB_SHA advance', (t) => {
  const fixture = createFixture(t);
  fixture.commit('test: advance HEAD without changing metadata', '--allow-empty');
  const head = fixture.git('rev-parse', 'HEAD');
  assert.notEqual(head, fixture.sourceCommit);
  assert.equal(fixture.cli('build-index.mjs', ['--check']).commit, fixture.sourceCommit);
  const checked = fixture.cli('build-index.mjs', ['--check'], 0, { GITHUB_SHA: 'b'.repeat(40) });
  assert.equal(checked.commit, fixture.sourceCommit);
  assert.deepEqual(checked.check_failures, []);
  fixture.cli('build-index.mjs', ['--check', '--commit', fixture.sourceCommit], 0, { GITHUB_SHA: head });
  const pinned = fixture.cli('build-index.mjs', ['--check', '--commit', head], 1);
  assert.ok(pinned.check_failures.length > 0);
  assert.equal(fixture.git('status', '--short'), '');
});

test('tampering remains detectable, including URLs with a recomputed self-checksum', async (t) => {
  const fixture = createFixture(t);
  const paths = ['mcbe/manifest.json', 'mcbe/meta.json', 'index.json', 'index.json.sha256'];
  const originals = new Map(paths.map((path) => [path, fixture.read(path)]));
  const rehashIndex = () => fixture.write('index.json.sha256', `${sha256(fixture.read('index.json'))}\n`);
  const cases = [
    {
      name: 'changed manifest bytes',
      apply: () => {
        const manifest = fixture.readJson('mcbe/manifest.json');
        manifest.release_versions[0].version = '2.0.0';
        fixture.writeSnapshot(manifest);
      },
    },
    {
      name: 'forged entry size',
      apply: () => {
        const index = fixture.readJson('index.json');
        index.entries.find(({ kind }) => kind === 'mcbe_manifest').size += 1;
        fixture.writeJson('index.json', index);
        rehashIndex();
      },
    },
    { name: 'forged index checksum', apply: () => fixture.write('index.json.sha256', `${'0'.repeat(64)}\n`) },
    {
      name: 'rewritten mirror URL', checkOnly: true,
      apply: () => {
        const index = fixture.readJson('index.json');
        index.entries[0].urls[0] = 'https://example.invalid/rewritten/modules-index.json';
        fixture.writeJson('index.json', index);
        rehashIndex();
      },
    },
    {
      name: 'CRLF checkout conversion',
      apply: () => {
        const crlf = fixture.read('mcbe/manifest.json').toString('utf8').replaceAll('\n', '\r\n');
        fixture.write('mcbe/manifest.json', crlf);
        const meta = fixture.readJson('mcbe/meta.json');
        meta.manifest_sha256 = sha256(fixture.read('mcbe/manifest.json'));
        fixture.writeJson('mcbe/meta.json', meta);
      },
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      try {
        scenario.apply();
        if (!scenario.checkOnly) fixture.cli('validate.mjs', ['--schema'], 1);
        const checked = fixture.cli('build-index.mjs', ['--check'], 1);
        assert.ok(checked.check_failures.length > 0);
      } finally {
        for (const [path, bytes] of originals) fixture.write(path, bytes);
      }
    });
  }
  fixture.cli('validate.mjs', ['--schema']);
  fixture.cli('build-index.mjs', ['--check']);
});

function workflowCommands(text) {
  return text.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line.startsWith('run: ')).map((line) => line.slice(5));
}

function assertCommandOrder(commands, patterns) {
  let cursor = -1;
  for (const pattern of patterns) {
    const next = commands.findIndex((command, index) => index > cursor && pattern.test(command));
    assert.ok(next > cursor, `Missing ordered command ${pattern}: ${JSON.stringify(commands)}`);
    cursor = next;
  }
}

test('workflow contracts keep guards before generation and restrict sync PR paths', () => {
  const workflow = (name) => readFileSync(join(REPO_ROOT, '.github', 'workflows', name), 'utf8');
  const source = /^node tools\/validate\.mjs --schema --source-only$/;
  const build = /^node tools\/build-index\.mjs(?: --commit .+)?$/;
  const full = /^node tools\/validate\.mjs --schema$/;
  const check = /^node tools\/build-index\.mjs --check$/;
  const validate = workflow('validate.yml');
  assertCommandOrder(workflowCommands(validate), [
    /^node tools\/validate\.mjs --generated-guard$/, source, build, full, check,
  ]);
  const sync = workflow('sync-mcbe.yml');
  assertCommandOrder(workflowCommands(sync), [/^node tools\/sync-mcbe\.mjs --json$/, source, build, full, check]);
  const addPaths = sync.match(/^\s{10}add-paths:\s*\|\r?\n((?: {12}[^\r\n]*(?:\r?\n|$))+)/m);
  assert.ok(addPaths, 'Sync PR must explicitly restrict staged changes');
  assert.deepEqual(addPaths[1].trim().split(/\r?\n/).map((line) => line.trim()), [
    'mcbe/manifest.json', 'mcbe/meta.json',
  ]);
  const publish = workflow('build-index.yml');
  const activePublish = publish.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('#')).join('\n');
  assert.match(activePublish, /^\s+workflow_dispatch:/m);
  assert.match(activePublish, /^\s+paths:/m);
  assert.doesNotMatch(activePublish, /^\s+paths-ignore:/m);
  assert.match(activePublish, /^\s+ref: main\s*$/m);
  assert.match(activePublish, /node tools\/build-index\.mjs --commit "\$\(git rev-parse HEAD\)"/);
  assertCommandOrder(workflowCommands(publish), [source, build, full, check]);
  const attributes = readFileSync(join(REPO_ROOT, '.gitattributes'), 'utf8');
  for (const extension of ['json', 'sha256', 'minisig']) {
    assert.match(attributes, new RegExp(`^\\*\\.${extension}\\s+text\\s+eol=lf\\s*$`, 'm'));
  }
});
