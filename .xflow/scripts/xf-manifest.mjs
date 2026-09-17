#!/usr/bin/env node

/**
 * xf-manifest.mjs — 模块文件清单查询（CATALOG.yaml 消费入口）
 *
 * 作为 xflow 模板映射 SSOT 的查询接口，所有需要"某模块类型在某阶段该生成/读取哪些文件"的
 * 命令和脚本（detail/design/task/analyze/implement/archive/validate/scaffold）都通过此脚本查询。
 *
 * Usage:
 *   node .xflow/scripts/xf-manifest.mjs --module-type web-backend --phase detail
 *   node .xflow/scripts/xf-manifest.mjs --module-type ai-agent --all-phases
 *   node .xflow/scripts/xf-manifest.mjs --module-type web-frontend --phase detail --change-type modified
 *   node .xflow/scripts/xf-manifest.mjs --list-types
 *
 * Options:
 *   --module-type <t>   模块类型（web-backend / web-frontend / native-app / ai-agent / systems / 自定义）
 *   --phase <p>         过滤阶段：clarify / design / detail / task
 *   --all-phases        返回该类型所有阶段文件（与 --phase 互斥）
 *   --change-type <c>   added（默认，返回 *.md）或 modified（返回 *.delta.md）
 *   --list-types        列出 CATALOG.yaml 中所有已注册的 module_type（与其他选项互斥）
 *
 * Output (JSON):
 *   {
 *     "module_type": "web-backend",
 *     "resolved_type": "web-backend",   // 回退后实际使用的类型
 *     "fallback_used": false,           // 是否回退到 _default
 *     "phase": "detail",                // null 表示 all-phases
 *     "change_type": "added",
 *     "validations": {                  // 从 CATALOG.yaml 透传，供 xf-validate 消费
 *       "skip_required_sections": false
 *     },
 *     "required": ["design.md", "data-model.md", "contracts.md"],
 *     "optional": [],
 *     "dynamic":  [],                   // SKILL/外部工具运行时产出，scaffold 跳过、validate 不强制
 *     "files": [
 *       { "name": "design.md", "status": "required", "phase": "detail" },
 *       ...
 *     ]
 *   }
 *
 * Exit codes:
 *   0 = 成功
 *   1 = 参数错误 / CATALOG.yaml 缺失或格式错误 / 类型无法解析（且无 _default 回退）
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import {
  resolveFlowId,
  flowTemplatesDir,
  parseCatalogYaml,
  output,
  fatal,
  parseArgs,
  printUsageAndExit,
  handleHelpFlag,
  assertAllowedArgs,
} from "./lib.mjs";

const DEFAULT_TYPE = "_default";
const VALID_PHASES = ["clarify", "design", "detail", "task"];
const VALID_CHANGE_TYPES = ["added", "modified"];
const ALLOWED_ARGS = [
  "help",
  "list-types",
  "module-type",
  "phase",
  "all-phases",
  "change-type",
];

const USAGE = {
  usage:
    "node .xflow/scripts/xf-manifest.mjs (--list-types | --module-type <type> [--phase <p> | --all-phases] [--change-type <t>])",
  description:
    "查询 CATALOG.yaml 注册的模块类型与文件清单。AI 可据此动态决定该生成 / 校验哪些文件。",
  required: {
    "--list-types": "[模式 1] 列出所有已注册 module_type",
    "--module-type <type>": "[模式 2] 指定模块类型，输出对应的文件清单",
  },
  optional: {
    "--phase <stage>": "仅列出该阶段的文件（与 --all-phases 互斥）",
    "--all-phases": "列出所有阶段的文件（与 --phase 互斥）",
    "--change-type <t>": "added | modified，默认 added；modified 会把 .md 改名为 .delta.md",
    "--help, -h": "打印本帮助并退出",
  },
  values: {
    "--phase": VALID_PHASES.join(" | "),
    "--change-type": VALID_CHANGE_TYPES.join(" | "),
  },
  examples: [
    "node .xflow/scripts/xf-manifest.mjs --list-types",
    "node .xflow/scripts/xf-manifest.mjs --module-type web-backend --phase detail",
    "node .xflow/scripts/xf-manifest.mjs --module-type ai-agent --all-phases",
    "node .xflow/scripts/xf-manifest.mjs --module-type web-frontend --phase detail --change-type modified",
  ],
  notes: [
    "--list-types 与 --module-type 必须二选一",
    "--module-type 未注册时自动回退到 _default 类型（输出 fallback_used=true）",
    "若需查询某类型未在 CATALOG.yaml 中注册，请优先在 CATALOG.yaml 注册以启用 phase / status 管理",
  ],
};

async function loadCatalog() {
  const flowId = resolveFlowId();
  const catalogPath = join(flowTemplatesDir(flowId), "CATALOG.yaml");
  if (!existsSync(catalogPath)) {
    fatal(`CATALOG.yaml 不存在：${catalogPath}`);
  }
  const content = await readFile(catalogPath, "utf-8");
  try {
    return parseCatalogYaml(content);
  } catch (err) {
    fatal(`CATALOG.yaml 解析失败：${err.message}`);
  }
}

/**
 * Resolve a module_type against the catalog, falling back to _default when missing.
 * Returns { resolvedType, entry, fallbackUsed }.
 */
function resolveType(catalog, moduleType) {
  if (catalog[moduleType]) {
    return { resolvedType: moduleType, entry: catalog[moduleType], fallbackUsed: false };
  }
  if (catalog[DEFAULT_TYPE]) {
    return { resolvedType: DEFAULT_TYPE, entry: catalog[DEFAULT_TYPE], fallbackUsed: true };
  }
  fatal(`模块类型 "${moduleType}" 不存在，且 CATALOG.yaml 未定义 _default 回退`);
}

function normalizeFileName(name, changeType) {
  if (changeType !== "modified") return name;
  if (name.endsWith(".md")) return name.replace(/\.md$/, ".delta.md");
  return name;
}

/**
 * Build manifest for a given module type and optional phase filter.
 */
function buildManifest({ catalog, moduleType, phase, allPhases, changeType }) {
  const { resolvedType, entry, fallbackUsed } = resolveType(catalog, moduleType);
  const filesMap = entry.files || {};

  const files = [];
  for (const [name, meta] of Object.entries(filesMap)) {
    if (!meta || typeof meta !== "object") continue;
    const { status, phase: filePhase } = meta;
    if (!allPhases && phase && filePhase !== phase) continue;

    const outName = normalizeFileName(name, changeType);
    files.push({ name: outName, status, phase: filePhase });
  }

  const bucket = (s) => files.filter((f) => f.status === s).map((f) => f.name);

  return {
    module_type: moduleType,
    resolved_type: resolvedType,
    fallback_used: fallbackUsed,
    phase: allPhases ? null : phase || null,
    change_type: changeType,
    validations: normalizeValidations(entry.validations),
    required: bucket("required"),
    optional: bucket("optional"),
    dynamic: bucket("dynamic"),
    files,
  };
}

/**
 * Normalize the per-type validations block from CATALOG.yaml.
 *
 * The minimal YAML parser (parseCatalogYaml) returns scalar values as strings,
 * so "skip_required_sections: true" comes out as the string "true". We coerce
 * known boolean flags here so downstream consumers can do direct === true checks.
 */
function normalizeValidations(raw) {
  const out = { skip_required_sections: false };
  if (!raw || typeof raw !== "object") return out;
  if (raw.skip_required_sections !== undefined) {
    out.skip_required_sections = toBool(raw.skip_required_sections);
  }
  return out;
}

function toBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true";
  return Boolean(v);
}

async function main() {
  const args = parseArgs();
  handleHelpFlag(args, USAGE);
  assertAllowedArgs(args, ALLOWED_ARGS, USAGE);

  if (args["list-types"]) {
    const catalog = await loadCatalog();
    const types = Object.keys(catalog)
      .filter((t) => t !== DEFAULT_TYPE)
      .map((t) => ({ name: t, description: catalog[t].description || "" }));
    output({ types, fallback: DEFAULT_TYPE });
    return;
  }

  if (!args["module-type"]) {
    printUsageAndExit(USAGE, "缺少 --module-type 参数（或使用 --list-types 列出所有已注册类型）");
  }

  const phase = args.phase;
  const allPhases = Boolean(args["all-phases"]);
  const changeType = args["change-type"] || "added";

  if (phase && allPhases) {
    printUsageAndExit(USAGE, "--phase 与 --all-phases 互斥，请二选一");
  }
  if (phase && !VALID_PHASES.includes(phase)) {
    printUsageAndExit(USAGE, `--phase 非法值 "${phase}"，合法值：${VALID_PHASES.join(" | ")}`);
  }
  if (!VALID_CHANGE_TYPES.includes(changeType)) {
    printUsageAndExit(
      USAGE,
      `--change-type 非法值 "${changeType}"，合法值：${VALID_CHANGE_TYPES.join(" | ")}`,
    );
  }

  const catalog = await loadCatalog();
  const manifest = buildManifest({
    catalog,
    moduleType: args["module-type"],
    phase,
    allPhases,
    changeType,
  });

  output(manifest);
}

// Only run main() when invoked directly as a CLI (not when imported from another module).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error(`[xflow] Error: ${err.message}`);
    process.exit(1);
  });
}

// Exported for reuse by other scripts (validate/scaffold/archive) and tests.
export { loadCatalog, resolveType, buildManifest };
