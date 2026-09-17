#!/usr/bin/env node

/**
 * xf-init — 初始化 xspec/ 数据目录结构
 *
 * Usage: node .xflow/scripts/xf-init.mjs
 *
 * Creates modules/, changes/, archive/ under xspec/ if not present.
 * If already initialized, reports current status.
 */

import {
  resolveFlowId,
  resolveSpecRoot,
  modulesDir,
  changesDir,
  archiveDir,
  exists,
  ensureDir,
  listDirs,
  output,
  parseArgs,
  printUsageAndExit,
  handleHelpFlag,
  assertAllowedArgs,
} from "./lib.mjs";
import { join } from "path";
import { writeFile } from "fs/promises";

const USAGE = {
  usage: "node .xflow/scripts/xf-init.mjs",
  description:
    "初始化 xspec/<flow>/ 数据目录结构，在其下创建 modules/、changes/、archive/。\n" +
    "已初始化时仅报告当前状态，不做任何写入。",
  required: {},
  optional: {
    "--help, -h": "打印本帮助并退出",
  },
  examples: ["node .xflow/scripts/xf-init.mjs"],
  notes: ["本脚本不接受其他参数；传入未知参数会直接报错"],
};

const ALLOWED_ARGS = ["help"];

async function main() {
  const args = parseArgs();
  handleHelpFlag(args, USAGE);
  assertAllowedArgs(args, ALLOWED_ARGS, USAGE);

  const flowId = resolveFlowId();
  const SPEC = resolveSpecRoot(flowId);
  const MODULES = modulesDir(flowId);
  const CHANGES = changesDir(flowId);
  const ARCHIVE = archiveDir(flowId);

  const alreadyInitialized = exists(MODULES);

  if (alreadyInitialized) {
    const modules = await listDirs(MODULES);
    const hasActiveChange = exists(join(CHANGES, "change.yaml"));
    const archives = await listDirs(ARCHIVE);

    output({
      success: true,
      action: "init",
      flow: flowId,
      already_initialized: true,
      modules,
      has_active_change: hasActiveChange,
      archive_count: archives.length,
      message: flowId
        ? `Flow "${flowId}" 已初始化。${modules.length} 个模块，${archives.length} 个归档${hasActiveChange ? "，1 个活跃变更" : ""}`
        : `项目已初始化。${modules.length} 个模块，${archives.length} 个归档${hasActiveChange ? "，1 个活跃变更" : ""}`,
    });
    return;
  }

  const created = [];

  for (const dir of [MODULES, CHANGES, ARCHIVE]) {
    await ensureDir(dir);
    const gitkeep = join(dir, ".gitkeep");
    if (!exists(gitkeep)) {
      await writeFile(gitkeep, "");
    }
    created.push(dir.replace(SPEC + "/", ""));
  }

  output({
    success: true,
    action: "init",
    flow: flowId,
    already_initialized: false,
    created,
    message: flowId ? `Flow "${flowId}" 初始化完成` : "项目初始化完成",
  });
}

main().catch((err) => {
  console.error(`[xflow] Error: ${err.message}`);
  process.exit(1);
});
