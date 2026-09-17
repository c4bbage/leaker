#!/usr/bin/env node

/**
 * xf-sdd-workspace — implement 阶段 scratch + progress 账本
 * 移植自 superpowers subagent-driven-development/scripts/sdd-workspace
 *
 * Usage:
 *   node .xflow/scripts/xf-sdd-workspace.mjs                 # 打印并确保 workspace 路径
 *   node .xflow/scripts/xf-sdd-workspace.mjs --action path
 *   node .xflow/scripts/xf-sdd-workspace.mjs --action append-progress --text "Task 1: complete (...)"
 *   node .xflow/scripts/xf-sdd-workspace.mjs --action read-progress
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseArgs,
  output,
  fatal,
  printUsageAndExit,
  handleHelpFlag,
  assertAllowedArgs,
} from "./lib.mjs";

const ALLOWED_ARGS = ["help", "action", "text"];

const USAGE = {
  usage: "node .xflow/scripts/xf-sdd-workspace.mjs [--action path|append-progress|read-progress]",
  description:
    "Ensure per-worktree SDD scratch dir (.xflow/sdd/) with self-ignoring .gitignore，\n" +
    "and manage progress.md ledger across compaction.",
  required: {},
  optional: {
    "--action <name>": "path（默认）| append-progress | read-progress",
    "--text <line>": "append-progress 时追加的一行",
    "--help, -h": "帮助",
  },
  values: { "--action": "path | append-progress | read-progress" },
  examples: [
    "node .xflow/scripts/xf-sdd-workspace.mjs",
    'node .xflow/scripts/xf-sdd-workspace.mjs --action append-progress --text "Task 1: complete"',
  ],
  notes: [
    "workspace 位于 <repo>/.xflow/sdd（每个 worktree 各自一份）",
    "自带 .gitignore=*，不污染 git status",
  ],
};

function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
    }).trim();
  } catch {
    fatal("当前目录不是 git 仓库");
  }
}

function ensureWorkspace() {
  const root = repoRoot();
  const dir = join(root, ".xflow", "sdd");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "*\n");
  return dir;
}

async function main() {
  const args = parseArgs();
  handleHelpFlag(args, USAGE);
  assertAllowedArgs(args, ALLOWED_ARGS, USAGE);
  const action = (args.action && typeof args.action === "string" ? args.action : "path");
  const dir = ensureWorkspace();
  const progressPath = join(dir, "progress.md");

  if (action === "path") {
    output({ success: true, action: "path", path: dir, progress_path: progressPath });
    return;
  }
  if (action === "read-progress") {
    const content = existsSync(progressPath) ? readFileSync(progressPath, "utf-8") : "";
    output({
      success: true,
      action: "read-progress",
      path: progressPath,
      content,
      exists: existsSync(progressPath),
    });
    return;
  }
  if (action === "append-progress") {
    if (!args.text || typeof args.text !== "string") {
      printUsageAndExit(USAGE, "append-progress 需要 --text");
    }
    const line = args.text.endsWith("\n") ? args.text : args.text + "\n";
    if (!existsSync(progressPath)) {
      writeFileSync(
        progressPath,
        "# xflow implement progress ledger\n# Tasks listed as complete are DONE — do not re-dispatch\n\n",
      );
    }
    appendFileSync(progressPath, line);
    output({ success: true, action: "append-progress", path: progressPath, appended: args.text });
    return;
  }
  printUsageAndExit(USAGE, `未知 --action "${action}"`);
}

main().catch((err) => {
  console.error(`[xflow] Error: ${err.message}`);
  process.exit(1);
});
