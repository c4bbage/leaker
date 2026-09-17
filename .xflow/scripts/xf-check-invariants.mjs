#!/usr/bin/env node

/**
 * xf-check-invariants — 校验 xspec/changes/ 结构不变量
 *
 * 设计意图：xflow 同一时间只允许一个活跃变更，结构上有几条死规矩。每个 /xf-*
 * 命令在"前置条件"段落（先于方言加载）调用本脚本，违反则整条命令立即终止，
 * 不允许 agent 在脏状态下继续叠加新动作。
 *
 * 这是事故防御的"物理硬层"——CLAUDE.md 全局禁令是说服层（agent 可能不读 / 读了
 * 不照做），不变量校验是脚本层（命令必经，逃不掉）。
 *
 * Usage:
 *   node .xflow/scripts/xf-check-invariants.mjs           # 文本报告（人类可读）
 *   node .xflow/scripts/xf-check-invariants.mjs --json    # JSON 报告（机器可读）
 *
 * Exit codes:
 *   0 = 结构合法（通过 / changes/ 干净 / 无活跃变更）
 *   2 = 检测到违规（与一般错误的 1 区分，方便 shell / CI 判断）
 *   1 = 脚本本身错误（参数错 / IO 失败）
 *
 * 也可以作为函数库被其他脚本 import：
 *   import { assertChangesInvariant, renderViolations } from "./xf-check-invariants.mjs";
 *
 * 不变量：
 *   规则 1 — changes/ 至多一个 yaml 文件，且必须命名为 change.yaml
 *           （禁止 change-XXX.yaml / change.backup.yaml 等"重命名当备份"反模式）
 *           顺带检查根目录非法 .md 文件（split/backup 残留等）
 *   规则 2 — changes/ 下的模块子目录集合 ⊆ change.yaml.affected_modules.name 集合
 *           （只查"多余目录"，不查"缺失目录"——AI 尚未创建工作区是合法状态）
 *   规则 3 — 任何 changes/<module>/ARCHIVE.md 都视为残留（archive 半途而废产物）
 */

import { join } from "path";
import { readdir } from "fs/promises";
import { existsSync } from "fs";
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

const USAGE = {
  usage: "node .xflow/scripts/xf-check-invariants.mjs [--json]",
  description:
    "校验 xspec/changes/ 结构是否合法：单 yaml 命名、目录与 affected_modules 一致、\n" +
    "无归档中间文件残留。所有 /xf-* 命令的前置条件都该调用本脚本。",
  required: {},
  optional: {
    "--json": "以 JSON 格式输出（默认输出文本报告）",
    "--help, -h": "打印本帮助并退出",
  },
  examples: [
    "node .xflow/scripts/xf-check-invariants.mjs",
    "node .xflow/scripts/xf-check-invariants.mjs --json",
  ],
  notes: [
    "退出码：0=合法，2=违规，1=脚本错误（与一般错误区分以便 shell / CI 判断）",
    "本脚本只读，不修改任何文件——修复要么人工，要么交给具体修复命令",
    "无活跃变更（changes/ 干净）也算合法，退出 0",
    "也可作为函数库 import：assertChangesInvariant() / renderViolations()",
  ],
};

const ALLOWED_ARGS = ["help", "json"];

const CHANGES_ALLOWED_ROOT_FILES = new Set([
  ".gitkeep",
  "change.yaml",
  // 以下是合法的可选根级 .md 文件（命令产出）
  "brainstorm.md",
  "integration.md",
  "changelog.md",
  "fix.md",
]);

const CHANGES_ALLOWED_ROOT_DIRS = new Set([
  ".gates", // 阶段门禁审批记录
  ".security", // 安全扫描报告（xf-security-scan.mjs 产出；author: cuiguangyu@bianfeng.com）
]);

/**
 * 扫描 xspec/changes/ 检测结构违规。返回 violations 列表（空数组 = 合法）。
 *
 * 这是只读扫描，不抛错也不写文件。调用方收到 violations 后决定是终止还是继续。
 *
 * 返回每条 violation 形如：
 *   { rule: 1|2|3, title, evidence: [string], suggestion }
 */
export async function assertChangesInvariant() {
  const violations = [];
  const flowId = resolveFlowId();
  const CHANGES_DIR = changesDir(flowId);
  if (!existsSync(CHANGES_DIR)) {
    // 项目尚未初始化（xspec/changes/ 目录都没建）—— 不算违反，让 xf-init 自己处理。
    return violations;
  }

  const entries = await readdir(CHANGES_DIR, { withFileTypes: true });
  const rootFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
  const rootDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  // ── 规则 1：单 yaml 命名 ──
  const yamlFiles = rootFiles.filter((n) => n.endsWith(".yaml") || n.endsWith(".yml"));
  const illegalYamls = yamlFiles.filter((n) => n !== "change.yaml");
  if (illegalYamls.length > 0) {
    violations.push({
      rule: 1,
      title: "存在多余的 change-*.yaml 文件（changes/ 仅允许 change.yaml）",
      evidence: illegalYamls.sort(),
      suggestion:
        "每份多余 yaml 通常代表一份未归档的历史变更。逐一确认其状态：\n" +
        "  - 已完成 → 通过 /xf-archive 流程归档（注：本工具不会自动搬运）\n" +
        "  - 已废弃 → 手动删除并在 modules/CHANGELOG.md 备注\n" +
        "  - 还没做完 → 暂存到仓库外，跑完当前活跃变更后再恢复",
    });
  }

  // 顺便扫一下根目录下的非法 .md 文件（已废弃的 split/backup 残留等）
  const illegalRootFiles = rootFiles.filter(
    (n) => !CHANGES_ALLOWED_ROOT_FILES.has(n) && !n.endsWith(".yaml") && !n.endsWith(".yml"),
  );
  if (illegalRootFiles.length > 0) {
    violations.push({
      rule: 1,
      title: "changes/ 根目录存在未识别的文件",
      evidence: illegalRootFiles.sort(),
      suggestion:
        "changes/ 根目录合法的文件仅有：change.yaml / brainstorm.md / integration.md / changelog.md。\n" +
        "其他文件多为 split / backup / 临时研究稿等残留，请：\n" +
        "  - 仍需保留 → 移到模块子目录或仓库外\n" +
        "  - 不再需要 → 直接删除",
    });
  }

  // ── 规则 2：模块子目录集合 ⊆ affected_modules ──
  const moduleDirs = rootDirs.filter((n) => !CHANGES_ALLOWED_ROOT_DIRS.has(n));
  const change = await readChangeYaml(flowId);
  const declaredModules = new Set(
    (change?.affected_modules || []).map((m) => m.name).filter(Boolean),
  );

  if (change && declaredModules.size > 0) {
    const orphanDirs = moduleDirs.filter((d) => !declaredModules.has(d));
    if (orphanDirs.length > 0) {
      violations.push({
        rule: 2,
        title: "存在未声明的模块工作区（孤儿目录）",
        evidence: orphanDirs.sort(),
        suggestion:
          `change.yaml.affected_modules 只声明了：[${[...declaredModules].join(", ")}]\n` +
          "上面这些孤儿目录通常是历史变更未归档残留。逐个确认：\n" +
          "  - 应归档 → 通过 /xf-archive 处理（需先有对应的 change.yaml）\n" +
          "  - 已废弃 → 直接删除\n" +
          "  - 是当前变更应该有的 → 把模块名加到 change.yaml.affected_modules",
      });
    }
  } else if (!change && moduleDirs.length > 0) {
    // 没有 change.yaml 但有模块目录——也是非法状态（孤魂野鬼）
    violations.push({
      rule: 2,
      title: "存在模块工作区但无 change.yaml",
      evidence: moduleDirs.sort(),
      suggestion:
        "changes/ 下出现模块目录但根目录没有 change.yaml 声明。这通常是上一个变更被误删 yaml 后的残留。\n" +
        "  - 内容仍需要 → 创建合规的 change.yaml 并把模块名补进 affected_modules\n" +
        "  - 已废弃 → 直接删除这些目录",
    });
  }

  // ── 规则 3：无 ARCHIVE.md 残留 ──
  for (const dir of moduleDirs) {
    if (existsSync(join(CHANGES_DIR, dir, "ARCHIVE.md"))) {
      violations.push({
        rule: 3,
        title: `检测到归档中间文件残留：${dir}/ARCHIVE.md`,
        evidence: [`${dir}/ARCHIVE.md`],
        suggestion:
          "上次 /xf-archive 执行被打断，留下了中间产物。\n" +
          "  - 重跑 /xf-archive 让它走完整流程，archive 完成后会自动清场\n" +
          "  - 或人工删除该 ARCHIVE.md 后重试",
      });
    }
  }

  return violations;
}

/**
 * 渲染 violations 为多行人类可读字符串（供 CLI 输出 / 命令终止报告）。
 *
 * 输出形如：
 *   ❌ xspec/changes/ 状态不合法，命令终止。
 *
 *   违反不变量（共 N 条）：
 *
 *   [规则 1] <title>
 *     证据：file-a, file-b, file-c
 *     建议：<multi-line suggestion>
 *
 *   [规则 2] ...
 */
export function renderViolations(violations) {
  if (!violations || violations.length === 0) {
    return "✓ xspec/changes/ 结构合法。";
  }
  const lines = [];
  lines.push("❌ xspec/changes/ 状态不合法，命令终止。");
  lines.push("");
  lines.push(`违反不变量（共 ${violations.length} 条）：`);
  for (const v of violations) {
    lines.push("");
    lines.push(`[规则 ${v.rule}] ${v.title}`);
    if (v.evidence && v.evidence.length > 0) {
      lines.push(`  证据：${v.evidence.join(", ")}`);
    }
    if (v.suggestion) {
      lines.push("  建议：");
      for (const ln of v.suggestion.split("\n")) lines.push(`    ${ln}`);
    }
  }
  lines.push("");
  lines.push("修复后重试。如需协助，把上面这份报告贴给 AI 助手讨论修复路径。");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs();
  handleHelpFlag(args, USAGE);
  assertAllowedArgs(args, ALLOWED_ARGS, USAGE);

  const violations = await assertChangesInvariant();
  const ok = violations.length === 0;

  if (args.json) {
    output({
      ok,
      violations_count: violations.length,
      violations,
    });
  } else {
    console.log(renderViolations(violations));
  }

  process.exit(ok ? 0 : 2);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error(`[xflow] Error: ${err.message}`);
    process.exit(1);
  });
}
