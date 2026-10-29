import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(import.meta.dirname, 'merge-back.mjs');

function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  }
  return r.stdout;
}

const git = (cwd, args) => sh(cwd, 'git', args);

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-back-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'l1\nl2\nl3\nl4\nl5\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b1\nb2\nb3\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'base']);
  fs.mkdirSync(path.join(repo, '.git', 'agent-patches'));
  return { root, repo };
}

function makePatch(repo, root, task, mutate) {
  const wt = path.join(root, 'wt-' + task);
  git(repo, ['worktree', 'add', '-q', '--detach', wt, 'HEAD']);
  mutate(wt);
  git(wt, ['add', '-N', '.']);
  const patch = git(wt, ['diff', '--binary', 'HEAD']);
  fs.writeFileSync(path.join(repo, '.git', 'agent-patches', `${task}.patch`), patch);
  git(repo, ['worktree', 'remove', '--force', wt]);
}

function runMerge(repo, args) {
  return spawnSync(process.execPath, [SCRIPT, '--repo', repo, ...args], {
    encoding: 'utf8',
  });
}

const read = (repo, file) =>
  fs.readFileSync(path.join(repo, file), 'utf8').replace(/\r\n/g, '\n');

test('applies a patch to the working tree as unstaged changes', () => {
  const { root, repo } = makeRepo();
  makePatch(repo, root, 't1', (wt) =>
    fs.writeFileSync(path.join(wt, 'a.txt'), 'l1\nl2\nCHANGED\nl4\nl5\n'),
  );

  const r = runMerge(repo, ['--task', 't1']);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(repo, 'a.txt'), 'l1\nl2\nCHANGED\nl4\nl5\n');
  assert.equal(git(repo, ['diff', '--cached', '--name-only']), '');
  assert.equal(git(repo, ['status', '--porcelain']), ' M a.txt\n');
});

test('creates no commits and leaves no worktrees behind', () => {
  const { root, repo } = makeRepo();
  const headBefore = git(repo, ['rev-parse', 'HEAD']);
  const branchBefore = git(repo, ['branch', '--show-current']);
  makePatch(repo, root, 't1', (wt) =>
    fs.writeFileSync(path.join(wt, 'a.txt'), 'l1\nl2\nX\nl4\nl5\n'),
  );

  runMerge(repo, ['--task', 't1']);

  assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(git(repo, ['branch', '--show-current']), branchBefore);
  const list = git(repo, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree '));
  assert.equal(list.length, 1);
});

test('merges patches touching different files', () => {
  const { root, repo } = makeRepo();
  makePatch(repo, root, 't1', (wt) =>
    fs.writeFileSync(path.join(wt, 'a.txt'), 'l1\nl2\nA\nl4\nl5\n'),
  );
  makePatch(repo, root, 't2', (wt) =>
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b1\nB\nb3\n'),
  );

  const r = runMerge(repo, ['--task', 't1', '--task', 't2']);

  assert.equal(r.status, 0, r.stderr);
  assert.match(read(repo, 'a.txt'), /A/);
  assert.match(read(repo, 'b.txt'), /B/);
});

test('merges two patches touching the same file in different regions', () => {
  const { root, repo } = makeRepo();
  makePatch(repo, root, 't1', (wt) =>
    fs.writeFileSync(path.join(wt, 'a.txt'), 'l1\nl2\nA\nl4\nl5\n'),
  );
  makePatch(repo, root, 't2', (wt) =>
    fs.writeFileSync(path.join(wt, 'a.txt'), 'l1\nl2\nl3\nl4\nB\n'),
  );

  const r = runMerge(repo, ['--task', 't1', '--task', 't2']);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(repo, 'a.txt'), 'l1\nl2\nA\nl4\nB\n');
  assert.doesNotMatch(read(repo, 'a.txt'), /<<<<<<<|>>>>>>>/);
});

test('leaves the index and staged changes untouched', () => {
  const { root, repo } = makeRepo();
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b1\nSTAGED\nb3\n');
  git(repo, ['add', 'b.txt']);
  makePatch(repo, root, 't1', (wt) =>
    fs.writeFileSync(path.join(wt, 'a.txt'), 'l1\nl2\nA\nl4\nl5\n'),
  );

  runMerge(repo, ['--task', 't1']);

  assert.equal(git(repo, ['diff', '--cached', '--name-only']), 'b.txt\n');
  assert.equal(read(repo, 'b.txt'), 'b1\nSTAGED\nb3\n');
});

test("preserves the user's uncommitted edit outside the patched region", () => {
  const { root, repo } = makeRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'USER\nl2\nl3\nl4\nl5\n');
  makePatch(repo, root, 't1', (wt) =>
    fs.writeFileSync(path.join(wt, 'a.txt'), 'l1\nl2\nl3\nl4\nAGENT\n'),
  );

  const r = runMerge(repo, ['--task', 't1']);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(repo, 'a.txt'), 'USER\nl2\nl3\nl4\nAGENT\n');
});

test('creates and deletes files', () => {
  const { root, repo } = makeRepo();
  makePatch(repo, root, 't1', (wt) => {
    fs.writeFileSync(path.join(wt, 'c.txt'), 'new\n');
    fs.unlinkSync(path.join(wt, 'b.txt'));
  });

  const r = runMerge(repo, ['--task', 't1']);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(repo, 'c.txt'), 'new\n');
  assert.equal(fs.existsSync(path.join(repo, 'b.txt')), false);
});

test('reports an inter-agent conflict without touching the file or losing the agent version', () => {
  const { root, repo } = makeRepo();
  makePatch(repo, root, 't1', (wt) =>
    fs.writeFileSync(path.join(wt, 'a.txt'), 'l1\nl2\nP1\nl4\nl5\n'),
  );
  makePatch(repo, root, 't2', (wt) =>
    fs.writeFileSync(path.join(wt, 'a.txt'), 'l1\nl2\nP2\nl4\nl5\n'),
  );

  const r = runMerge(repo, ['--task', 't1', '--task', 't2']);

  assert.equal(r.status, 1);
  assert.match(r.stdout, /conflict.*a\.txt/);
  assert.equal(read(repo, 'a.txt'), 'l1\nl2\nl3\nl4\nl5\n');
  assert.match(read(repo, 'a.txt.theirs'), /<<<<<<<|=======|>>>>>>>/);
});

test('aborts without touching the working tree when a patch does not apply', () => {
  const { root, repo } = makeRepo();
  makePatch(repo, root, 't1', (wt) =>
    fs.writeFileSync(path.join(wt, 'a.txt'), 'l1\nl2\nA\nl4\nl5\n'),
  );
  fs.writeFileSync(
    path.join(repo, '.git', 'agent-patches', 'bad.patch'),
    [
      'diff --git a/a.txt b/a.txt',
      'index 1111111..2222222 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,2 @@',
      '-not the real content',
      '+something else',
      '',
    ].join('\n'),
  );

  const r = runMerge(repo, ['--task', 't1', '--task', 'bad']);

  assert.equal(r.status, 2);
  assert.equal(read(repo, 'a.txt'), 'l1\nl2\nl3\nl4\nl5\n');
  assert.equal(git(repo, ['status', '--porcelain']), '');
});

test('--all applies every patch in the default patch directory', () => {
  const { root, repo } = makeRepo();
  makePatch(repo, root, 't1', (wt) =>
    fs.writeFileSync(path.join(wt, 'a.txt'), 'l1\nl2\nA\nl4\nl5\n'),
  );
  makePatch(repo, root, 't2', (wt) =>
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b1\nB\nb3\n'),
  );

  const r = runMerge(repo, ['--all']);

  assert.equal(r.status, 0, r.stderr);
  assert.match(read(repo, 'a.txt'), /A/);
  assert.match(read(repo, 'b.txt'), /B/);
});

test('archives applied patches so --all cannot reapply them', () => {
  const { root, repo } = makeRepo();
  makePatch(repo, root, 't1', (wt) =>
    fs.writeFileSync(path.join(wt, 'a.txt'), 'l1\nl2\nA\nl4\nl5\n'),
  );
  const dir = path.join(repo, '.git', 'agent-patches');

  const first = runMerge(repo, ['--task', 't1']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(fs.existsSync(path.join(dir, 't1.patch')), false);
  assert.equal(fs.existsSync(path.join(dir, 't1.patch.applied')), true);

  const second = runMerge(repo, ['--all']);
  assert.equal(second.status, 2);
  assert.match(second.stderr, /patch 目录为空/);
});

test('keeps patches when the merge has conflicts', () => {
  const { root, repo } = makeRepo();
  makePatch(repo, root, 't1', (wt) =>
    fs.writeFileSync(path.join(wt, 'a.txt'), 'l1\nl2\nP1\nl4\nl5\n'),
  );
  makePatch(repo, root, 't2', (wt) =>
    fs.writeFileSync(path.join(wt, 'a.txt'), 'l1\nl2\nP2\nl4\nl5\n'),
  );
  const dir = path.join(repo, '.git', 'agent-patches');

  const r = runMerge(repo, ['--task', 't1', '--task', 't2']);

  assert.equal(r.status, 1);
  assert.equal(fs.existsSync(path.join(dir, 't1.patch')), true);
  assert.equal(fs.existsSync(path.join(dir, 't2.patch')), true);
});

test('refuses to merge while another merge-back holds the lock', () => {
  const { root, repo } = makeRepo();
  makePatch(repo, root, 't1', (wt) =>
    fs.writeFileSync(path.join(wt, 'a.txt'), 'l1\nl2\nA\nl4\nl5\n'),
  );
  const lock = path.join(repo, '.git', 'agent-patches', '.merge-back.lock');
  fs.writeFileSync(lock, 'someone-else');

  const r = runMerge(repo, ['--task', 't1', '--lock-timeout', '0']);

  assert.equal(r.status, 2);
  assert.match(r.stderr, /正在回流/);
  assert.equal(read(repo, 'a.txt'), 'l1\nl2\nl3\nl4\nl5\n');
  assert.equal(fs.existsSync(lock), true);
});

test('releases the lock after a successful merge', () => {
  const { root, repo } = makeRepo();
  makePatch(repo, root, 't1', (wt) =>
    fs.writeFileSync(path.join(wt, 'a.txt'), 'l1\nl2\nA\nl4\nl5\n'),
  );

  const r = runMerge(repo, ['--task', 't1']);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    fs.existsSync(path.join(repo, '.git', 'agent-patches', '.merge-back.lock')),
    false,
  );
});

test('keeps CRLF worktree line endings without doubling the carriage return', () => {
  const { root, repo } = makeRepo();
  // 模拟 Windows 默认 core.autocrlf=true：索引里是 LF，检出到工作区是 CRLF
  git(repo, ['config', 'core.autocrlf', 'true']);
  fs.rmSync(path.join(repo, 'a.txt'));
  git(repo, ['checkout', '--', 'a.txt']);
  assert.match(fs.readFileSync(path.join(repo, 'a.txt'), 'latin1'), /\r\n/);

  makePatch(repo, root, 't1', (wt) =>
    fs.writeFileSync(path.join(wt, 'a.txt'), 'l1\r\nl2\r\nCHANGED\r\nl4\r\nl5\r\n'),
  );

  const r = runMerge(repo, ['--task', 't1']);

  assert.equal(r.status, 0, r.stderr);
  const raw = fs.readFileSync(path.join(repo, 'a.txt'), 'latin1');
  assert.equal(raw, 'l1\r\nl2\r\nCHANGED\r\nl4\r\nl5\r\n');
  assert.equal((raw.match(/\r\r\n/g) || []).length, 0);
  assert.equal(git(repo, ['status', '--porcelain']), ' M a.txt\n');
});

test('writes binary files back byte for byte', () => {
  const { root, repo } = makeRepo();
  const base = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x0d, 0x0a]);
  fs.writeFileSync(path.join(repo, 'bin.dat'), base);
  git(repo, ['add', 'bin.dat']);
  git(repo, ['commit', '-qm', 'bin']);

  const next = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0xfe, 0x0d, 0x0a]);
  makePatch(repo, root, 't1', (wt) => fs.writeFileSync(path.join(wt, 'bin.dat'), next));

  const r = runMerge(repo, ['--task', 't1']);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'bin.dat')), next);
});

test('takes over a stale lock', () => {
  const { root, repo } = makeRepo();
  makePatch(repo, root, 't1', (wt) =>
    fs.writeFileSync(path.join(wt, 'a.txt'), 'l1\nl2\nA\nl4\nl5\n'),
  );
  const lock = path.join(repo, '.git', 'agent-patches', '.merge-back.lock');
  fs.writeFileSync(lock, 'stale');
  const old = new Date(Date.now() - 20 * 60 * 1000);
  fs.utimesSync(lock, old, old);

  const r = runMerge(repo, ['--task', 't1']);

  assert.equal(r.status, 0, r.stderr);
  assert.match(read(repo, 'a.txt'), /A/);
});

test('takes over a lock whose pid is gone without waiting for the mtime timeout', () => {
  const { root, repo } = makeRepo();
  makePatch(repo, root, 't1', (wt) =>
    fs.writeFileSync(path.join(wt, 'a.txt'), 'l1\nl2\nA\nl4\nl5\n'),
  );
  const dead = spawnSync(process.execPath, ['-e', '0']);
  const lock = path.join(repo, '.git', 'agent-patches', '.merge-back.lock');
  fs.writeFileSync(lock, String(dead.pid ?? 999999));

  const r = runMerge(repo, ['--task', 't1', '--lock-timeout', '0']);

  assert.equal(r.status, 0, r.stderr);
  assert.match(read(repo, 'a.txt'), /A/);
});
