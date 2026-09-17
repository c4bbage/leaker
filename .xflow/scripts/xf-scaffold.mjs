#!/usr/bin/env node

/**
 * xf-scaffold — 从 .xflow/templates/ 复制骨架文件到 xspec/changes/<name>/
 *
 * Usage:
 *   node .xflow/scripts/xf-scaffold.mjs --module user-auth --type web-backend
 *
 * Options:
 *   --module  模块名称（必填）
 *   --type    模块类型，合法值见 CATALOG.yaml 或执行 xf-manifest.mjs --list-types（必填）
 *
 * 文件清单来源：.xflow/templates/CATALOG.yaml（SSOT）
 *   - 本脚本一次性复制该 module_type 下 CATALOG 注册的 required / optional 文件（不按 phase 过滤）
 *   - status: dynamic 的条目代表 SKILL / 外部工具运行时按需产出，xflow 不铺骨架，本脚本会跳过
 *   - 未在 CATALOG 注册的模板文件不会被复制，避免产生冗余
 *   - 若 --type 未在 CATALOG 中定义，自动回退到 _default 类型
 *   - 跳过目标路径已存在的文件（永不覆盖 AI 已填内容）
 *
 * 模板查找：对 CATALOG 清单中每个文件名，优先在 .xflow/templates/<resolved_type>/ 下查找；
 *          若该类型目录下缺失该模板，降级到 .xflow/templates/_default/ 查找；仍缺失则跳过并记录 warning。
 */

import { join } from "path";
import { existsSync } from "fs";
import { readdir, copyFile } from "fs/promises";
import {
  resolveFlowId,
  flowTemplatesDir,
  changesDir,
  ensureDir,
  output,
  fatal,
  parseArgs,
  printUsageAndExit,
  handleHelpFlag,
  assertAllowedArgs,
} from "./lib.mjs";
import { loadCatalog, buildManifest } from "./xf-manifest.mjs";

const VALID_CHANGE_TYPES = ["added", "modified"];
const ALLOWED_ARGS = ["help", "module", "type", "change-type"];

const USAGE = {
  usage:
    "node .xflow/scripts/xf-scaffold.mjs --module <name> --type <module-type> [--change-type added|modified]",
  description:
    "按 CATALOG.yaml 注册的文件清单从 .xflow/templates/<type>/ 复制骨架到\n" +
    "xspec/changes/<name>/。已存在的目标文件不会被覆盖。",
  required: {
    "--module <name>": "目标模块名（即 xspec/changes/ 下的子目录名）",
    "--type <module-type>": "模块类型，需在 CATALOG.yaml 中注册",
  },
  optional: {
    "--change-type <added|modified>":
      "默认 added。modified 模块走 delta 路径，本脚本会拒绝铺骨架（详见 notes）",
    "--help, -h": "打印本帮助并退出",
  },
  values: {
    "--type": "见 `node .xflow/scripts/xf-manifest.mjs --list-types`",
    "--change-type": VALID_CHANGE_TYPES.join(" | "),
  },
  examples: [
    "node .xflow/scripts/xf-scaffold.mjs --module user-auth --type web-backend",
    "node .xflow/scripts/xf-scaffold.mjs --module user-auth --type web-backend --change-type modified  # → no-op",
    "node .xflow/scripts/xf-scaffold.mjs --module activity --type xuanwu-activity",
  ],
  notes: [
    "未在 CATALOG.yaml 注册的 --type 会自动回退到 _default 类型",
    "已存在的目标文件永不覆盖（保护 AI 已填内容）",
    "运行前请确认 xspec/ 目录已初始化（首次执行 `node .xflow/scripts/xf-init.mjs`）",
    "--change-type modified：脚本不会铺任何骨架（modified 模块的 delta 文件由 AI 直接撰写；" +
      "完整基线在 xspec/modules/<name>/ 是只读的，不应在 changes/<name>/ 下出现完整 .md 副本）",
  ],
};

/**
 * Unregistered-but-existing fallback: 若 --type 未在 CATALOG.yaml 中注册，但
 * .xflow/templates/<type>/ 目录确实存在，则按旧行为"复制该目录下所有 *.md 文件"，
 * 以保持对自定义/实验性模板目录（如 xuanwu-activity）的向后兼容。
 * 同时 notes 中提示用户尽早补注册到 CATALOG.yaml 以获得完整的 phase/status 管理。
 */
async function legacyCopyAllMd(typeDir) {
  const entries = await readdir(typeDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name);
}

async function main() {
  const args = parseArgs();
  handleHelpFlag(args, USAGE);
  assertAllowedArgs(args, ALLOWED_ARGS, USAGE);

  if (!args.module) printUsageAndExit(USAGE, "缺少 --module 参数");
  if (!args.type) printUsageAndExit(USAGE, "缺少 --type 参数");

  const changeType = args["change-type"] || "added";
  if (!VALID_CHANGE_TYPES.includes(changeType)) {
    printUsageAndExit(
      USAGE,
      `--change-type 非法值 "${changeType}"，合法值：${VALID_CHANGE_TYPES.join(" | ")}`,
    );
  }

  // modified 模块：no-op 防御
  // 这是命令编排层（/xf-clarify、/xf-detail）误把 modified 当 added 跑 scaffold 时的兜底，
  // 避免在 changes/<module>/ 下出现完整 .md 副本与 *.delta.md 共存的歧义现象。
  // 真正的 delta 文件（spec.delta.md / hld.delta.md / ...）由命令编排层的 AI 直接撰写。
  if (changeType === "modified") {
    output({
      success: true,
      action: "scaffold-skip",
      module: args.module,
      type: args.type,
      change_type: changeType,
      created: [],
      skipped: [],
      missing: [],
      notes: [
        "modified 模块不铺骨架：delta 文件由命令编排层的 AI 直接撰写，" +
          "完整基线在 xspec/modules/<name>/ 是只读的。",
      ],
      message: `模块 ${args.module} 标记为 modified，已跳过骨架创建（这是预期行为，不是错误）`,
    });
    return;
  }

  const flowId = resolveFlowId();
  const catalog = await loadCatalog();
  const isRegistered = Boolean(catalog[args.type]);
  const typeDir = join(flowTemplatesDir(flowId), args.type);
  const typeDirExists = existsSync(typeDir);

  const destDir = join(changesDir(flowId), args.module);
  await ensureDir(destDir);

  const created = [];
  const skipped = [];
  const missing = [];
  const notes = [];
  let resolvedType;
  let fallbackUsed = false;

  if (!isRegistered && typeDirExists) {
    // ── Legacy path: type not in CATALOG but has a template directory ──
    resolvedType = args.type;
    const fileNames = await legacyCopyAllMd(typeDir);
    for (const fileName of fileNames) {
      const destPath = join(destDir, fileName);
      if (existsSync(destPath)) {
        skipped.push(fileName);
        continue;
      }
      await copyFile(join(typeDir, fileName), destPath);
      created.push(fileName);
    }
    notes.push(
      `类型 ${args.type} 未在 CATALOG.yaml 中注册但模板目录存在，已按遗留模式复制全部 .md 文件；建议尽快在 CATALOG.yaml 中补注册以启用 phase/status 管理`,
    );
  } else {
    // ── Standard path: use CATALOG.yaml via manifest ──
    const manifest = buildManifest({
      catalog,
      moduleType: args.type,
      phase: null,
      allPhases: true,
      changeType,
    });
    resolvedType = manifest.resolved_type;
    fallbackUsed = manifest.fallback_used;

    for (const fileEntry of manifest.files) {
      const fileName = fileEntry.name;

      // status: dynamic — SKILL / 外部工具运行时按需产出，xflow 不参与铺骨架。
      // 这类文件即便没有对应模板也不视为 missing。
      if (fileEntry.status === "dynamic") {
        continue;
      }

      const destPath = join(destDir, fileName);

      if (existsSync(destPath)) {
        skipped.push(fileName);
        continue;
      }

      const primary = join(flowTemplatesDir(flowId), manifest.resolved_type, fileName);
      const fallback = join(flowTemplatesDir(flowId), "_default", fileName);
      const src = existsSync(primary) ? primary : existsSync(fallback) ? fallback : null;

      if (!src) {
        missing.push(fileName);
        continue;
      }

      await copyFile(src, destPath);
      created.push(fileName);
    }

    if (fallbackUsed) {
      notes.push(`类型 ${args.type} 未在 CATALOG.yaml 中定义，已回退到 _default 模板集`);
    }
  }

  if (missing.length > 0) {
    notes.push(`以下文件在 CATALOG 中注册但模板不存在，已跳过：${missing.join(", ")}`);
  }

  output({
    success: missing.length === 0,
    action: "scaffold",
    module: args.module,
    type: args.type,
    resolved_type: resolvedType,
    fallback_used: fallbackUsed,
    dest: destDir,
    created,
    skipped,
    missing,
    notes,
    message: `模块 ${args.module} 骨架创建完成。新建 ${created.length} 个文件，跳过 ${skipped.length} 个已存在文件${notes.length ? "（" + notes.join("；") + "）" : ""}`,
  });
}

main().catch((err) => {
  console.error(`[xflow] Error: ${err.message}`);
  process.exit(1);
});
