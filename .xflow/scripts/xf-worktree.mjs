#!/usr/bin/env node

/**
 * xf-worktree — git worktree 编排（移植自 superpowers using-git-worktrees）
 *
 * 设计：内核仍假设单 worktree 内只有一份 change.yaml；并发由 worktree 物理隔离提供。
 *
 * Usage:
 *   node .xflow/scripts/xf-worktree.mjs --action detect
 *   node .xflow/scripts/xf-worktree.mjs --action ensure-ignore
 *   node .xflow/scripts/xf-worktree.mjs --action create --name CHG-20260715-xxx
 *   node .xflow/scripts/xf-worktree.mjs --action list
 *   node .xflow/scripts/xf-worktree.mjs --action write-registry
 *   node .xflow/scripts/xf-worktree.mjs --action check-mutex --modules a,b
 *   node .xflow/scripts/xf-worktree.mjs --action remove [--path <worktree>] [--force]
 *   node .xflow/scripts/xf-worktree.mjs --action finish-cleanup  # provenance cleanup
 */

import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { join, dirname, basename, resolve, relative, sep } from "node:path";
import {
  PROJECT_ROOT as LIB_PROJECT_ROOT,
  parseArgs,
  output,
  fatal,
  printUsageAndExit,
  handleHelpFlag,
  assertAllowedArgs,
  parseChangeYaml,
} from "./lib.mjs";
import { atomicWrite } from "./lib-lock.mjs";

const ALLOWED_ARGS = [
  "help",
  "action",
  "name",
  "branch",
  "path",
  "base",
  "modules",
  "force",
  "yes",
];

const USAGE = {
  usage: "node .xflow/scripts/xf-worktree.mjs --action <name> [选项]",
  description:
    "编排 git worktree，使每个 change 独占一个隔离检出。移植自 superpowers：\n" +
    "Detect state → Prefer native tools → git fallback → Provenance cleanup。",
  required: {
    "--action <name>":
      "detect | ensure-ignore | create | list | write-registry | check-mutex | remove | finish-cleanup | main-root",
  },
  optional: {
    "--name <id>": "change-id / 分支名 / 目录名（create 必填，默认三者同名）",
    "--branch <name>": "分支名（默认 = --name）",
    "--path <dir>": "worktree 路径（remove / finish-cleanup）",
    "--base <branch>": "分叉基线（默认探测 main/master）",
    "--modules <a,b>": "check-mutex：本变更 affected_modules",
    "--force": "remove / finish-cleanup 强制",
    "--help, -h": "打印帮助",
  },
  values: {
    "--action":
      "detect | ensure-ignore | create | list | write-registry | check-mutex | remove | finish-cleanup | main-root",
  },
  examples: [
    "node .xflow/scripts/xf-worktree.mjs --action detect",
    "node .xflow/scripts/xf-worktree.mjs --action create --name CHG-20260715-abc001",
    "node .xflow/scripts/xf-worktree.mjs --action list",
    "node .xflow/scripts/xf-worktree.mjs --action check-mutex --modules user-auth,payments",
    "node .xflow/scripts/xf-worktree.mjs --action finish-cleanup",
  ],
  notes: [
    "已在 linked worktree 时 create 会拒绝（防嵌套）",
    "create 前会 ensure-ignore：.worktrees/ 必须被 gitignore",
    "仅清理路径位于 .worktrees/ 或 worktrees/ 下的 worktree（provenance ownership）",
  ],
};

function git(args, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", opts.allowFail ? "pipe" : "pipe"],
    }).trim();
  } catch (err) {
    if (opts.allowFail) return null;
    const msg = err.stderr?.toString?.() || err.message;
    fatal(`git ${args.join(" ")} 失败: ${msg}`);
  }
}

function gitOk(args, opts = {}) {
  try {
    execFileSync("git", args, {
      cwd: opts.cwd ?? process.cwd(),
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** @returns {{ gitDir: string, gitCommon: string, branch: string, toplevel: string, isLinkedWorktree: boolean, isSubmodule: boolean }} */
function detectState(cwd = process.cwd()) {
  if (!gitOk(["rev-parse", "--is-inside-work-tree"], { cwd })) {
    fatal("当前目录不是 git 仓库");
  }
  const gitDirRaw = git(["rev-parse", "--git-dir"], { cwd });
  const gitCommonRaw = git(["rev-parse", "--git-common-dir"], { cwd });
  const gitDir = realpathSync(resolve(cwd, gitDirRaw));
  const gitCommon = realpathSync(resolve(cwd, gitCommonRaw));
  const toplevel = git(["rev-parse", "--show-toplevel"], { cwd });
  const branch = git(["branch", "--show-current"], { cwd, allowFail: true }) || "";
  const superproject = git(["rev-parse", "--show-superproject-working-tree"], {
    cwd,
    allowFail: true,
  });
  const isSubmodule = Boolean(superproject);
  const isLinkedWorktree = gitDir !== gitCommon && !isSubmodule;
  return { gitDir, gitCommon, branch, toplevel, isLinkedWorktree, isSubmodule };
}

function mainRepoRoot(cwd = process.cwd()) {
  const { gitCommon } = detectState(cwd);
  // git-common-dir 通常是 <main>/.git 或 worktree 指向的 common；取 common 的上层工作树
  const commonParent = dirname(gitCommon);
  // 当 common 是 <main>/.git → parent 是 main root
  // 当 common 是 <main>/.git（bare 风格）同样
  if (existsSync(join(commonParent, ".git")) || gitOk(["rev-parse", "--show-toplevel"], { cwd: commonParent })) {
    const top = git(["rev-parse", "--show-toplevel"], { cwd: commonParent, allowFail: true });
    if (top) return top;
  }
  // fallback: porcelain 里找主 worktree（通常第一条且 gitdir 不带 /worktrees/）
  const list = listWorktrees(cwd);
  const primary = list.find((w) => !w.gitdir.includes(`${sep}worktrees${sep}`)) || list[0];
  return primary?.path || commonParent;
}

function preferWorktreeLocation(mainRoot) {
  const hidden = join(mainRoot, ".worktrees");
  const plain = join(mainRoot, "worktrees");
  if (existsSync(hidden)) return { location: hidden, name: ".worktrees" };
  if (existsSync(plain)) return { location: plain, name: "worktrees" };
  return { location: hidden, name: ".worktrees" };
}

function isUnderOwnedLocation(worktreePath, mainRoot) {
  const abs = resolve(worktreePath);
  for (const name of [".worktrees", "worktrees"]) {
    const root = join(mainRoot, name);
    if (abs === root) return true;
    if (abs.startsWith(root + sep)) return true;
  }
  return false;
}

function ensureIgnored(mainRoot) {
  const { name } = preferWorktreeLocation(mainRoot);
  const already =
    gitOk(["check-ignore", "-q", name], { cwd: mainRoot }) ||
    gitOk(["check-ignore", "-q", ".worktrees"], { cwd: mainRoot }) ||
    gitOk(["check-ignore", "-q", "worktrees"], { cwd: mainRoot });

  if (already) {
    return { ignored: true, added: false, pattern: name };
  }

  const gitignore = join(mainRoot, ".gitignore");
  const patterns = ["", "# xflow concurrent worktrees (auto)", ".worktrees/", "worktrees/"];
  if (existsSync(gitignore)) {
    const cur = readFileSync(gitignore, "utf-8");
    if (!cur.split(/\r?\n/).some((l) => l.trim() === ".worktrees/" || l.trim() === ".worktrees")) {
      appendFileSync(gitignore, patterns.join("\n") + "\n");
    }
  } else {
    writeFileSync(gitignore, `.worktrees/\nworktrees/\n`);
  }
  return { ignored: true, added: true, pattern: ".worktrees/" };
}

function listWorktrees(cwd = process.cwd()) {
  const raw = git(["worktree", "list", "--porcelain"], { cwd, allowFail: true });
  if (!raw) return [];
  const items = [];
  let cur = {};
  for (const line of raw.split(/\r?\n/)) {
    if (line === "") {
      if (cur.path) items.push(cur);
      cur = {};
      continue;
    }
    if (line.startsWith("worktree ")) cur.path = line.slice("worktree ".length);
    else if (line.startsWith("HEAD ")) cur.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) cur.branch = line.slice("branch refs/heads/".length);
    else if (line === "detached") cur.detached = true;
    else if (line.startsWith("bare")) cur.bare = true;
  }
  if (cur.path) items.push(cur);
  // enrich gitdir
  for (const w of items) {
    const gd = git(["rev-parse", "--git-dir"], { cwd: w.path, allowFail: true });
    w.gitdir = gd ? resolve(w.path, gd) : "";
  }
  return items;
}

function readChangeAt(worktreePath) {
  // profile/group: xspec/<flow>/changes/change.yaml or xspec/changes/change.yaml
  const candidates = [];
  const xspec = join(worktreePath, "xspec");
  if (!existsSync(xspec)) return null;
  const direct = join(xspec, "changes", "change.yaml");
  if (existsSync(direct)) candidates.push(direct);
  try {
    for (const d of readdirSync(xspec, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = join(xspec, d.name, "changes", "change.yaml");
      if (existsSync(p)) candidates.push(p);
    }
  } catch {
    /* ignore */
  }
  if (candidates.length === 0) return null;
  try {
    const content = readFileSync(candidates[0], "utf-8");
    const parsed = parseChangeYaml(content);
    return {
      yaml_path: candidates[0],
      id: parsed.id,
      name: parsed.name,
      status: parsed.status,
      phase: parsed.phase,
      affected_modules: parsed.affected_modules || [],
    };
  } catch {
    return null;
  }
}

function detectBaseBranch(mainRoot) {
  for (const b of ["main", "master", "develop"]) {
    if (gitOk(["show-ref", "--verify", "--quiet", `refs/heads/${b}`], { cwd: mainRoot })) {
      return b;
    }
    if (gitOk(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${b}`], { cwd: mainRoot })) {
      return b;
    }
  }
  return "main";
}

async function actionDetect() {
  const state = detectState();
  const mainRoot = mainRepoRoot();
  output({
    success: true,
    action: "detect",
    ...state,
    main_root: mainRoot,
    owned_location: preferWorktreeLocation(mainRoot).name,
    message: state.isLinkedWorktree
      ? `已在隔离 worktree：${state.toplevel}（branch=${state.branch || "detached"}）`
      : `在主工作树：${state.toplevel}`,
  });
}

async function actionEnsureIgnore() {
  const mainRoot = mainRepoRoot();
  const result = ensureIgnored(mainRoot);
  output({
    success: true,
    action: "ensure-ignore",
    main_root: mainRoot,
    ...result,
    message: result.added
      ? `已将 ${result.pattern} 写入 .gitignore`
      : `${result.pattern} 已被 gitignore`,
  });
}

async function actionCreate(args) {
  const state = detectState();
  if (state.isLinkedWorktree) {
    fatal(
      `已在 linked worktree（${state.toplevel}），禁止嵌套创建。请在主工作树执行 create，或继续在此 worktree 开发。`,
    );
  }
  const name = args.name || args.branch;
  if (!name || typeof name !== "string") {
    printUsageAndExit(USAGE, "create 需要 --name <change-id>");
  }
  const branch = (args.branch && typeof args.branch === "string" ? args.branch : name);
  const mainRoot = mainRepoRoot();
  ensureIgnored(mainRoot);
  const { location } = preferWorktreeLocation(mainRoot);
  mkdirSync(location, { recursive: true });
  const path = join(location, name);
  if (existsSync(path)) {
    fatal(`worktree 路径已存在: ${path}`);
  }
  if (gitOk(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: mainRoot })) {
    fatal(`分支已存在: ${branch}。换一个 --name，或先删除/复用该分支。`);
  }
  const base = (args.base && typeof args.base === "string" ? args.base : detectBaseBranch(mainRoot));
  try {
    execFileSync("git", ["worktree", "add", path, "-b", branch, base], {
      cwd: mainRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const msg = err.stderr?.toString?.() || err.message;
    if (/Permission denied|Operation not permitted/i.test(msg)) {
      fatal(`sandbox/权限阻止创建 worktree：${msg}。请在本机终端手动执行，或于当前目录继续开发。`);
    }
    fatal(`git worktree add 失败: ${msg}`);
  }
  output({
    success: true,
    action: "create",
    path,
    branch,
    base,
    main_root: mainRoot,
    message: `Worktree ready at ${path} (branch ${branch} from ${base})`,
  });
}

function buildRegistry() {
  const mainRoot = mainRepoRoot();
  const worktrees = listWorktrees(mainRoot);
  const changes = [];
  for (const w of worktrees) {
    if (w.bare) continue;
    const change = readChangeAt(w.path);
    changes.push({
      path: w.path,
      branch: w.branch || null,
      head: w.head || null,
      detached: Boolean(w.detached),
      is_main: !w.gitdir.includes(`${sep}worktrees${sep}`),
      owned: isUnderOwnedLocation(w.path, mainRoot),
      change: change
        ? {
            id: change.id,
            name: change.name,
            phase: change.phase,
            status: change.status,
            affected_modules: (change.affected_modules || []).map((m) =>
              typeof m === "string" ? m : m.name,
            ),
            yaml_path: change.yaml_path,
          }
        : null,
    });
  }
  return {
    updated_at: new Date().toISOString(),
    main_root: mainRoot,
    git_common_dir: detectState(mainRoot).gitCommon,
    worktrees: changes,
  };
}

async function actionList() {
  const registry = buildRegistry();
  output({ success: true, action: "list", ...registry });
}

async function actionWriteRegistry() {
  const registry = buildRegistry();
  // 写到主仓 xspec/.worktrees.json（只读聚合，非事实源）
  const specCandidates = [
    join(registry.main_root, "xspec", ".worktrees.json"),
  ];
  // group 模式也可能有 flow 子目录，但仍用顶层 xspec/.worktrees.json
  const target = specCandidates[0];
  mkdirSync(dirname(target), { recursive: true });
  await atomicWrite(target, JSON.stringify(registry, null, 2) + "\n");
  output({
    success: true,
    action: "write-registry",
    registry_path: target,
    worktree_count: registry.worktrees.length,
    active_changes: registry.worktrees.filter((w) => w.change).length,
    message: `已写入 ${target}`,
  });
}

async function actionCheckMutex(args) {
  const modulesArg = args.modules;
  if (!modulesArg || typeof modulesArg !== "string") {
    printUsageAndExit(USAGE, "check-mutex 需要 --modules <a,b,c>");
  }
  const wanted = modulesArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const registry = buildRegistry();
  const currentTop = detectState().toplevel;
  const conflicts = [];
  for (const w of registry.worktrees) {
    if (!w.change) continue;
    // 跳过当前 worktree 自身
    if (resolve(w.path) === resolve(currentTop)) continue;
    const theirs = new Set(w.change.affected_modules || []);
    const overlap = wanted.filter((m) => theirs.has(m));
    if (overlap.length > 0) {
      conflicts.push({
        change_id: w.change.id,
        path: w.path,
        branch: w.branch,
        phase: w.change.phase,
        overlap,
      });
    }
  }
  const ok = conflicts.length === 0;
  output({
    success: ok,
    action: "check-mutex",
    ok,
    modules: wanted,
    conflicts,
    message: ok
      ? "模块互斥检查通过：与在途 change 无交叠"
      : `模块互斥冲突：${conflicts.map((c) => `${c.change_id}∩[${c.overlap.join(",")}]`).join("; ")}`,
  });
  if (!ok) process.exit(2);
}

async function actionRemove(args) {
  const state = detectState();
  const mainRoot = mainRepoRoot();
  const target =
    (args.path && typeof args.path === "string" ? args.path : null) ||
    (state.isLinkedWorktree ? state.toplevel : null);
  if (!target) fatal("remove 需要 --path，或在 linked worktree 内执行");
  if (!isUnderOwnedLocation(target, mainRoot) && !args.force) {
    fatal(
      `路径 ${target} 不在 .worktrees/ 或 worktrees/ 下，按 provenance 规则不清理（加 --force 可强制）`,
    );
  }
  // 必须在主仓执行 remove
  execFileSync("git", ["worktree", "remove", ...(args.force ? ["--force"] : []), target], {
    cwd: mainRoot,
    stdio: "inherit",
  });
  git(["worktree", "prune"], { cwd: mainRoot, allowFail: true });
  output({
    success: true,
    action: "remove",
    removed: target,
    main_root: mainRoot,
    message: `已移除 worktree ${target}`,
  });
}

async function actionFinishCleanup(args) {
  const state = detectState();
  const mainRoot = mainRepoRoot();
  if (!state.isLinkedWorktree) {
    output({
      success: true,
      action: "finish-cleanup",
      skipped: true,
      message: "当前在主工作树，无需 cleanup",
    });
    return;
  }
  if (!isUnderOwnedLocation(state.toplevel, mainRoot) && !args.force) {
    output({
      success: true,
      action: "finish-cleanup",
      skipped: true,
      message: `worktree ${state.toplevel} 非 xflow 创建（不在 .worktrees/），按 provenance 不清理`,
    });
    return;
  }
  const branch = state.branch;
  // 先回到主仓再 remove（CWD 安全）
  process.chdir(mainRoot);
  execFileSync("git", ["worktree", "remove", ...(args.force ? ["--force"] : []), state.toplevel], {
    cwd: mainRoot,
    stdio: "inherit",
  });
  git(["worktree", "prune"], { cwd: mainRoot, allowFail: true });
  if (branch && args.yes) {
    gitOk(["branch", "-d", branch], { cwd: mainRoot });
  }
  output({
    success: true,
    action: "finish-cleanup",
    removed: state.toplevel,
    branch: branch || null,
    branch_deleted: Boolean(branch && args.yes),
    message: `已清理 worktree；分支 ${branch || "(none)"} ${args.yes ? "已尝试 -d" : "保留（加 --yes 删除）"}`,
  });
}

async function actionMainRoot() {
  output({
    success: true,
    action: "main-root",
    main_root: mainRepoRoot(),
    git_common_dir: detectState().gitCommon,
    fingerprint: repoFingerprint(),
  });
}

export function repoFingerprint(cwd = process.cwd()) {
  try {
    const common = detectState(cwd).gitCommon;
    return createHash("sha1").update(common).digest("hex").slice(0, 6);
  } catch {
    return "local";
  }
}

async function main() {
  const args = parseArgs();
  handleHelpFlag(args, USAGE);
  assertAllowedArgs(args, ALLOWED_ARGS, USAGE);
  if (!args.action) printUsageAndExit(USAGE, "缺少 --action");

  switch (args.action) {
    case "detect":
      await actionDetect();
      break;
    case "ensure-ignore":
      await actionEnsureIgnore();
      break;
    case "create":
      await actionCreate(args);
      break;
    case "list":
      await actionList();
      break;
    case "write-registry":
      await actionWriteRegistry();
      break;
    case "check-mutex":
      await actionCheckMutex(args);
      break;
    case "remove":
      await actionRemove(args);
      break;
    case "finish-cleanup":
      await actionFinishCleanup(args);
      break;
    case "main-root":
      await actionMainRoot();
      break;
    default:
      printUsageAndExit(USAGE, `未知 --action "${args.action}"`);
  }
}

// 仅在直接执行时跑 main（被 archive 等 import fingerprint 时可复用）
const isDirect =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);

if (isDirect) {
  main().catch((err) => {
    console.error(`[xflow] Error: ${err.message}`);
    process.exit(1);
  });
}

// re-export helpers for xf-archive
export {
  detectState,
  mainRepoRoot,
  isUnderOwnedLocation,
  listWorktrees,
  readChangeAt,
  buildRegistry,
  detectBaseBranch,
};

// silence unused LIB_PROJECT_ROOT in lint-ish environments
void LIB_PROJECT_ROOT;
void execSync;
void basename;
