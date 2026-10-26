#!/usr/bin/env node
// 将各 agent 在独立 worktree 中产出的 patch 依次合回主工作区。
// 全程不创建 commit、不修改 index，结果保持为未提交状态。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USAGE = `用法:
  node scripts/merge-back.mjs --repo <仓库> --task <名称> [--task <名称> ...]
  node scripts/merge-back.mjs --repo <仓库> --all

选项:
  --repo <路径>       主工作区（默认当前目录）
  --task <名称>       应用 <patch-dir>/<名称>.patch，可重复
  --all               应用 patch-dir 下全部 *.patch，按文件名排序
  --patch-dir <路径>  patch 目录（默认 <仓库>/.git/agent-patches）
  --base <提交>       patch 的基准提交（默认 HEAD）
  --keep              保留临时整合 worktree，便于人工排查
  --json              以 JSON 输出结果
  --lock-timeout <毫秒>  等待另一个回流结束的时间，默认 30000，0 表示不等待

退出码: 0 干净合并 / 1 存在冲突 / 2 执行失败（主工作区未被改动）`;

function parseArgs(argv) {
  const opts = { tasks: [], all: false, keep: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} 缺少参数`);
      return v;
    };
    if (a === '--repo') opts.repo = next();
    else if (a === '--task') opts.tasks.push(next());
    else if (a === '--all') opts.all = true;
    else if (a === '--patch-dir') opts.patchDir = next();
    else if (a === '--base') opts.base = next();
    else if (a === '--keep') opts.keep = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--lock-timeout') {
      const v = Number(next());
      if (!Number.isFinite(v) || v < 0) fail(`--lock-timeout 需要非负毫秒数`);
      opts.lockTimeout = v;
    }
    else if (a === '-h' || a === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else fail(`未知参数: ${a}`);
  }
  if (!opts.all && opts.tasks.length === 0) fail('需要 --task 或 --all');
  return opts;
}

class UserError extends Error {}

function fail(message) {
  throw new UserError(message);
}

function git(cwd, args, encoding = 'utf8') {
  return spawnSync('git', args, { cwd, encoding, maxBuffer: 256 * 1024 * 1024 });
}

function gitOrFail(cwd, args, what) {
  const r = git(cwd, args);
  if (r.status !== 0) fail(`${what}失败: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return null;
    throw e;
  }
}

function isBinary(buf) {
  return buf !== null && buf.includes(0);
}

function normalize(buf) {
  if (buf === null) return null;
  return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

function same(a, b) {
  if (a === null || b === null) return a === b;
  return normalize(a).equals(normalize(b));
}

function eolOf(buf) {
  return buf.includes('\r\n') ? '\r\n' : '\n';
}

function applyEol(buf, eol) {
  if (eol === '\n') return buf;
  return Buffer.from(buf.toString('utf8').replace(/\n/g, '\r\n'), 'utf8');
}

function blobAt(repo, base, file) {
  const r = git(repo, ['cat-file', 'blob', `${base}:${file}`], 'buffer');
  return r.status === 0 ? r.stdout : null;
}

function patchTargets(file) {
  const text = fs.readFileSync(file, 'utf8');
  const targets = [];
  for (const m of text.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    targets.push(m[2]);
  }
  return targets;
}

function unmergedPaths(cwd) {
  const out = git(cwd, ['diff', '--name-only', '--diff-filter=U']).stdout || '';
  return out.split('\n').filter(Boolean);
}

function threeWayMerge(ours, base, theirs, labels) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-back-file-'));
  const o = path.join(dir, 'ours');
  const b = path.join(dir, 'base');
  const t = path.join(dir, 'theirs');
  try {
    fs.writeFileSync(o, ours);
    fs.writeFileSync(b, base);
    fs.writeFileSync(t, theirs);
    const r = spawnSync(
      'git',
      ['merge-file', '-p', '-L', labels.ours, '-L', labels.base, '-L', labels.theirs, o, b, t],
      { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
    );
    if (r.status === 255 || (r.status < 0 && r.error)) {
      throw new Error((r.stderr || '').toString());
    }
    return { merged: r.stdout, conflicts: r.status };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFileEnsuringDir(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const STALE_LOCK_MS = 10 * 60 * 1000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(dir, timeoutMs) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.merge-back.lock');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return lock;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stat;
      try {
        stat = fs.statSync(lock);
      } catch {
        continue;
      }
      if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        fs.rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        fail(`另一个 merge-back 正在回流（锁文件 ${lock}），稍后重试或确认无进程后删除它`);
      }
      sleepSync(200);
    }
  }
}

function mergeIntoWorktree({ repo, tmp, base, file, conflicted }) {
  const target = path.join(repo, file);
  const theirs = readOrNull(path.join(tmp, file));

  if (conflicted) {
    if (theirs !== null) fs.writeFileSync(`${target}.theirs`, theirs);
    return { file, action: 'conflict', detail: 'agent 之间冲突，agent 版本已存为 <file>.theirs' };
  }

  const baseBuf = blobAt(repo, base, file);
  const ours = readOrNull(target);

  if (theirs === null) {
    if (ours === null) return { file, action: 'unchanged' };
    if (same(ours, baseBuf)) {
      fs.rmSync(target, { force: true });
      return { file, action: 'deleted' };
    }
    return { file, action: 'conflict', detail: 'agent 删除该文件，但工作区版本已被修改，已保留工作区版本' };
  }

  if (ours === null) {
    if (baseBuf !== null) {
      return { file, action: 'conflict', detail: '文件在工作区已被删除，但 agent 修改了它，未写回' };
    }
    writeFileEnsuringDir(target, theirs);
    return { file, action: 'created' };
  }

  if (same(ours, theirs)) return { file, action: 'unchanged' };

  if (same(ours, baseBuf)) {
    writeFileEnsuringDir(target, applyEol(theirs, eolOf(ours)));
    return { file, action: 'merged' };
  }

  if (isBinary(ours) || isBinary(baseBuf) || isBinary(theirs)) {
    fs.writeFileSync(`${target}.theirs`, theirs);
    return { file, action: 'conflict', detail: '二进制文件同时被修改，agent 版本已存为 <file>.theirs' };
  }

  const { merged, conflicts } = threeWayMerge(
    normalize(ours),
    normalize(baseBuf) || Buffer.alloc(0),
    normalize(theirs),
    {
      ours: 'ours(工作区)',
      base: `base(${base.slice(0, 8)})`,
      theirs: 'theirs(agent)',
    },
  );
  writeFileEnsuringDir(target, applyEol(merged, eolOf(ours)));
  return {
    file,
    action: conflicts > 0 ? 'conflict' : 'merged',
    detail: conflicts > 0 ? `工作区版本与 agent 版本冲突，已写入冲突标记（${conflicts} 处）` : undefined,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cwd = path.resolve(opts.repo || process.cwd());

  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) fail(`不是 git 仓库: ${cwd}`);
  const repo = top.stdout.trim();

  const base = (opts.base || gitOrFail(repo, ['rev-parse', 'HEAD'], '读取 HEAD')).trim();
  if (git(repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).status !== 0) {
    fail(`基准提交无效: ${base}`);
  }

  const patchDir = path.resolve(opts.patchDir || path.join(repo, '.git', 'agent-patches'));
  let patchFiles;
  if (opts.all) {
    if (!fs.existsSync(patchDir)) fail(`patch 目录不存在: ${patchDir}`);
    patchFiles = fs
      .readdirSync(patchDir)
      .filter((f) => f.endsWith('.patch'))
      .sort()
      .map((f) => path.join(patchDir, f));
    if (patchFiles.length === 0) fail(`patch 目录为空: ${patchDir}`);
  } else {
    patchFiles = opts.tasks.map((t) => path.join(patchDir, `${t}.patch`));
    for (const p of patchFiles) {
      if (!fs.existsSync(p)) fail(`patch 不存在: ${p}`);
    }
  }

  const lockPath = acquireLock(patchDir, opts.lockTimeout ?? 30000);
  const conflicts = new Set();
  const results = [];
  let keep = opts.keep;
  let tmp = null;

  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-back-integ-'));
    const added = git(repo, ['worktree', 'add', '-q', '--detach', tmp, base]);
    if (added.status !== 0) fail(`创建整合 worktree 失败: ${(added.stderr || '').trim()}`);

    for (const patch of patchFiles) {
      const applied = git(tmp, ['apply', '--3way', '--whitespace=nowarn', patch]);
      if (applied.status === 0) continue;

      const pending = unmergedPaths(tmp);
      if (pending.length > 0) {
        pending.forEach((p) => conflicts.add(p));
        continue;
      }
      const targets = patchTargets(patch);
      if (targets.some((t) => conflicts.has(t))) continue;
      keep = true;
      process.stderr.write(`merge-back: patch 无法应用 ${path.basename(patch)}\n`);
      process.stderr.write((applied.stderr || '').trim() + '\n');
      process.stderr.write(`merge-back: 主工作区未做任何修改；临时 worktree 保留在 ${tmp}\n`);
      process.exitCode = 2;
      return;
    }

    const diff = git(tmp, ['diff', '--name-status', '--no-renames', '-z', 'HEAD']).stdout || '';
    const entries = [];
    const tokens = diff.split('\0').filter(Boolean);
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const status = tokens[i];
      const file = tokens[i + 1];
      if (status === 'A' || status === 'M' || status === 'D' || status === 'T') entries.push(file);
    }
    for (const file of conflicts) {
      if (!entries.includes(file)) entries.push(file);
    }

    for (const file of entries) {
      const res = mergeIntoWorktree({ repo, tmp, base, file, conflicted: conflicts.has(file) });
      results.push(res);
    }

    const conflicting = results.filter((r) => r.action === 'conflict');
    if (opts.json) {
      process.stdout.write(JSON.stringify({ base, results, conflicts: conflicting.length }, null, 2) + '\n');
    } else {
      for (const r of results) {
        if (!r.file) continue;
        process.stdout.write(
          `${r.action.padEnd(9)} ${r.file}${r.detail ? `  (${r.detail})` : ''}\n`,
        );
      }
      const touched = results.filter((r) => r.file && r.action !== 'unchanged').length;
      process.stdout.write(
        `\n共 ${touched} 个文件，冲突 ${conflicting.length} 个。改动均为未提交状态。\n`,
      );
      if (conflicting.length > 0) {
        process.stdout.write('冲突文件含标记或 .theirs 副本，请在工作区解决后自行提交。\n');
      }
    }
    process.exitCode = conflicting.length > 0 ? 1 : 0;
  } finally {
    if (!keep && tmp !== null) {
      git(repo, ['worktree', 'remove', '--force', tmp]);
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
      git(repo, ['worktree', 'prune']);
    }
    fs.rmSync(lockPath, { force: true });
  }
}

try {
  main();
} catch (e) {
  if (e instanceof UserError) {
    process.stderr.write(`merge-back: ${e.message}\n`);
    process.exitCode = 2;
  } else {
    throw e;
  }
}
