#!/usr/bin/env node
/**
 * xf-gate.mjs — Flow 门禁检查
 *
 * 从 .xflow/<flowName>/gates.json 读取门禁关系（由 xflow init 从 flow.yaml 生成）。
 * 脚本自动从 change.yaml 读取当前活跃 flow 定位 gates.json。
 *
 * 门禁审批检查：目标节点的前置门禁节点是否已审批 → 未审批则拦截
 *
 * phase 入口校验由 xf-check-phase.mjs 负责，结构校验由 xf-check-invariants.mjs 负责，
 * 三者各司其职、互不耦合。
 *
 * gates.json 格式：
 *   {
 *     "<nodeId>": {
 *       "requires": ["<nodeId>", "<flowName>:<nodeId>", ...]
 *     }
 *   }
 * requires 中无冒号的为同 flow 内依赖，有冒号的为跨 flow 依赖（<flowName>:<nodeId>）。
 *
 * 门禁记录由 xflow approve 写入 xspec/<flow>/changes/.gates/<nodeId>.json。
 *
 * 用法：  node .xflow/scripts/xf-gate.mjs --to <nodeId>
 * 输出：  { "pass": true } 或 { "pass": false, "reason": "..." }
 * 退出码：0 = 通过，1 = 未通过 / 参数错误
 *
 * 本文件同时导出纯函数 checkGates(requires, activeFlow)，供 xf-enter-node.mjs import 复用，
 * 门禁判定逻辑全仓库仅此一份（CLI 入口用 import.meta.url 守卫，被 import 时不执行）。
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve, dirname, relative } from "path";
import { fileURLToPath } from "url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");
const XFLOW_DIR = resolve(SCRIPT_DIR, "..");
const SPEC_ROOT = join(PROJECT_ROOT, "xspec");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) { console.log(USAGE); process.exit(0); }
  if (!args.to) { console.error("缺少 --to 参数\n\n" + USAGE); process.exit(1); }

  const targetId = String(args.to);
  const flowNameArg = typeof args.flow === "string" ? args.flow : null;

  // 从 --flow 参数或 change.yaml 读取当前活跃 flow
  const activeFlow = flowNameArg ?? readActiveFlow();

  if (!activeFlow) {
    console.error("无法确定当前活跃 Flow，请使用 --flow <flowName> 指定");
    process.exit(1);
  }

  // 读取 per-flow gates.json
  const GATES_PATH = join(XFLOW_DIR, activeFlow, "gates.json");
  const GATES = readGates(GATES_PATH);

  const gateDef = GATES ? GATES[targetId] : null;

  if (!gateDef) {
    // 无门禁定义，直接通过
    console.log(JSON.stringify({ pass: true }));
    process.exit(0);
  }

  const requires = gateDef.requires ?? [];

  // 门禁判定前，先 best-effort 从 Web 审核后端把已审批结果同步到本地 .gates。
  // 审核已迁移到 Web 端，本地不再跑 xflow approve/approve-new，故在此拉取回写。
  // 任何失败（缺模块 / 未登录 / 离线 / 超时）都静默跳过，绝不阻断门禁。
  await syncGatesBestEffort(requires, {
    specRoot: SPEC_ROOT,
    projectRoot: PROJECT_ROOT,
    activeFlow,
  });

  const result = checkGates(requires, activeFlow);
  console.log(JSON.stringify({ pass: result.pass, reason: result.reason ?? null }));
  process.exit(result.pass ? 0 : 1);
}

// ─── Web 审核结果同步（best-effort）─────────────────────────────────────────────

async function syncGatesBestEffort(requires, opts) {
  try {
    const mod = await import("./xf-sync-gates.mjs");
    if (mod && typeof mod.syncApprovedGates === "function") {
      await mod.syncApprovedGates(requires, opts);
    }
  } catch {
    // 缺 xf-sync-gates.mjs（旧项目未同步该脚本）或任何运行时错误：
    // 一律忽略，退回只读本地 .gates，绝不阻断门禁。
  }
}

// ─── 门禁检查（唯一实现，供 xf-enter-node.mjs import 复用）──────────────────────

/**
 * 逐个校验 requires 里声明的前置节点门禁，返回
 *   { pass, reason, checks: [{ id, status, approved, file, error? }] }
 * checks 供上层（xf-enter-node）展示"哪几个通过、哪个卡住"，比单一 reason 信息量更大。
 *
 * 语义：
 *   - 0 个前置门禁 → 直接放行。
 *   - 1 个前置门禁 → AND：该节点必须 approved（线性门禁照常拦）。
 *   - >1 个前置门禁 → 视为「二选一」替代入口（如 brainstorm / clarify 都指向 design）：OR，
 *     用户只走其中一条、另一条门禁文件天然不存在，只要有一条 approved 即放行
 *     （与 xf-check-phase「任一合法入口」对齐，避免"走了 brainstorm 已审批却因没走 clarify 被拦"的死结）。
 *
 * 参数 activeFlow 用于定位同 flow 门禁目录 xspec/<activeFlow>/changes/.gates/；
 * requires 中形如 <flow>:<node> 的跨 flow 依赖按其自身 flow 定位。
 * 参数 specRoot 默认取模块级 SPEC_ROOT（即 <projectRoot>/xspec），仅单测注入临时目录时才显式传。
 */
export function checkGates(requires, activeFlow, specRoot = SPEC_ROOT) {
  const checks = [];

  for (const predId of requires) {
    let gateDirPath;
    let nodeId;
    let displayId;

    if (predId.includes(":")) {
      const [flowPart, ...nodeParts] = predId.split(":");
      nodeId = nodeParts.join(":");
      displayId = predId;
      gateDirPath = join(specRoot, flowPart, "changes", ".gates");
    } else {
      nodeId = predId;
      displayId = predId;
      gateDirPath = join(specRoot, activeFlow, "changes", ".gates");
    }

    const gateFile = join(gateDirPath, `${nodeId}.json`);
    const relFile = relative(PROJECT_ROOT, gateFile) || gateFile;

    if (!existsSync(gateFile)) {
      checks.push({ id: displayId, status: "missing", approved: false, file: relFile });
      continue;
    }

    try {
      const rec = JSON.parse(readFileSync(gateFile, "utf-8"));
      checks.push({
        id: displayId,
        status: rec.status ?? "unknown",
        approved: rec.status === "approved",
        file: relFile,
      });
    } catch (err) {
      checks.push({
        id: displayId,
        status: "unreadable",
        approved: false,
        file: relFile,
        error: err.message,
      });
    }
  }

  // 无前置门禁要求 → 直接放行
  if (checks.length === 0) return { pass: true, reason: null, checks };

  // 多个前置门禁 = 二选一替代入口（OR）：任一 approved 即放行
  if (checks.length > 1) {
    if (checks.some((c) => c.approved)) return { pass: true, reason: null, checks };
    return {
      pass: false,
      reason: `替代入口门禁均未通过：${checks
        .map((c) => c.id)
        .join(" / ")} 需至少一个 approved，请执行 xflow approve`,
      checks,
    };
  }

  // 单个前置门禁 = 线性 AND：必须 approved
  const only = checks[0];
  if (only.approved) return { pass: true, reason: null, checks };
  const reason =
    only.status === "missing"
      ? `节点 "${only.id}" 尚未通过审批，请执行 xflow approve`
      : only.status === "unreadable"
        ? `读取门禁文件失败：${only.file}${only.error ? ` — ${only.error}` : ""}`
        : `节点 "${only.id}" 审批状态为 "${only.status}"，需要 "approved"`;
  return { pass: false, reason, checks };
}

// ─── 读取 gates.json ──────────────────────────────────────────────────────────

function readGates(gatesPath) {
  if (!existsSync(gatesPath)) return null;
  try {
    return JSON.parse(readFileSync(gatesPath, "utf-8"));
  } catch {
    return null;
  }
}

// ─── 从 change.yaml 读取当前活跃 flow ──────────────────────────────────────────

function readActiveFlow() {
  // 扫描所有 Flow 目录找有 change.yaml 的（per-flow 路径：xspec/<flow>/changes/change.yaml）
  if (existsSync(SPEC_ROOT)) {
    for (const dir of readdirSync(SPEC_ROOT)) {
      const candidate = join(SPEC_ROOT, dir, "changes", "change.yaml");
      if (existsSync(candidate)) {
        const flow = readFlowFieldFromYaml(candidate);
        if (flow) return flow;
      }
    }
  }
  // 降级：从 init.json 读取
  const initJsonPath = join(XFLOW_DIR, "init.json");
  if (existsSync(initJsonPath)) {
    try {
      const data = JSON.parse(readFileSync(initJsonPath, "utf-8"));
      if (data.mode === "flow" && typeof data.flow === "string") return data.flow;
    } catch { /* ignore */ }
  }
  return null;
}

function readFlowFieldFromYaml(yamlPath) {
  if (!existsSync(yamlPath)) return null;
  try {
    const content = readFileSync(yamlPath, "utf-8");
    for (const line of content.split(/\r?\n/)) {
      if (line.startsWith(" ") || line.startsWith("\t")) continue;
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx <= 0) continue;
      const key = trimmed.slice(0, colonIdx).trim();
      if (key !== "flow") continue;
      let value = trimmed.slice(colonIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value || null;
    }
  } catch { /* ignore */ }
  return null;
}

// ─── 参数解析 ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const r = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2), next = argv[i + 1];
      r[k] = next && !next.startsWith("-") ? (i++, next) : true;
    } else if (a.startsWith("-")) { r[a.slice(1)] = true; }
  }
  return r;
}

const USAGE = `xf-gate.mjs — Flow 门禁检查
用法：node .xflow/scripts/xf-gate.mjs --to <nodeId>
  --to <nodeId>   目标节点（即将进入的节点）
  --flow <name>   指定 Flow 名称（可选，默认从 change.yaml 读取）
  --help, -h      显示此帮助
门禁关系由 .xflow/<flowName>/gates.json 定义（xflow init 生成）
门禁记录存储在 xspec/<flow>/changes/.gates/<nodeId>.json`;

// ─── CLI 入口（仅直接运行时执行；被 xf-enter-node.mjs import 时不触发，避免副作用/process.exit）──
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  main().catch((err) => {
    console.error(`[xflow] Error: ${err.message}`);
    process.exit(1);
  });
}
