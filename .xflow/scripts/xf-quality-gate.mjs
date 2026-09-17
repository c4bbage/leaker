#!/usr/bin/env node
/**
 * xf-quality-gate.mjs — 节点质量门禁（独立脚本，方案 §17.2 / v2 R5）
 *
 * 职责分离：xf-gate.mjs 管人工审批（.gates/）；本脚本管质量（~/.xflow/.../quality/），互不污染。
 * 只校验机器事实（summary 存在性 + l1_blocked + pending + blocked），不重跑裁判。
 *
 * 用法：
 *   node .xflow/scripts/xf-quality-gate.mjs --node <gateNode> [--skip-l2]
 *
 * 退出码：0=质量门通过；1=未通过（未执行/L1 阻断/L2 未完成/有阻断项）；2=脚本/配置错误。
 *
 * hub 未运行兜底（防误伤纯 CLI 用户）：
 *   - L1 阻断永远即时生效（命令内已跑，与 hub 无关）。
 *   - L2 pending 超 5 分钟无结果 → 判定 hub 可能未运行，提示可加 --skip-l2 仅凭 L1 放行；
 *     --skip-l2 放行时 summary 记 skipped_l2:true（诚实留痕，不静默）。
 *   - web 用户不受影响：hub 在跑，几十秒内 L2 判完，pending 自然消失，无需 --skip-l2。
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  resolveFlowId, output, parseArgs, handleHelpFlag, assertAllowedArgs,
  readChangeYaml, qualityDir,
} from "./lib.mjs";

const USAGE = `用法: node .xflow/scripts/xf-quality-gate.mjs --node <gateNode> [--skip-l2]
  --node <id>    门禁节点 id（如 xf-clarify / xf-design / xf-detail / xf-task）
  --skip-l2      纯 CLI 兜底：L2 语义裁判未完成时仅凭 L1 放行（summary 记 skipped_l2:true）`;

const ALLOWED_ARGS = ["help", "node", "skip-l2", "flow"];
/** hub 未运行时 L2 pending 的逾时阈值（超过即提示可 --skip-l2） */
const PENDING_STALL_MS = 5 * 60 * 1000;

function normalizeNode(id) {
  if (!id) return "";
  return id.startsWith("xf-") ? id : `xf-${id}`;
}

/** 把 skipped_l2 标记回写 summary（仅 --skip-l2 放行时），诚实留痕。 */
function markSkippedL2(summaryPath) {
  try {
    const s = JSON.parse(readFileSync(summaryPath, "utf-8"));
    writeFileSync(summaryPath, JSON.stringify({ ...s, skipped_l2: true }, null, 2) + "\n", "utf-8");
  } catch { /* 回写失败不阻断放行 */ }
}

/**
 * 评估质量门。返回 { exitCode, payload }。
 * quality 存 ~/.xflow/artifacts/<hash>/<flow>/quality/<changeId>/，需变更 id。
 * payload = { pass, reason?, skipped_l2? }（供调用方/命令读取）。
 */
export async function evaluate({ node, skipL2 = false, flow = null } = {}) {
  if (!node) {
    return { exitCode: 2, payload: { pass: false, reason: "缺少 --node <gateNode>" } };
  }
  let flowId;
  try {
    flowId = flow ?? resolveFlowId();
  } catch (e) {
    return { exitCode: 2, payload: { pass: false, reason: `无法解析 flow：${e.message}` } };
  }
  const normNode = normalizeNode(node);

  // 解析变更 id → 定位质量目录（机器本地 ~/.xflow）
  const change = await readChangeYaml(flowId);
  const qd = qualityDir(flowId, change?.id ?? null);
  const summaryPath = qd ? join(qd, `${normNode}.summary.json`) : null;

  if (!summaryPath || !existsSync(summaryPath)) {
    return {
      exitCode: 1,
      payload: { pass: false, reason: `质量门未执行：${normNode} 缺 summary（L1 未跑，请先在节点内执行 xf-quality.mjs --l1-only）` },
    };
  }

  let s;
  try {
    s = JSON.parse(readFileSync(summaryPath, "utf-8"));
  } catch (e) {
    return { exitCode: 2, payload: { pass: false, reason: `summary 解析失败：${e.message}` } };
  }

  // L1 阻断优先（命令内已判定，无论 hub 是否运行都即时生效）
  if (s.l1_blocked) {
    return {
      exitCode: 1,
      payload: { pass: false, reason: `质量门未通过：${normNode} 有 L1 阻断项未修复（${s.counts?.blocking_fail ?? "?"} 项）` },
    };
  }

  // L2 待判（hub 后台裁判中）
  if (s.pending) {
    const pendingSince = s.pending_since ? new Date(s.pending_since).getTime() : Date.now();
    const stalledMs = Date.now() - pendingSince;
    if (skipL2) {
      markSkippedL2(summaryPath);
      return {
        exitCode: 0,
        payload: { pass: true, skipped_l2: true, reason: "L1 通过；L2 语义裁判被显式跳过（未经裁判，已记录 skipped_l2）" },
      };
    }
    if (stalledMs > PENDING_STALL_MS) {
      return {
        exitCode: 1,
        payload: {
          pass: false,
          reason: `L2 裁判逾时未完成（可能 xflow 控制台未运行）。若纯 CLI 使用，可加 --skip-l2 仅凭 L1 通过（L2 未经裁判，会记录在案）；否则请启动 xflow 控制台让 L2 裁判完成`,
        },
      };
    }
    return {
      exitCode: 1,
      payload: { pass: false, reason: `L2 质量裁判进行中（${s.pending_count ?? "?"} 条待判），请稍候在 web 查看结果再审批` },
    };
  }

  // L2 已判（hub 合并后 blocked 为最终值）
  if (s.blocked) {
    return {
      exitCode: 1,
      payload: { pass: false, reason: `质量门未通过：${normNode} 有 ${s.counts?.blocking_fail ?? "?"} 项阻断规则未修复` },
    };
  }

  return { exitCode: 0, payload: { pass: true } };
}

// ─── CLI 入口 + 30s 超时守卫 ─────────────────────────────────────────────────
const TIMEOUT_MS = 30_000;
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const timer = setTimeout(() => {
    console.error(`[xflow] Error: xf-quality-gate.mjs timed out after ${TIMEOUT_MS / 1000}s`);
    process.exit(2);
  }, TIMEOUT_MS);
  (async () => {
    const args = parseArgs();
    handleHelpFlag(args, USAGE);
    assertAllowedArgs(args, ALLOWED_ARGS, USAGE);
    const { exitCode, payload } = await evaluate({
      node: typeof args.node === "string" ? args.node : null,
      skipL2: args["skip-l2"] === true,
      flow: typeof args.flow === "string" ? args.flow : null,
    });
    output(payload);
    // exitCode 而非 process.exit：保证 stdout（output JSON）先 flush
    process.exitCode = exitCode;
  })().then(() => clearTimeout(timer)).catch((err) => {
    clearTimeout(timer);
    console.error(`[xflow] Error: ${err.message}`);
    process.exit(2);
  });
}
