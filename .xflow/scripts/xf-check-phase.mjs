#!/usr/bin/env node

/**
 * xf-check-phase — 校验当前 phase 是否为目标命令的合法入口（动态版 v2）
 *
 * 设计意图：xflow 的 phase 是单调向前推进的。每条命令都有"允许的入口 phase
 * 集合"，跑错了 phase 就该被立即挡下。
 *
 * 本脚本从 Flow.yaml 的节点拓扑（`after` 字段 = 父亲节点依赖）动态构建允许
 * 的 phase 映射，支持任意 Flow 配置，不硬编码任何命令名。
 *
 * 动态构建规则：
 *   allowed_phases[node] = transitive_ancestors(node) ∪ {node}
 *   + PHASE_NULL，当且仅当 node 没有 gate=true 的祖先（含间接传递）
 *
 * Usage:
 *   node .xflow/scripts/xf-check-phase.mjs --command <nodeId>          # 文本报告
 *   node .xflow/scripts/xf-check-phase.mjs --node <nodeId> [--json]  # JSON 报告
 *
 * Exit codes:
 *   0 = 合法（当前 phase 在目标命令的允许入口集合内）
 *   2 = 违规（与一般错误的 1 区分，方便 shell / CI 判断）
 *   1 = 脚本本身错误（参数错 / IO 失败 / 命令名不识别）
 *
 * 与 xf-current-change.mjs 的关系：本脚本通过 import 复用其 getCurrentChange()，
 * 不重复解析 change.yaml。phase=null 表示无活跃变更。
 */

import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";
import {
  output,
  parseArgs,
  printUsageAndExit,
  handleHelpFlag,
  assertAllowedArgs,
  loadFlowYaml,
  resolveFlowId,
  flowFrameworkRoot,
  nodeToPhase,
} from "./lib.mjs";
import { getCurrentChange } from "./xf-current-change.mjs";

const PHASE_NULL = "null";

function stripYamlQuotes(s) {
  if (!s) return s;
  return s.replace(/^["']|["']$/g, "");
}

// ══════════════════════════════════════════════════════════════════
//  Flow.yaml 节点拓扑解析
// ══════════════════════════════════════════════════════════════════

/**
 * 从 Flow.yaml 原始文本解析节点拓扑。
 *
 * 只提取 nodes 下的顶层列表项（`- id:` 在 2 空格缩进），忽略嵌套列表
 * （semanticRules、mechanicalChecks 等在更深缩进层的 `- id:`）。
 *
 * 返回: [{ id, after: string[], gate: boolean }]
 */
export function parseFlowYamlNodes(content) {
  const lines = content.split(/\r?\n/);
  const nodes = [];
  let current = null;
  let inNodes = false;
  let inAfter = false;
  let afterIndent = 0;

  for (const line of lines) {
    const stripped = line.trimEnd();

    if (/^nodes:/.test(stripped)) {
      inNodes = true;
      continue;
    }

    if (inNodes && /^\S/.test(stripped) && stripped && !stripped.startsWith("#")) {
      inNodes = false;
      if (current) nodes.push(current);
      current = null;
      continue;
    }

    if (!inNodes) continue;

    const nodeMatch = stripped.match(/^ {1,4}- id:\s*(\S+)/);
    if (nodeMatch) {
      if (current) nodes.push(current);
      current = { id: nodeMatch[1], after: [], gate: false };
      inAfter = false;
      continue;
    }

    if (!current) continue;

    const gateMatch = stripped.match(/^ {3,}\bgate:\s*(true|false)/);
    if (gateMatch) {
      current.gate = gateMatch[1] === "true";
      inAfter = false;
      continue;
    }

    const loopFromMatch = stripped.match(/^ {3,}\bloopFrom:\s*(\S+)/);
    if (loopFromMatch) {
      current.loopFrom = loopFromMatch[1].replace(/^["']|["']$/g, "");
      inAfter = false;
      continue;
    }

    const afterEmpty = stripped.match(/^ {3,}after:\s*\[\s*\]/);
    if (afterEmpty) {
      current.after = [];
      inAfter = false;
      continue;
    }

    const afterStart = stripped.match(/^ {3,}after:\s*$/);
    if (afterStart) {
      inAfter = true;
      afterIndent = stripped.indexOf("after:") + "after:".length;
      continue;
    }

    if (inAfter) {
      const itemMatch = stripped.match(/^ {4,}-\s+(\S+)/);
      if (itemMatch && stripped.search(/\S/) >= afterIndent - 4) {
        current.after.push(itemMatch[1]);
      } else if (stripped.trim() && !stripped.match(/^ {4,}#/)) {
        inAfter = false;
      }
    }
  }

  if (current) nodes.push(current);
  return nodes;
}

/**
 * 计算某节点的所有传递祖先（递归展开 after）。
 */
function getTransitiveAncestors(nodeId, afterMap, visited = new Set()) {
  if (visited.has(nodeId)) return new Set();
  visited.add(nodeId);
  const ancestors = new Set();
  for (const parent of (afterMap[nodeId] || [])) {
    ancestors.add(parent);
    for (const a of getTransitiveAncestors(parent, afterMap, visited)) {
      ancestors.add(a);
    }
  }
  return ancestors;
}

/**
 * 检查某节点是否有任何 gate=true 的传递祖先。
 */
function hasGatedAncestor(nodeId, afterMap, gateMap, visited = new Set()) {
  if (visited.has(nodeId)) return false;
  visited.add(nodeId);
  for (const parent of (afterMap[nodeId] || [])) {
    if (gateMap[parent]) return true;
    if (hasGatedAncestor(parent, afterMap, gateMap, visited)) return true;
  }
  return false;
}

/**
 * 构建动态 ALLOWED_PHASES 映射。
 *
 * Key: nodeId (Flow.yaml 中配置的节点 ID)
 * Value: allowed phase 字符串数组（使用 Flow.yaml 中配置的节点 ID）
 */
export function buildAllowedPhases(flowId) {
  const content = loadFlowYaml(flowId);
  if (!content) return null;

  const nodes = parseFlowYamlNodes(content);
  if (nodes.length === 0) return null;

  return computeAllowedPhases(nodes, flowId);
}

/**
 * 纯计算：从已解析的节点拓扑构建 ALLOWED_PHASES 映射（不读盘，便于单测）。
 *
 * @param {{id:string, after:string[], gate:boolean, loopFrom?:string}[]} nodes
 * @param {string|null} flowId
 */
export function computeAllowedPhases(nodes, flowId) {
  const afterMap = {};
  const gateMap = {};
  for (const n of nodes) {
    afterMap[n.id] = n.after || [];
    gateMap[n.id] = n.gate || false;
  }

  // 二选一替代入口兄弟：与 context-builder.isAltEntry / 门禁运行时「requires>1 即 OR」对齐。
  // 若某节点 S 的 after 有 >1 个前置、且这些前置全为门禁节点（如 design.after=[brainstorm,clarify]
  // 且二者皆 gate），则这些前置互为「替代入口」——用户任选其一执行即可。phase 校验必须让它们
  // 互相认账：处于 phase=brainstorm 时也能进入 clarify（横向切换替代项），反之亦然；否则会出现
  // 「同级两节点选了一个就再也进不了另一个」的死板拦截。要求「全为门禁节点」是为了排除
  // implement 那种 after=[task, analyze]（analyze 非门禁）的 AND 依赖，避免误判为替代。
  const altSiblings = {};
  for (const n of nodes) altSiblings[n.id] = new Set();
  for (const s of nodes) {
    const parents = afterMap[s.id] || [];
    if (parents.length > 1 && parents.every((p) => gateMap[p])) {
      for (const a of parents) {
        for (const b of parents) {
          if (a !== b) altSiblings[a]?.add(b);
        }
      }
    }
  }

  const result = {};

  for (const n of nodes) {
    const directParents = afterMap[n.id] || [];
    // canonical phase = 完整节点 ID（xf-split …，见 lib.writePhase）。这里把节点 ID 归一为
    // 短名后作为合法入口集合，仅用于「前缀无关」的稳健比对——currentPhase 读取时同样归一，
    // 因此既能匹配写准确的全 ID，也兜底历史遗留的短名 change.yaml。
    const entryIds = [
      ...directParents,
      n.id,
      ...(n.loopFrom ? [n.loopFrom] : []),
      ...altSiblings[n.id],
    ];
    const allowed = entryIds.map((id) => nodeToPhase(id, flowId));

    // PHASE_NULL（无活跃变更 = 全新起点）是否为合法入口，只取决于「有没有 gated 祖先」，
    // 与节点自身是否 gate=true 无关：gate=true 表示「本节点产出后有一道下游审批门」，
    // 而非「进入本节点需要前置审批」。brainstorm / clarify 这类入口节点自身常带下游门，
    // 但正常起点就是 phase=null；若因 gatedSelf 排除 null，全新项目将永远无法开启首个变更。
    const gatedAncestor = hasGatedAncestor(n.id, afterMap, gateMap);
    if (!gatedAncestor) {
      allowed.unshift(PHASE_NULL);
    }

    result[n.id] = [...new Set(allowed)];
  }

  return result;
}

// ══════════════════════════════════════════════════════════════════
//  ALLOWED_PHASES 懒加载（模块级缓存）
// ══════════════════════════════════════════════════════════════════

let _cachedPhases = null;

function _ensureCache() {
  if (_cachedPhases) return;
  try {
    const flowId = resolveFlowId();
    _cachedPhases = buildAllowedPhases(flowId);
  } catch {
    _cachedPhases = null;
  }
}

function getAllowedPhases() {
  _ensureCache();
  return _cachedPhases;
}

/**
 * 导出的 ALLOWED_PHASES：懒加载代理，支持测试直接 import。
 * 属性访问触发 Flow.yaml 解析（仅在部署环境下有效）。
 */
export const ALLOWED_PHASES = new Proxy({}, {
  get(_target, prop) {
    if (typeof prop === "symbol") return undefined;
    const phases = getAllowedPhases();
    return phases ? phases[prop] : undefined;
  },
  has(_target, prop) {
    const phases = getAllowedPhases();
    return phases ? prop in phases : false;
  },
  ownKeys() {
    const phases = getAllowedPhases();
    return phases ? Object.keys(phases) : [];
  },
  getOwnPropertyDescriptor(_target, prop) {
    const phases = getAllowedPhases();
    if (phases && prop in phases) {
      return { configurable: true, enumerable: true, value: phases[prop] };
    }
    return undefined;
  },
});

// ══════════════════════════════════════════════════════════════════
//  VALID_COMMANDS 也动态化
// ══════════════════════════════════════════════════════════════════

function getValidCommands() {
  const phases = getAllowedPhases();
  return phases ? Object.keys(phases) : [];
}

const ALLOWED_ARGS = ["help", "command", "node", "json", "flow"];

const USAGE = {
  usage: "node .xflow/scripts/xf-check-phase.mjs --command <name> [--json]\n" +
    "       node .xflow/scripts/xf-check-phase.mjs --node <nodeId> [--json]",
  description:
    "校验当前活跃变更的 phase 是否为目标命令的合法入口。\n" +
    "phase 映射从 Flow.yaml 的节点拓扑（after 字段）动态构建。\n" +
    "--node 接受完整节点 ID。",
  required: {
    "--command <name> 或 --node <nodeId>": "目标命令名或节点 ID",
  },
  optional: {
    "--json": "以 JSON 格式输出（默认输出文本报告）",
    "--help, -h": "打印本帮助并退出",
  },
  values: {
    "--command": "从 Flow.yaml 动态生成",
  },
  examples: [
    "node .xflow/scripts/xf-check-phase.mjs --command <nodeId>",
    "node .xflow/scripts/xf-check-phase.mjs --node <nodeId> --json",
  ],
  notes: [
    "退出码：0=合法，2=违规，1=脚本错误（与一般错误区分以便 shell / CI 判断）",
    "本脚本只读，不修改任何文件",
    "无活跃变更时 phase=null，对无门禁祖先的节点合法（即开新变更）",
    "也可作为函数库 import：assertCommandPhase(commandName) / renderPhaseViolation(violation)",
  ],
};

// ══════════════════════════════════════════════════════════════════
//  核心校验函数
// ══════════════════════════════════════════════════════════════════

/**
 * 校验 commandName 是否能在当前 phase 下执行。
 *
 * commandName 是 Flow.yaml 中配置的节点 ID。
 * 返回 { ok: true } 或 { ok: false, violation: { ... } }，不抛异常。
 */
export async function assertCommandPhase(commandName, opts = {}) {
  const phases = opts._phases || getAllowedPhases();

  // 比对在「前缀无关」命名空间进行：allowed 已归一为短名，这里把 change.yaml 读到的 phase
  // 也归一。canonical 值是全 ID（xf-clarify），归一后 == clarify == allowed；同时天然兜底
  // 历史遗留把 phase 存成短名（clarify）的 change.yaml。两种写法都能正确判定。
  let flowId = opts._flowId ?? null;
  if (flowId === null) {
    try {
      flowId = resolveFlowId();
    } catch {
      flowId = null;
    }
  }
  const readPhase = (change) =>
    nodeToPhase(
      change.active ? stripYamlQuotes(change.phase) || PHASE_NULL : PHASE_NULL,
      flowId,
    );

  if (!phases) {
    const change = await getCurrentChange();
    return {
      ok: true,
      command: commandName,
      current_phase: readPhase(change),
      change_id: change.id,
      note: "Flow.yaml 不可用，跳过 phase 校验",
    };
  }

  const allowed = phases[commandName];
  if (!allowed) {
    const change = await getCurrentChange();
    return {
      ok: true,
      command: commandName,
      current_phase: readPhase(change),
      change_id: change.id,
      note: "命令不在 Flow 拓扑中，无入口限制",
    };
  }

  const change = await getCurrentChange();
  const currentPhase = readPhase(change);

  if (allowed.includes(currentPhase)) {
    return {
      ok: true,
      command: commandName,
      current_phase: currentPhase,
      change_id: change.id,
      allowed_phases: allowed,
    };
  }

  return {
    ok: false,
    violation: {
      kind: "phase-mismatch",
      command: commandName,
      current_phase: currentPhase,
      allowed_phases: allowed,
      change: {
        active: change.active,
        id: change.id,
        name: change.name,
        phase: stripYamlQuotes(change.phase),
        affected_modules: change.affected_modules,
      },
    },
  };
}

// ══════════════════════════════════════════════════════════════════
//  报告渲染
// ══════════════════════════════════════════════════════════════════

/**
 * 渲染 violation 为多行人类可读字符串。
 */
export function renderPhaseViolation(violation) {
  if (violation.kind === "unknown-command") {
    return `❌ ${violation.message}`;
  }

  const { command, current_phase, allowed_phases, change } = violation;
  const lines = [];
  lines.push(`❌ phase 入口不合法：/${command} 不能在 phase="${current_phase}" 时执行。`);
  lines.push("");
  lines.push("当前状态：");
  if (change.active) {
    lines.push(`  - 活跃变更：${change.id}${change.name ? `（${change.name}）` : ""}`);
    lines.push(`  - 当前 phase：${change.phase}`);
    if (change.affected_modules && change.affected_modules.length > 0) {
      const moduleNames = change.affected_modules.map((m) => m.name).join(", ");
      lines.push(`  - 受影响模块：${moduleNames}`);
    }
  } else {
    lines.push("  - 无活跃变更");
  }
  lines.push("");
  const allowedDisplay = allowed_phases
    .map((p) => (p === PHASE_NULL ? "null（无活跃变更）" : p))
    .join(" / ");
  lines.push(`合法入口 phase：${allowedDisplay}`);

  // 无活跃变更（phase=null）却进了非入口节点：补一行本 Flow 的事实入口节点，
  // 让用户从正确的起点开始。这是从 Flow 图拓扑直接读出的事实（allowed 含 null 的节点），
  // 不是意图推测——与已移除的多分支「建议处理」引擎性质不同。
  if (current_phase === PHASE_NULL) {
    const phases = getAllowedPhases();
    const entryNodes = phases
      ? Object.keys(phases).filter((k) => phases[k]?.includes(PHASE_NULL))
      : [];
    if (entryNodes.length > 0) {
      lines.push("");
      lines.push(
        `当前无活跃变更，/${command} 不是本 Flow 的入口节点。` +
          `可作为起点的入口节点：${entryNodes.map((n) => `/${n}`).join("、")}`,
      );
    }
  }
  return lines.join("\n");
}

// ══════════════════════════════════════════════════════════════════
//  CLI 入口
// ══════════════════════════════════════════════════════════════════

async function main() {
  const args = parseArgs();
  handleHelpFlag(args, USAGE);
  assertAllowedArgs(args, ALLOWED_ARGS, USAGE);

  let commandName = typeof args.command === "string" ? args.command : null;
  const nodeArg = typeof args.node === "string" ? args.node : null;

  if (!commandName && !nodeArg) {
    printUsageAndExit(USAGE, "缺少 --command 或 --node 参数");
  }

  if (!commandName && nodeArg) {
    commandName = nodeArg;
  }

  const result = await assertCommandPhase(commandName);

  if (args.json) {
    output(result);
  } else if (result.ok) {
    console.log(
      `✓ phase=${result.current_phase} 是 ${result.command} 命令的合法入口`,
    );
  } else {
    console.log(renderPhaseViolation(result.violation));
  }

  if (result.ok) process.exit(0);
  process.exit(2);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error(`[xflow] Error: ${err.message}`);
    process.exit(1);
  });
}
