#!/usr/bin/env node
/**
 * xf-sync-gates.mjs — 从 web 审核后端拉取审批结果，回写本地 .gates/<nodeId>.json
 *
 * 背景：审核已迁移到 Web 端（xflow-admin）。产物由 audit 插件自动 live-push 到后端，
 * 审核员在网页上通过/驳回。但本地门禁（xf-gate.mjs）只认本地
 * xspec/<flow>/changes/.gates/<nodeId>.json。以前这个文件由 `xflow approve` 或
 * `xflow approve-new` 的轮询回写；现在流程不跑这些命令，于是 web 批了、本地却不知道。
 *
 * 本脚本补上"拉取回写"这一环：在门禁检查前，主动向后端查询目标门禁节点的审批结果，
 * 满足严格身份校验后写本地 .gates 文件。
 *
 * ⚠️ 安全底线（防"接口乱掉"/误放门禁）：
 *   后端 GateReview 的唯一键是 (flowName, nodeId, changeId)，**不含项目维度**，
 *   而 changeId 是 change.yaml 里人工/agent 撰写的、可被修改、且不保证全局唯一。
 *   因此绝不能只凭 changeId 就采信一条 approved 记录。写本地门禁**必须同时满足**：
 *     1. status === "approved"
 *     2. pCName === 本机 hostname()            —— 环境派生，change.yaml 改不了
 *     3. normalize(projectPath) === 本地项目根 —— 环境派生，change.yaml 改不了
 *     4. changeId === 本地 change.yaml 的 id   —— 一致性校验，改了就查不到/不写
 *   任一不满足 / 查不到 / 未登录 / 网络失败 / 超时 —— 一律**静默跳过**，
 *   退回只读本地已有 .gates（离线也能用之前本地审批写的文件），**绝不阻断、绝不误写**。
 *
 * 用法（供 xf-gate.mjs 动态引入，也可独立运行）：
 *   node .xflow/scripts/xf-sync-gates.mjs --to <nodeId> [--flow <name>]
 *
 * 退出码：始终 0（best-effort，不作为门禁结论）。
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { realpathSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir, hostname } from "os";

const REQUEST_TIMEOUT_MS = 4000;

/**
 * 从 ~/.xflow-cli/config.json 读取登录态。与插件端 live-push.ts 保持一致。
 * @returns {{ token: string, backendUrl: string } | null}
 */
function readCliAuth() {
  const configPath = join(homedir(), ".xflow-cli", "config.json");
  if (!existsSync(configPath)) return null;
  try {
    const data = JSON.parse(readFileSync(configPath, "utf-8"));
    const token = data?.auth?.token;
    const backendUrl = data?.auth?.backend_url;
    if (typeof token === "string" && token && typeof backendUrl === "string" && backendUrl) {
      return { token, backendUrl };
    }
    return null;
  } catch {
    return null;
  }
}

function apiBase(backendUrl) {
  const trimmed = String(backendUrl).replace(/\/+$/, "");
  return trimmed.endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`;
}

/** 读取 change.yaml 顶层标量字段（id / flow 等）。不存在 / 解析失败返回 null。 */
function readTopLevelScalar(yamlPath, key) {
  if (!existsSync(yamlPath)) return null;
  try {
    const content = readFileSync(yamlPath, "utf-8");
    for (const line of content.split(/\r?\n/)) {
      if (line.startsWith(" ") || line.startsWith("\t")) continue;
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx <= 0) continue;
      const k = trimmed.slice(0, colonIdx).trim();
      if (k !== key) continue;
      let value = trimmed.slice(colonIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 归一化路径用于跨来源比较：能 realpath 就 realpath，否则用 resolve。 */
function normalizePath(p) {
  if (!p) return "";
  try {
    if (existsSync(p)) return realpathSync(p);
  } catch {
    /* fall through */
  }
  try {
    return resolve(p);
  } catch {
    return String(p);
  }
}

/** 本地门禁是否已 approved（已通过则无需再拉，省一次网络请求）。 */
function localGateApproved(gatesDir, nodeId) {
  const f = join(gatesDir, `${nodeId}.json`);
  if (!existsSync(f)) return false;
  try {
    return JSON.parse(readFileSync(f, "utf-8")).status === "approved";
  } catch {
    return false;
  }
}

async function fetchActiveReview(auth, flowName, nodeId, changeId) {
  const url =
    `${apiBase(auth.backendUrl)}/gate-reviews/active/` +
    `${encodeURIComponent(flowName)}/${encodeURIComponent(nodeId)}/${encodeURIComponent(changeId)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${auth.token}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    // 后端统一包装 { code, data, message }；取 .data
    const data = json && typeof json === "object" && "data" in json ? json.data : json;
    if (!data || !data.id) return null;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取并（在严格身份校验通过后）回写单个门禁节点。
 * @returns {"written" | "skipped"}
 */
async function syncOneNode(ctx, targetFlow, nodeId) {
  const { specRoot, projectRoot, auth, pCName } = ctx;

  const flowChangesDir = join(specRoot, targetFlow, "changes");
  const gatesDir = join(flowChangesDir, ".gates");

  // 本地已 approved → 无需拉取
  if (localGateApproved(gatesDir, nodeId)) return "skipped";

  const changeId = readTopLevelScalar(join(flowChangesDir, "change.yaml"), "id");
  if (!changeId) return "skipped"; // 没有 changeId 无法定位后端记录 → 安全跳过

  const review = await fetchActiveReview(auth, targetFlow, nodeId, changeId);
  if (!review) return "skipped";

  // ── 严格身份校验（缺一不可，防跨项目/跨机器误放）──
  if (review.status !== "approved") return "skipped";
  if (!review.pCName || review.pCName !== pCName) return "skipped";
  if (!review.projectPath) return "skipped";
  if (normalizePath(review.projectPath) !== normalizePath(projectRoot)) return "skipped";
  // changeId 已作为查询键的一部分，此处 review.changeId 必然等于本地 changeId，
  // 再显式断言一次以防后端语义变化。
  if (review.changeId && review.changeId !== changeId) return "skipped";

  // 全部校验通过 → 写本地门禁（格式与 xflow approve / pullApprovedResult 对齐）
  const record = {
    stage: nodeId,
    status: "approved",
    reviewer: "web",
    timestamp: new Date().toISOString(),
    comment: "",
  };
  try {
    mkdirSync(gatesDir, { recursive: true });
    writeFileSync(join(gatesDir, `${nodeId}.json`), JSON.stringify(record, null, 2) + "\n", "utf-8");
    return "written";
  } catch {
    return "skipped";
  }
}

/**
 * 对目标节点的一组前置门禁节点做 best-effort 同步。
 *
 * @param {string[]} predIds  gates.json 里 requires 的原样条目，可能带 `<flow>:` 前缀
 * @param {{ specRoot: string, projectRoot: string, activeFlow: string }} opts
 * @returns {Promise<{ written: string[] }>}  写入的节点（供调用方可选打印），失败恒静默
 */
export async function syncApprovedGates(predIds, opts) {
  const written = [];
  if (!Array.isArray(predIds) || predIds.length === 0) return { written };

  const auth = readCliAuth();
  if (!auth) return { written }; // 未登录 → 纯本地模式，静默

  const ctx = {
    specRoot: opts.specRoot,
    projectRoot: opts.projectRoot,
    auth,
    pCName: hostname(),
  };

  for (const predId of predIds) {
    let targetFlow = opts.activeFlow;
    let nodeId = predId;
    if (predId.includes(":")) {
      const parts = predId.split(":");
      targetFlow = parts[0];
      nodeId = parts.slice(1).join(":");
    }
    if (!targetFlow || !nodeId) continue;
    try {
      const r = await syncOneNode(ctx, targetFlow, nodeId);
      if (r === "written") written.push(`${targetFlow}:${nodeId}`);
    } catch {
      /* best-effort：单节点失败不影响其他节点，也不阻断门禁 */
    }
  }

  return { written };
}

// ─── 独立运行入口（node .xflow/scripts/xf-sync-gates.mjs --to <nodeId>）────────

async function mainCli() {
  const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
  const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");
  const XFLOW_DIR = resolve(SCRIPT_DIR, "..");
  const SPEC_ROOT = join(PROJECT_ROOT, "xspec");

  const args = parseArgs(process.argv.slice(2));
  const targetId = typeof args.to === "string" ? args.to : null;
  if (!targetId) {
    console.error("用法：node xf-sync-gates.mjs --to <nodeId> [--flow <name>]");
    process.exit(0); // best-effort：参数问题也不作为错误阻断
    return;
  }

  const activeFlow = (typeof args.flow === "string" ? args.flow : null) ?? readActiveFlow(SPEC_ROOT, XFLOW_DIR);
  if (!activeFlow) process.exit(0);

  // 独立运行时，同步目标节点的前置门禁（读 gates.json 的 requires）；
  // 若拿不到 requires（无门禁定义），退而同步目标节点自身。
  const gates = readGatesJson(join(XFLOW_DIR, activeFlow, "gates.json"));
  const requires = gates && gates[targetId] && Array.isArray(gates[targetId].requires)
    ? gates[targetId].requires
    : [targetId];

  const { written } = await syncApprovedGates(requires, {
    specRoot: SPEC_ROOT,
    projectRoot: PROJECT_ROOT,
    activeFlow,
  });
  if (written.length > 0) {
    console.error(`✓ 已从 Web 审核同步门禁：${written.join(", ")}`);
  }
  process.exit(0);
}

function readGatesJson(gatesPath) {
  if (!existsSync(gatesPath)) return null;
  try {
    return JSON.parse(readFileSync(gatesPath, "utf-8"));
  } catch {
    return null;
  }
}

function readActiveFlow(specRoot, xflowDir) {
  if (existsSync(specRoot)) {
    for (const dir of readdirSync(specRoot)) {
      const candidate = join(specRoot, dir, "changes", "change.yaml");
      if (existsSync(candidate)) {
        const flow = readTopLevelScalar(candidate, "flow");
        if (flow) return flow;
      }
    }
  }
  const initJsonPath = join(xflowDir, "init.json");
  if (existsSync(initJsonPath)) {
    try {
      const data = JSON.parse(readFileSync(initJsonPath, "utf-8"));
      if (data.mode === "flow" && typeof data.flow === "string") return data.flow;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function parseArgs(argv) {
  const r = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      r[k] = next && !next.startsWith("-") ? (i++, next) : true;
    } else if (a.startsWith("-")) {
      r[a.slice(1)] = true;
    }
  }
  return r;
}

// 仅在被直接执行时跑 CLI；被 import 时只导出函数。
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const selfPath = resolve(fileURLToPath(import.meta.url));
if (invokedPath && invokedPath === selfPath) {
  mainCli();
}
