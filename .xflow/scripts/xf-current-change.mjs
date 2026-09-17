#!/usr/bin/env node

/**
 * xf-current-change — 查询当前活跃变更状态（事实来源）
 *
 * 设计意图：所有 /xf-* 命令、CLI、自动化脚本、不变量校验都通过本脚本统一获取
 * "当前 changes/ 是否有活跃变更，活跃的话 id/phase/status/affected_modules
 * 是什么" 的事实。任何地方禁止自行 ls + grep / 散点解析 change.yaml。
 *
 * Usage:
 *   node .xflow/scripts/xf-current-change.mjs                  # 完整 JSON
 *   node .xflow/scripts/xf-current-change.mjs --field active   # true / false
 *   node .xflow/scripts/xf-current-change.mjs --field id       # 仅 id
 *   node .xflow/scripts/xf-current-change.mjs --field phase    # 仅 phase
 *   node .xflow/scripts/xf-current-change.mjs --field status   # 仅 status
 *
 * Output (default JSON):
 *   {
 *     "active": true,
 *     "id": "CHG-20260506-001",
 *     "name": "用户管理后台",
 *     "status": "in-progress",
 *     "phase": "detail",
 *     "affected_modules": [
 *       { "name": "admin-api", "change_type": "modified", "module_type": "web-backend" },
 *       ...
 *     ],
 *     "yaml_path": "xspec/changes/change.yaml"
 *   }
 *
 *   active=false 时：{ "active": false, "id": null, ..., "yaml_path": null }
 *
 * Exit codes:
 *   0 = 成功（active=true / false 都算成功；本脚本不对结构合法性做判断，
 *           那是 assertChangesInvariant() 的工作）
 *   1 = 参数错误 / change.yaml 解析失败
 */

import { join } from "path";
import { fileURLToPath } from "url";
import {
  resolveFlowId,
  changesDir,
  readChangeYaml,
  output,
  parseArgs,
  printUsageAndExit,
  handleHelpFlag,
  assertAllowedArgs,
} from "./lib.mjs";

const VALID_FIELDS = ["active", "id", "name", "status", "phase"];
const ALLOWED_ARGS = ["help", "field"];

const USAGE = {
  usage: "node .xflow/scripts/xf-current-change.mjs [--field <name>]",
  description:
    "查询 xspec/changes/change.yaml 的当前活跃变更状态。无活跃变更时 active=false。\n" +
    "所有需要 \"当前 phase / id / 受影响模块\" 的命令、CLI、校验都从这里取，避免散点解析。",
  required: {},
  optional: {
    "--field <name>": "仅输出该字段值（合法值见 values）",
    "--help, -h": "打印本帮助并退出",
  },
  values: {
    "--field": VALID_FIELDS.join(" | "),
  },
  examples: [
    "node .xflow/scripts/xf-current-change.mjs",
    "node .xflow/scripts/xf-current-change.mjs --field phase",
    "node .xflow/scripts/xf-current-change.mjs --field active  # → true / false",
  ],
  notes: [
    "无活跃变更（changes/change.yaml 不存在）时，active=false，其他字段为 null",
    "--field 输出裸值（不带 JSON 引号）：active 给 true|false；其余字段给字符串或空",
    "本脚本只查询，不做合法性判断（多 yaml 共存等结构性违规由 assertChangesInvariant() 负责）",
  ],
};

/**
 * 计算当前活跃变更状态（供脚本主流程和其他模块复用）。
 *
 * 注意 yaml_path 输出绝对路径——下游消费者（如 CLI、报告生成）要展示给人看时
 * 自行截短，避免本函数臆测 cwd。
 */
export async function getCurrentChange() {
  const flowId = resolveFlowId();
  const CHANGES = changesDir(flowId);
  const yamlPath = join(CHANGES, "change.yaml");
  const change = await readChangeYaml(flowId);
  if (!change) {
    return {
      active: false,
      id: null,
      name: null,
      status: null,
      phase: null,
      affected_modules: [],
      yaml_path: null,
    };
  }
  return {
    active: true,
    id: change.id || null,
    name: change.name || null,
    status: change.status || null,
    phase: change.phase || null,
    affected_modules: (change.affected_modules || []).map((m) => ({
      name: m.name,
      change_type: m.change_type || null,
      module_type: m.module_type || null,
    })),
    yaml_path: yamlPath,
  };
}

async function main() {
  const args = parseArgs();
  handleHelpFlag(args, USAGE);
  assertAllowedArgs(args, ALLOWED_ARGS, USAGE);

  const field = args.field;
  if (field !== undefined && field !== true && !VALID_FIELDS.includes(field)) {
    printUsageAndExit(
      USAGE,
      `--field 非法值 "${field}"，合法值：${VALID_FIELDS.join(" | ")}`,
    );
  }
  if (field === true) {
    printUsageAndExit(USAGE, "--field 后面必须跟字段名");
  }

  const result = await getCurrentChange();

  if (field) {
    // 单字段输出裸值，方便 shell 直接 $(...) 取用。
    // 数组/对象仍走 JSON.stringify 保证可解析；标量直接打印。
    const v = result[field];
    if (Array.isArray(v) || (v !== null && typeof v === "object")) {
      console.log(JSON.stringify(v));
    } else {
      console.log(v === null ? "" : String(v));
    }
    return;
  }

  output(result);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error(`[xflow] Error: ${err.message}`);
    process.exit(1);
  });
}
