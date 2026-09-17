#!/usr/bin/env node
/**
 * xf-set-phase.mjs — 设置/推进 change.yaml 的当前节点（phase）
 *
 * 【统一写入入口】所有 phase 移动都应通过本脚本：
 *   - Flow 模式：command-wrapper 自动调用
 *   - Profile 模式：AI 按命令指令调用
 *   - CLI 手动切换：xflow phase 内部 shell out 调用
 *
 * 职责：1. 校验 → 2. 写 change.yaml（lib.mjs:writePhase）→ 3. best-effort 上报 web
 *
 * 用法：  node .xflow/scripts/xf-set-phase.mjs --node <nodeId> [--flow <flowName>]
 * 输出：  { "ok": true, "phase": "<nodeId>", "flow": "<flowName>|null", "created": <bool> }
 * 退出码：0 = 成功，1 = 参数错误
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join, resolve, dirname } from "path";
import { homedir, hostname } from "os";
import { fileURLToPath } from "url";
import { writePhase } from "./lib.mjs";

const USAGE = `xf-set-phase.mjs — 设置当前节点（change.yaml phase）
用法：node .xflow/scripts/xf-set-phase.mjs --node <nodeId> [--flow <flowName>]
  --node <nodeId>      当前所处的节点 ID
  --flow <flowName>    当前活跃 Flow 名称（Group 模式必填）
  --help, -h           显示此帮助
幂等：change.yaml 不存在则按模板创建，已存在仅更新 phase / updated_at / flow。`;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  console.log(USAGE);
  process.exit(0);
}

const nodeId = typeof args.node === "string" ? args.node : null;
if (!nodeId) {
  console.error("缺少 --node 参数\n\n" + USAGE);
  process.exit(1);
}

const flowNameArg = typeof args.flow === "string" ? args.flow : null;
let flowName = flowNameArg;

// Group 模式下验证 flow name；Flow 模式下从 init.json 自动获取
const initJsonPath = join(PROJECT_ROOT, ".xflow", "init.json");
let initMode = null;
if (existsSync(initJsonPath)) {
  try {
    const initData = JSON.parse(readFileSync(initJsonPath, "utf-8"));
    initMode = initData.mode;
    if (initData.mode === "group") {
      if (!flowName) {
        console.error("Group 模式下 --flow 参数必须提供\n\n" + USAGE);
        process.exit(1);
      }
      const flowDir = join(PROJECT_ROOT, ".xflow", flowName);
      if (!existsSync(flowDir)) {
        console.error(
          `Flow "${flowName}" 不在当前 Group 中。\n` +
          `可用的 Flow: ` + listGroupFlows().join(", ")
        );
        process.exit(1);
      }
    } else if (initData.mode === "flow" && !flowName) {
      if (typeof initData.flow === "string" && initData.flow) {
        flowName = initData.flow;
      }
    }
  } catch { /* init.json 解析失败不阻塞 */ }
}

// Group 模式：清除其他 Flow 的 change.yaml（全局唯一活跃约束）
if (initMode === "group" && flowName) {
  clearOtherFlows(flowName);
}

// ── 1. 写 change.yaml（统一入口：lib.mjs:writePhase）──
// writePhase 把完整节点 ID（如 xf-split）作为 canonical phase 写入并回传（result.phase），
// 与 web 侧「节点 ID 命名空间」一致；前缀无关的入口校验由 xf-check-phase 归一后兜底。
const result = writePhase(flowName || "default", nodeId, { flowName: flowName || undefined });

console.log(JSON.stringify({ ...result, flow: flowName }));

// ── 2. best-effort 上报 web（不阻塞、不报错）──；上报全 ID phase，与本地 change.yaml 一致
await reportToWeb(result.phase, flowName, initMode);

process.exit(0);

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Best-effort 上报 phase 到 xflow-admin 后端。
 * 优先用 PATCH /phase（语义正确），项目不存在时回退 POST /projects（自动创建）。
 * 任何失败都静默跳过——不影响本地 phase 写入。
 */
async function reportToWeb(phase, flow, mode) {
  try {
    const configPath = join(homedir(), ".xflow-cli", "config.json");
    if (!existsSync(configPath)) return;
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const token = config.auth?.token;
    const baseUrl = config.auth?.backend_url;
    if (!token || !baseUrl) return;

    const pCName = hostname();
    const projectPath = PROJECT_ROOT;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };

    // 1. 先尝试 PATCH /phase（项目已注册的场景）
    const patchRes = await fetch(`${baseUrl}/api/v1/projects/phase`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ pCName, projectPath, phase, flowName: flow || undefined }),
    });

    if (patchRes.ok) return;

    // 2. 404 = 项目未注册，回退 POST /projects（自动创建）
    if (patchRes.status === 404 || patchRes.status === 400) {
      await fetch(`${baseUrl}/api/v1/projects`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          pCName,
          projectPath,
          mode: mode || undefined,
          flowName: flow || undefined,
          currentPhase: phase,
        }),
      });
    }
  } catch {
    // 静默跳过：后端不可用 / 未登录 / 网络错误 都不影响本地 phase
  }
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

const FRAMEWORK_DIRS = new Set(["scripts", "profiles", "reference", "tools"]);

function listGroupFlows() {
  const xflowDir = join(PROJECT_ROOT, ".xflow");
  if (!existsSync(xflowDir)) return [];
  try {
    return readdirSync(xflowDir)
      .filter((d) => !FRAMEWORK_DIRS.has(d) && !d.startsWith(".") && !d.includes("."))
      .filter((d) => statSync(join(xflowDir, d)).isDirectory());
  } catch {
    return [];
  }
}

function clearOtherFlows(activeFlow) {
  const xflowDir = join(PROJECT_ROOT, ".xflow");
  if (!existsSync(xflowDir)) return;
  const specRoot = join(PROJECT_ROOT, "xspec");
  try {
    const allFlows = readdirSync(xflowDir)
      .filter((d) => !FRAMEWORK_DIRS.has(d) && !d.startsWith(".") && !d.includes("."))
      .filter((d) => statSync(join(xflowDir, d)).isDirectory());
    for (const f of allFlows) {
      if (f === activeFlow) continue;
      const p = join(specRoot, f, "changes", "change.yaml");
      try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}
