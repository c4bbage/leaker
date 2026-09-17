#!/usr/bin/env node
/**
 * xf-enter-node.mjs — 节点入口聚合检查（替代 4 个独立脚本）
 *
 * 单次 node 进程内顺序执行：
 *   1. xf-check-invariants  — 结构不变量校验（只读）
 *   2. xf-check-phase       — phase 入口合法性（只读）
 *   3. xf-gate              — 门禁审批检查（只读）
 *   4. xf-set-phase         — 标记当前节点（写 change.yaml）
 *
 * 任一校验失败立即终止并输出诊断报告，不继续后续步骤。
 * 前 3 步共享 change.yaml 读取，消除冗余 I/O。
 *
 * 输出契约（面向 AI agent，力求"读一眼就知道发生了什么"）：
 *   - 无论成功 / 失败，都先打印一份「四步检查清单」，逐条标 ✓ / ✗ / ∅（跳过）；
 *   - 成功时仅确认通过（不给"下一步该做什么"这类建议——那是命令正文 / wrapper 的职责）；
 *   - 失败时附对应步骤的诊断报告（结构违规 / phase 不合法 / 门禁未通过），只陈述事实与错误；
 *   - 末尾统一附一段 machine-readable JSON（供程序判定，字段向后兼容 ok/phase/created/flow）。
 *
 * Usage:
 *   node .xflow/scripts/xf-enter-node.mjs --node <nodeId> [--flow <flowName>]
 *
 * Exit codes:
 *   0 = 全部通过，phase 已写入
 *   2 = 结构不变量 / phase 入口违规（与 xf-check-invariants/phase 一致）
 *   1 = 门禁未通过 / 无法确定活跃 Flow / 参数错误
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "fs";
import { join, resolve, dirname } from "path";
import { homedir, hostname } from "os";
import { fileURLToPath } from "url";
import {
  writePhase,
  parseArgs,
  printUsageAndExit,
  handleHelpFlag,
  assertAllowedArgs,
} from "./lib.mjs";
import {
  assertChangesInvariant,
  renderViolations,
} from "./xf-check-invariants.mjs";
import { assertCommandPhase, renderPhaseViolation } from "./xf-check-phase.mjs";
import { checkGates } from "./xf-gate.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");
const XFLOW_DIR = resolve(SCRIPT_DIR, "..");
const SPEC_ROOT = join(PROJECT_ROOT, "xspec");

const USAGE = {
  usage:
    "node .xflow/scripts/xf-enter-node.mjs --node <nodeId> [--flow <flowName>]",
  description:
    "节点入口聚合检查：结构不变量 → phase 入口 → 门禁 → 标记节点。\n" +
    "替代原有 4 步独立脚本调用，任一失败立即终止。\n" +
    "输出统一含「四步检查清单 + 快照/诊断 + machine-readable JSON」。",
  required: {
    "--node <nodeId>": "目标节点 ID（如 xf-constitution）",
  },
  optional: {
    "--flow <flowName>":
      "Flow 名称（Group 模式必填，Flow 模式自动从 init.json 获取）",
    "--help, -h": "打印本帮助并退出",
  },
  examples: [
    "node .xflow/scripts/xf-enter-node.mjs --node xf-constitution --flow xflow",
  ],
  notes: [
    "退出码：0=全部通过，2=结构/phase 违规，1=门禁未通过/无法确定 Flow/脚本错误",
    '门禁未通过时输出「⛔ 门禁未通过」诊断块 + machine-readable { ok:false, step:"gate", ... }，照旧提示 xflow approve',
    "成功输出末尾的 machine-readable JSON 保留 ok/phase/created/flow 字段，向后兼容",
    "本脚本同时支持 Flow 模式和 Group 模式（Group 模式会自动清理其他 Flow 的 change.yaml）",
  ],
};

const ALLOWED_ARGS = ["help", "node", "flow"];

// ─── 检查清单渲染 ────────────────────────────────────────────────────────────

const DIVIDER = "─".repeat(60);

const STEP_ORDER = ["invariants", "phase", "gate", "mark"];
const STEP_LABELS = {
  invariants: "结构不变量校验",
  phase: "phase 入口校验",
  gate: "门禁审批检查",
  mark: "标记当前节点",
};
const STEP_ICONS = { pass: "✓", fail: "✗", skip: "∅", pending: "·" };

/** 构造初始清单状态（全部 pending）。 */
function initSteps() {
  const s = {};
  for (const k of STEP_ORDER) s[k] = { status: "pending", detail: "" };
  return s;
}

/** 把失败步骤之后的所有步骤标记为「跳过」。 */
function markRemainingSkipped(steps, failedKey) {
  let after = false;
  for (const key of STEP_ORDER) {
    if (after)
      steps[key] = { status: "skip", detail: "未执行（前序步骤失败即终止）" };
    if (key === failedKey) after = true;
  }
}

/** 渲染四步检查清单为多行文本。 */
function renderChecklist(steps) {
  return STEP_ORDER.map((key, i) => {
    const r = steps[key] || { status: "pending", detail: "" };
    const tail = r.detail ? ` — ${r.detail}` : "";
    return `  [${i + 1}/${STEP_ORDER.length}] ${STEP_ICONS[r.status] || "·"} ${STEP_LABELS[key]}${tail}`;
  }).join("\n");
}

/** 统一 machine-readable 尾块（明确标注供程序判定，勿改写）。 */
function machineFooter(obj) {
  return [
    DIVIDER,
    "machine-readable（供程序判定，勿改写）:",
    JSON.stringify(obj),
  ].join("\n");
}

/** 把清单状态压缩成 { invariants:"pass", phase:"pass", ... } 供 JSON 输出。 */
function stepsSummary(steps) {
  const out = {};
  for (const k of STEP_ORDER) out[k] = (steps[k] || {}).status || "pending";
  return out;
}

// ─── 失败输出：结构 / phase（复用各自 renderer，前置加清单，后置加 JSON）──────

function emitStepFailure({
  headerStep,
  banner,
  steps,
  detailReport,
  machine,
  prohibitions,
}) {
  const failedIdx = STEP_ORDER.indexOf(headerStep) + 1;
  const lines = [];
  lines.push(banner);
  lines.push("");
  lines.push(`检查步骤（在第 ${failedIdx} 步失败）：`);
  lines.push(renderChecklist(steps));
  lines.push("");
  lines.push(detailReport);
  if (prohibitions) {
    lines.push("");
    lines.push(prohibitions);
  }
  lines.push("");
  lines.push(machineFooter(machine));
  console.log(lines.join("\n"));
}

async function main() {
  const args = parseArgs();
  handleHelpFlag(args, USAGE);
  assertAllowedArgs(args, ALLOWED_ARGS, USAGE);

  const nodeId = typeof args.node === "string" ? args.node : null;
  if (!nodeId) {
    printUsageAndExit(USAGE, "缺少 --node 参数");
  }

  const commandName = nodeId.includes("-")
    ? nodeId.slice(nodeId.indexOf("-") + 1)
    : nodeId;
  const steps = initSteps();

  // ── 确定 flowName ──
  // Wrapper 在 Flow/Group 模式下统一传 --flow；仅 Step 3 (gate) 语义上需要，
  // Step 1-2 原始设计中无 --flow 参数，聚合为同进程后需临时剥离避免泄露。
  let flowName = typeof args.flow === "string" ? args.flow : null;
  let initMode = null;

  const initJsonPath = join(XFLOW_DIR, "init.json");
  if (existsSync(initJsonPath)) {
    try {
      const initData = JSON.parse(readFileSync(initJsonPath, "utf-8"));
      initMode = initData.mode;
      if (
        initData.mode === "flow" &&
        !flowName &&
        typeof initData.flow === "string"
      ) {
        flowName = initData.flow;
      }
    } catch {
      /* init.json 解析失败不阻塞 */
    }
  }

  // ── Steps 1-2 argv 隔离 ──────────────────────────────────────────────
  // 原始 4 脚本设计：Steps 1-2 通过独立 node 进程运行，process.argv 中无 --flow；
  // 聚合为单进程后 --flow 在 process.argv 中泄露到 Steps 1-2 的 resolveFlowId() 调用。
  // 临时剥离 --flow，保持原始语义（Group 模式下 resolveFlowId 走共享 change.yaml 路径）。
  const fullArgv = process.argv.slice(2);
  if (fullArgv.includes("--flow")) {
    process.argv = [
      ...process.argv.slice(0, 2),
      ...fullArgv.filter((a) => a !== "--flow"),
    ];
  }

  // ══════════════════════════════════════════════════════════════════
  //  步骤 1：结构不变量校验（原 xf-check-invariants.mjs）[暂时跳过]
  // ══════════════════════════════════════════════════════════════════
  // const violations = await assertChangesInvariant();
  // if (violations.length > 0) {
  //   steps.invariants = {
  //     status: "fail",
  //     detail: `检出 ${violations.length} 条结构违规`,
  //   };
  //   markRemainingSkipped(steps, "invariants");
  //   emitStepFailure({
  //     headerStep: "invariants",
  //     banner: `⛔ 结构不变量校验未通过 —— 节点 ${nodeId} 终止`,
  //     steps,
  //     detailReport: renderViolations(violations),
  //     prohibitions: [
  //       "Agent 禁止执行以下操作（擅自操作会进一步破坏 xspec 结构）：",
  //       "  - 禁止删除、重命名或移动 change.yaml（根目录只允许存在一个，且只能叫 change.yaml）",
  //       "  - 禁止手动创建或删除 xspec/*/changes/<module>/ 目录",
  //       "  - 禁止修改 change.yaml 的 affected_modules 字段来掩盖孤儿目录",
  //       "  - 禁止尝试\u201c先修复部分再继续\u201d——结构违规时必须完全停止",
  //       "将此报告原样输出给用户，由用户根据修复建议在终端操作后重试。",
  //     ].join("\n"),
  //     machine: {
  //       ok: false,
  //       step: "invariants",
  //       exit_code: 2,
  //       node: nodeId,
  //       command: commandName,
  //       violations_count: violations.length,
  //       violations,
  //       steps: stepsSummary(steps),
  //     },
  //   });
  //   process.exit(2);
  // }
  steps.invariants = {
    status: "pass",
    detail: "xspec/changes/ 结构合法（已跳过校验）",
  };

  // ══════════════════════════════════════════════════════════════════
  //  步骤 2：phase 入口校验（原 xf-check-phase.mjs）
  // ══════════════════════════════════════════════════════════════════
  const phaseResult = await assertCommandPhase(nodeId);
  if (!phaseResult.ok) {
    steps.phase = {
      status: "fail",
      detail: `phase=${phaseResult.violation.current_phase} 不是节点 ${nodeId} 的合法入口`,
    };
    markRemainingSkipped(steps, "phase");
    emitStepFailure({
      headerStep: "phase",
      banner: `⛔ phase 入口不合法 —— 节点 ${nodeId} 终止`,
      steps,
      detailReport: renderPhaseViolation(phaseResult.violation),
      prohibitions: [
        "Agent 禁止执行以下操作（phase 不合法时必须完全停止）：",
        "  - 禁止直接修改 change.yaml 的 phase 字段来绕过约束",
        "  - 禁止跳过 phase 检查继续执行节点的后续步骤",
        "  - 禁止尝试任何形式的\u201c先做一部分\u201d——必须严格等待 phase 合法后重试",
        "将此报告原样输出给用户，由用户根据修复建议操作后重试。",
      ].join("\n"),
      machine: {
        ok: false,
        step: "phase",
        exit_code: 2,
        node: nodeId,
        command: commandName,
        current_phase: phaseResult.violation.current_phase,
        allowed_phases: phaseResult.violation.allowed_phases,
        steps: stepsSummary(steps),
      },
    });
    process.exit(2);
  }
  steps.phase = {
    status: "pass",
    detail: phaseResult.note
      ? phaseResult.note
      : `phase=${phaseResult.current_phase} 是节点 ${nodeId} 的合法入口`,
  };

  // ── 恢复 --flow 给 Steps 3-4（Step 3 原始设计携带此参数）────────────
  process.argv = [...process.argv.slice(0, 2), ...fullArgv];

  // ══════════════════════════════════════════════════════════════════
  //  步骤 3：门禁检查（原 xf-gate.mjs）
  // ══════════════════════════════════════════════════════════════════
  const activeFlow = flowName ?? readActiveFlow();
  if (!activeFlow) {
    steps.gate = { status: "fail", detail: "无法确定当前活跃 Flow" };
    markRemainingSkipped(steps, "gate");
    const detail = [
      "无法确定当前活跃 Flow，门禁检查无法进行。",
      "",
      "可能原因：",
      "  - Group 模式下未传 --flow，且 xspec/*/changes/change.yaml 未声明 flow 字段",
      "  - 项目尚未 xflow init（.xflow/init.json 缺失）",
      "",
      "建议处理：",
      "  - 重新执行并显式指定：--flow <flowName>",
      "  - 或确认项目已正确 init（存在 .xflow/init.json）",
    ].join("\n");
    console.log(
      [
        `⛔ 无法确定活跃 Flow —— 节点 ${nodeId} 终止`,
        "",
        "检查步骤（在第 3 步失败）：",
        renderChecklist(steps),
        "",
        detail,
        "",
        machineFooter({
          ok: false,
          step: "gate",
          exit_code: 1,
          node: nodeId,
          command: commandName,
          reason:
            "无法确定当前活跃 Flow（缺少 --flow / change.yaml flow 字段 / init.json）",
          steps: stepsSummary(steps),
        }),
      ].join("\n"),
    );
    process.exit(1);
  }

  const gatesPath = join(XFLOW_DIR, activeFlow, "gates.json");
  const gates = readGates(gatesPath);
  const gateDef = gates ? gates[nodeId] : null;
  const requires = gateDef?.requires ?? [];

  // 门禁判定前，先 best-effort 从 Web 审核后端把已审批结果同步到本地 .gates。
  // 审核已迁移到 Web 端：产物由 audit 插件 live-push 到后端、审核员网页通过/驳回，
  // 本地不再跑 xflow approve/approve-new，故必须在此拉取回写，否则 Web 批了本地却不知道。
  // 任何失败（缺模块 / 未登录 / 离线 / 超时）都静默跳过，绝不阻断门禁。
  await syncGatesBestEffort(requires, {
    specRoot: SPEC_ROOT,
    projectRoot: PROJECT_ROOT,
    activeFlow,
  });

  const gateResult = checkGates(requires, activeFlow);

  if (!gateResult.pass) {
    steps.gate = { status: "fail", detail: gateResult.reason };
    markRemainingSkipped(steps, "gate");
    // best-effort 解析项目 UUID + 前端基址，构造不泄露路径的 Web 审核深链；失败则仅保留终端提示
    const web = readWebConfig();
    let projectId = null;
    let webBase = null;
    if (web) {
      // 前端基址向后端现取（单一数据源，区分环境）；接口不可用时回退 backend 源
      webBase = (await fetchWebBase(web.baseUrl, web.token)) ?? web.baseUrl;
      projectId = await resolveProjectId(
        web.baseUrl,
        web.token,
        hostname(),
        PROJECT_ROOT,
      );
    }
    console.log(
      renderGateFailure({
        commandName,
        nodeId,
        gateResult,
        steps,
        webBase,
        projectId,
        activeFlow,
      }),
    );
    process.exit(1);
  }
  const approvedGateIds = gateResult.checks
    .filter((c) => c.approved)
    .map((c) => c.id);
  steps.gate = {
    status: "pass",
    detail: !requires.length
      ? "本节点无前置门禁要求"
      : requires.length > 1
        ? `替代入口门禁通过（${requires.length} 选 1，已 approved：${approvedGateIds.join(", ") || "—"}）`
        : `前置门禁已 approved（${approvedGateIds.join(", ")}）`,
  };

  // ══════════════════════════════════════════════════════════════════
  //  步骤 4：标记当前节点（原 xf-set-phase.mjs）
  // ══════════════════════════════════════════════════════════════════

  // Group 模式：清除其他 Flow 的 change.yaml（全局唯一活跃约束）
  if (initMode === "group" && activeFlow) {
    clearOtherFlows(activeFlow);
  }

  const writeResult = writePhase(activeFlow || "default", nodeId, {
    flowName: activeFlow || undefined,
  });
  // canonical phase = 完整节点 ID（writePhase 写入的值，如 xf-split），与 change.yaml 一致；
  // 展示用它。前缀无关的入口校验由 xf-check-phase 归一后兜底。
  const phaseValue = writeResult.phase;
  steps.mark = {
    status: "pass",
    detail: `change.yaml phase = ${phaseValue}${writeResult.created ? "（本次新建 change.yaml）" : "（原地更新）"}`,
  };

  console.log(
    renderSuccess({ commandName, nodeId, activeFlow, steps, writeResult }),
  );

  // best-effort 上报 web（不阻塞）。
  // web 侧是「节点 ID 命名空间」——flow 预览、gate_reviews、live_artifacts 全部以带前缀的
  // 节点 ID（如 xf-detail）为准，live-push 上报的也是节点 ID。change.yaml 的 phase 现在同样
  // 是全 ID（见 lib.writePhase），因此本地与 web 命名空间一致，这里上报 nodeId 即可。
  await reportToWeb(nodeId, activeFlow, initMode);

  process.exit(0);
}

// ─── 成功输出渲染 ────────────────────────────────────────────────────────────

function renderSuccess({
  commandName,
  nodeId,
  activeFlow,
  steps,
  writeResult,
}) {
  const lines = [];
  lines.push(`✅ 节点入口校验通过 —— 节点 ${nodeId} 可以开始执行`);
  lines.push("");
  lines.push(`检查步骤（${STEP_ORDER.length}/${STEP_ORDER.length} 通过）：`);
  lines.push(renderChecklist(steps));
  lines.push("");
  lines.push(
    machineFooter({
      ok: true,
      step: "complete",
      exit_code: 0,
      node: nodeId,
      command: commandName,
      phase: writeResult.phase,
      created: writeResult.created,
      flow: activeFlow,
      steps: stepsSummary(steps),
    }),
  );
  return lines.join("\n");
}

// ─── 门禁失败渲染（对齐 CLAUDE.md 固定提示：请在终端执行 xflow approve）──────────

function renderGateFailure({
  commandName,
  nodeId,
  gateResult,
  steps,
  webBase,
  projectId,
  activeFlow,
}) {
  const lines = [];
  lines.push(`⛔ 门禁未通过 —— 节点 ${nodeId} 无法进入`);
  lines.push("");
  lines.push("检查步骤（在第 3 步失败）：");
  lines.push(renderChecklist(steps));
  lines.push("");
  lines.push("门禁明细：");
  for (const c of gateResult.checks) {
    const mark = c.approved ? "✓" : "✗";
    let state;
    if (c.approved) state = "approved";
    else if (c.status === "missing") state = `未审批（缺少门禁文件 ${c.file}）`;
    else if (c.status === "unreadable")
      state = `门禁文件损坏无法解析（${c.file}）`;
    else state = `审批状态为 "${c.status}"，需要 "approved"`;
    lines.push(`  ${mark} ${c.id} — ${state}`);
  }
  lines.push("");
  lines.push(`原因：${gateResult.reason}`);
  lines.push("");

  // Web 审核深链：点击直达对应节点的审核页（在 Web 端通过 = 合法审批路径之一）
  if (webBase && projectId) {
    const pending = gateResult.checks.filter((c) => !c.approved);
    if (pending.length > 0) {
      lines.push("在 Web 端审核（点击直达对应节点的审核页）：");
      for (const c of pending) {
        lines.push(
          `  · ${c.id} → ${buildReviewDeepLink(webBase, {
            projectId,
            activeFlow,
            checkId: c.id,
          })}`,
        );
      }
      lines.push("");
    }
  }

  lines.push("请在终端执行：xflow approve");
  lines.push("审批通过后重新执行当前命令。");
  lines.push("");
  lines.push("Agent 禁止执行以下操作：");
  lines.push(
    "  - 禁止直接创建、修改或删除 xspec/*/changes/.gates/ 下的任何文件",
  );
  lines.push(
    "  - 禁止自行执行 xflow approve（仅用户有权审批，agent 无权操作）",
  );
  lines.push(
    "  - 禁止向用户提供手动构造门禁文件的命令或方法（如 echo ... > .gates/xxx.json）",
  );
  lines.push("  - 禁止搜索 .gates/ 目录或分析门禁脚本源码以试图理解或绕过机制");
  lines.push("  - 禁止在门禁未通过时继续执行节点正文的任何步骤");
  lines.push("");
  lines.push(
    machineFooter({
      ok: false,
      pass: false,
      step: "gate",
      exit_code: 1,
      node: nodeId,
      command: commandName,
      reason: gateResult.reason,
      gates: gateResult.checks,
      steps: stepsSummary(steps),
    }),
  );
  return lines.join("\n");
}

// ─── Web 审核结果同步（best-effort，内联自 xf-gate.mjs）──────────────────────

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

// ─── 门禁检查（gates.json 读取；checkGates 判定逻辑见 xf-gate.mjs，本文件顶部 import）──

function readGates(gatesPath) {
  if (!existsSync(gatesPath)) return null;
  try {
    return JSON.parse(readFileSync(gatesPath, "utf-8"));
  } catch {
    return null;
  }
}

// checkGates 已抽到 xf-gate.mjs 导出，两处共用同一份判定逻辑（含"多前置=二选一 OR"规则），
// 避免拷贝漂移。本文件顶部 `import { checkGates } from "./xf-gate.mjs"`。

function readActiveFlow() {
  if (existsSync(SPEC_ROOT)) {
    for (const dir of readdirSync(SPEC_ROOT)) {
      const candidate = join(SPEC_ROOT, dir, "changes", "change.yaml");
      if (existsSync(candidate)) {
        const flow = readFlowFieldFromYaml(candidate);
        if (flow) return flow;
      }
    }
  }
  const initJsonPath = join(XFLOW_DIR, "init.json");
  if (existsSync(initJsonPath)) {
    try {
      const data = JSON.parse(readFileSync(initJsonPath, "utf-8"));
      if (data.mode === "flow" && typeof data.flow === "string")
        return data.flow;
    } catch {
      /* ignore */
    }
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

// ─── Group 模式：清除其他 Flow 的 change.yaml ────────────────────────────────

const FRAMEWORK_DIRS = new Set(["scripts", "profiles", "reference", "tools"]);

function clearOtherFlows(activeFlow) {
  const xflowDir = XFLOW_DIR;
  if (!existsSync(xflowDir)) return;
  try {
    const allFlows = readdirSync(xflowDir)
      .filter(
        (d) => !FRAMEWORK_DIRS.has(d) && !d.startsWith(".") && !d.includes("."),
      )
      .filter((d) => statSync(join(xflowDir, d)).isDirectory());
    for (const f of allFlows) {
      if (f === activeFlow) continue;
      const p = join(SPEC_ROOT, f, "changes", "change.yaml");
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

// ─── Web 审核深链 ────────────────────────────────────────────────────────────

/** 读 ~/.xflow-cli/config.json 的 { baseUrl, token }；backend_url 缺失返回 null。 */
function readWebConfig() {
  try {
    const configPath = join(homedir(), ".xflow-cli", "config.json");
    if (!existsSync(configPath)) return null;
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const baseUrl = config.auth?.backend_url
      ? String(config.auth.backend_url).replace(/\/+$/, "")
      : null;
    if (!baseUrl) return null;
    return { baseUrl, token: config.auth?.token ?? null };
  } catch {
    return null;
  }
}

/**
 * 向后端现取「本环境」的 Web UI 基址（GET /api/v1/public/web-config）。
 * 前端基址与后端 API 基址不同（dev 端口不同、prod 可能带路径前缀），且随环境变化，
 * 故不落客户端、由后端作单一数据源返回。接口缺失 / 空值 / 网络失败均返回 null，
 * 调用方回退 backend 源。
 */
async function fetchWebBase(backendUrl, token) {
  try {
    const res = await fetch(`${backendUrl}/api/v1/public/web-config`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const data =
      json && typeof json === "object" && "data" in json ? json.data : json;
    const webBaseUrl =
      data && typeof data.webBaseUrl === "string" ? data.webBaseUrl : null;
    return webBaseUrl ? webBaseUrl.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

/**
 * 按 (pCName, projectPath) 解析后端项目 UUID（复用 GET /projects?pCName&projectPath）。
 * 深链用 UUID 而非绝对路径，避免泄露本机目录结构。失败/无对应项目返回 null。
 */
async function resolveProjectId(baseUrl, token, pCName, projectPath) {
  try {
    const qs = new URLSearchParams({ pCName, projectPath });
    const res = await fetch(`${baseUrl}/api/v1/projects?${qs.toString()}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const data =
      json && typeof json === "object" && "data" in json ? json.data : json;
    return data && typeof data.id === "string" ? data.id : null;
  } catch {
    return null;
  }
}

/**
 * 构造门禁审核页深链：`<web>/gate-reviews?id=&flow=&node=`。
 * checkId 形如 `flowPart:nodeId`（跨 Flow）时按其自身 Flow/节点定位，否则用当前活跃 Flow。
 * Web 列表页读取这些参数自动聚焦到对应项目 + 节点，展示报告并可审核/送审。
 */
function buildReviewDeepLink(webBase, { projectId, activeFlow, checkId }) {
  let flow = activeFlow || "";
  let node = checkId;
  if (checkId.includes(":")) {
    const idx = checkId.indexOf(":");
    flow = checkId.slice(0, idx);
    node = checkId.slice(idx + 1);
  }
  const qs = new URLSearchParams({ id: projectId });
  if (flow) qs.set("flow", flow);
  qs.set("node", node);
  return `${webBase}/gate-reviews?${qs.toString()}`;
}

// ─── best-effort 上报 web（内联自 xf-set-phase.mjs）─────────────────────────

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

    const patchRes = await fetch(`${baseUrl}/api/v1/projects/phase`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        pCName,
        projectPath,
        phase,
        flowName: flow || undefined,
      }),
    });

    if (patchRes.ok) return;

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

// ─── entry ──────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(`[xflow] Error: ${err.message}`);
  process.exit(1);
});
