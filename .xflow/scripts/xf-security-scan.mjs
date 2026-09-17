#!/usr/bin/env node

/**
 * xf-security-scan.mjs — 安全扫描编排（SAST + 密钥 + 依赖漏洞）
 *
 * @author cuiguangyu@bianfeng.com
 *
 * 设计原则（"预烘焙"模式）：脚本负责探测工具、执行扫描、归一化结果；
 * agent 只消费结构化 JSON，不自行摸索扫描命令——省 token 且结果确定。
 *
 * 按"能力"组织而非按"工具"组织。每个能力有优先级排序的后端，装了哪个用哪个：
 *
 *   能力      后端优先级                        说明
 *   secrets   gitleaks > trivy                 密钥/凭据泄漏
 *   deps      osv-scanner > trivy > npm audit  依赖已知漏洞（npm audit 仅限有 package-lock.json）
 *   sast      semgrep                          代码静态分析（trivy 不做 SAST，无替代后端）
 *
 * 推荐最小安装：只装 trivy（单个二进制同时覆盖 secrets + deps 两个能力），
 * SAST 能力需要额外装 semgrep。`--doctor` 查看本机工具矩阵与安装提示。
 *
 * 输出:
 *   - xspec/changes/.security/scan-report.json  归一化的机器可读报告
 *   - stdout 尾行 JSON 摘要（供命令/agent 判断）
 *
 * 退出码:
 *   0 = 扫描完成，无 HIGH+ 发现（或未开 --gate）
 *   2 = --gate 模式下存在 HIGH 及以上未处置发现（阻断语义，与 invariants/phase 校验一致）
 *   1 = 脚本错误 / 参数错误
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname, resolve, relative } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import {
  parseArgs,
  printUsageAndExit,
  handleHelpFlag,
  assertAllowedArgs,
  resolveFlowId,
  changesDir,
} from "./lib.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 解析项目根与默认报告目录，兼容多-Flow 部署布局与独立运行：
 *   已初始化（有活跃 Flow）→ 报告落 xspec/<flow>/changes/.security（invariants 白名单认得）
 *   未初始化 / Group 未指定 → 回退到 cwd，报告落 xspec/.security，保证 --doctor 与
 *   独立扫描仍可用（此时门禁不该在此上下文跑，路径仅用于产出报告）
 *
 * 注意：resolveFlowId() 未初始化时走 fatal（process.exit，非 throw），
 * 因此必须先用 existsSync 探测 init.json，不能靠 try/catch 兜底。
 */
function isInitialized() {
  // 源码仓库：.xflow/scripts/ → .xflow/init.json；部署：.xflow/<flow>/scripts/ → .xflow/init.json
  return existsSync(resolve(SCRIPT_DIR, "..", "init.json")) ||
         existsSync(resolve(SCRIPT_DIR, "..", "..", "init.json"));
}

function resolveRoots() {
  if (isInitialized()) {
    const flowId = resolveFlowId();
    if (typeof flowId === "string") {
      const changes = changesDir(flowId);
      return { projectRoot: resolve(changes, "..", "..", ".."), outputDir: join(changes, ".security") };
    }
  }
  const cwd = process.cwd();
  return { projectRoot: cwd, outputDir: join(cwd, "xspec", ".security") };
}

const SEVERITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
export const CAPABILITIES = ["sast", "secrets", "deps"];
// 兼容旧写法：--tools semgrep,gitleaks,deps
export const TOOL_ALIASES = { semgrep: "sast", gitleaks: "secrets" };

const IS_WINDOWS = process.platform === "win32";
// Windows 上 npm 是 npm.cmd，spawnSync 不带 shell 时必须用带扩展名的命令
const NPM_CMD = IS_WINDOWS ? "npm.cmd" : "npm";

const INSTALL_HINTS = IS_WINDOWS
  ? {
      trivy: "winget install AquaSecurity.Trivy 或 scoop install trivy（推荐：一个二进制覆盖 secrets + deps 两个能力）",
      semgrep: "pipx install semgrep（SAST 唯一后端，需 Python；semgrep 原生 Windows 支持为实验性，推荐在 WSL 中运行）",
      gitleaks: "winget install Gitleaks.Gitleaks 或 scoop install gitleaks（可选：secrets 能力已可由 trivy 覆盖）",
      "osv-scanner": "scoop install osv-scanner（可选：deps 能力已可由 trivy 覆盖）",
    }
  : {
      trivy: "brew install trivy（推荐：一个二进制覆盖 secrets + deps 两个能力）",
      semgrep: "brew install semgrep 或 pipx install semgrep（SAST 唯一后端）",
      gitleaks: "brew install gitleaks（可选：secrets 能力已可由 trivy 覆盖）",
      "osv-scanner": "brew install osv-scanner（可选：deps 能力已可由 trivy 覆盖）",
    };

const ALLOWED_ARGS = ["help", "target", "output", "tools", "gate", "json", "doctor"];

const USAGE = {
  usage: "node .xflow/scripts/xf-security-scan.mjs [--target <dir>] [--gate] [--doctor]",
  description:
    "编排安全扫描，按能力选择本机可用后端：\n" +
    "  secrets（密钥泄漏）: gitleaks > trivy\n" +
    "  deps（依赖漏洞）  : osv-scanner > trivy > npm audit\n" +
    "  sast（静态分析）  : semgrep\n" +
    "归一化输出到 xspec/changes/.security/scan-report.json。\n" +
    "全部后端缺失的能力自动跳过并在报告 capabilities 字段注明 backend=null。",
  optional: {
    "--doctor": "只探测本机工具矩阵，打印各能力可用后端与安装建议，不执行扫描",
    "--target <dir>": "扫描目标目录（默认：项目根目录）",
    "--output <dir>": "报告输出目录（默认：xspec/changes/.security/）",
    "--tools <list>": "只跑指定能力，逗号分隔：sast,secrets,deps（默认全跑；兼容 semgrep/gitleaks 旧名）",
    "--gate": "门禁模式：存在 HIGH 及以上发现时退出码 2（供 implement/archive 阻断）",
    "--json": "stdout 只输出 JSON 摘要（默认额外打印人类可读摘要）",
    "--help, -h": "打印本帮助并退出",
  },
  examples: [
    "node .xflow/scripts/xf-security-scan.mjs --doctor            # 看本机装了什么、缺什么",
    "node .xflow/scripts/xf-security-scan.mjs                     # 全量扫描，出报告",
    "node .xflow/scripts/xf-security-scan.mjs --gate              # implement 步骤 8 / archive 前置的阻断闸口",
    "node .xflow/scripts/xf-security-scan.mjs --tools secrets     # 只扫密钥",
  ],
  notes: [
    "报告中的发现需人工处置：真实漏洞 → 修复；误报 → 在扫描器自身的忽略配置",
    "（.semgrepignore / .gitleaksignore / .trivyignore / osv-scanner.toml）中登记理由，不允许直接改本脚本放行",
    "退出码 0=通过，2=门禁阻断，1=脚本错误（与 xf-check-invariants.mjs 约定一致）",
  ],
};

function which(cmd) {
  // Windows 无 which 命令，用 where 探测
  const finder = IS_WINDOWS ? "where" : "which";
  const r = spawnSync(finder, [cmd], { encoding: "utf-8" });
  return r.status === 0;
}

function run(cmd, argv, cwd) {
  // 扫描器在有发现时通常返回非 0，因此不以退出码判失败，以能否解析输出为准
  return spawnSync(cmd, argv, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * 扫描器执行结果守卫：spawn 失败或空输出一律判为 capability error。
 * 没有这层守卫时，`JSON.parse("" || "{}")` 会把"扫描器根本没跑成"
 * （如 semgrep --config auto 离线拉不到规则、二进制崩溃）静默解析为
 * "0 个发现"——门禁假通过。JSON 输出型扫描器成功时必有非空 stdout。
 */
export function guardScanRun(r, tool) {
  if (r.error) return `${tool} 执行失败：${r.error.message}`;
  if (!(r.stdout || "").trim()) {
    const tail = (r.stderr || "").trim().split("\n").slice(-2).join(" ").slice(0, 200);
    return `${tool} 无输出（退出码 ${r.status ?? "unknown"}）${tail ? `：${tail}` : ""}`;
  }
  return null;
}

export function normSeverity(s) {
  const v = String(s || "").toLowerCase();
  if (v === "critical" || v === "crit") return "critical";
  if (v === "high" || v === "error") return "high";
  if (["medium", "moderate", "warning", "warn"].includes(v)) return "medium";
  if (v === "low") return "low";
  return "info";
}

// ── 各后端扫描实现：统一返回 { findings } 或 { error } ──

export function parseSemgrepOutput(stdout) {
  try {
    const data = JSON.parse(stdout || "{}");
    return {
      findings: (data.results || []).map((res) => ({
        capability: "sast",
        tool: "semgrep",
        severity: normSeverity(res.extra?.severity),
        rule: res.check_id,
        file: res.path,
        line: res.start?.line ?? null,
        message: res.extra?.message || "",
      })),
    };
  } catch {
    return { error: "semgrep 输出解析失败" };
  }
}

function runSemgrep(target) {
  const r = run("semgrep", [
    "scan", "--config", "auto", "--json", "--quiet", "--metrics", "off", ".",
  ], target);
  const guardError = guardScanRun(r, "semgrep");
  if (guardError) return { error: guardError };
  return parseSemgrepOutput(r.stdout);
}

function runGitleaks(target, outputDir) {
  const reportPath = join(outputDir, "gitleaks-raw.json");
  const r = run("gitleaks", [
    "detect", "--source", target, "--no-banner", "--no-git",
    "--report-format", "json", "--report-path", reportPath, "--exit-code", "0",
  ], target);
  // gitleaks 结果走报告文件而非 stdout：--exit-code 0 下有发现也返回 0，
  // 非 0 退出码即真实失败（崩溃/参数错），不能落到"报告缺失 = 无发现"分支
  if (r.error) return { error: `gitleaks 执行失败：${r.error.message}` };
  if (r.status !== 0) {
    const tail = (r.stderr || "").trim().split("\n").slice(-2).join(" ").slice(0, 200);
    return { error: `gitleaks 异常退出（退出码 ${r.status}）${tail ? `：${tail}` : ""}` };
  }
  try {
    if (!existsSync(reportPath)) return { findings: [] };
    const data = JSON.parse(readFileSync(reportPath, "utf-8") || "[]");
    return {
      findings: data.map((leak) => ({
        capability: "secrets",
        tool: "gitleaks",
        severity: "high", // 密钥泄漏一律按 high 处置
        rule: leak.RuleID,
        file: leak.File,
        line: leak.StartLine ?? null,
        message: `疑似泄漏凭据（${leak.Description || leak.RuleID}），指纹 ${leak.Fingerprint || ""}`,
      })),
    };
  } catch {
    return { error: "gitleaks 输出解析失败" };
  }
}

/** trivy fs 输出解析；结果按 capability（secrets/deps）归类 */
export function parseTrivyOutput(stdout) {
  try {
    const data = JSON.parse(stdout || "{}");
    const findings = [];
    for (const result of data.Results || []) {
      for (const s of result.Secrets || []) {
        findings.push({
          capability: "secrets",
          tool: "trivy",
          severity: "high", // 密钥泄漏一律按 high 处置（trivy 自身分级仅作参考）
          rule: s.RuleID,
          file: result.Target,
          line: s.StartLine ?? null,
          message: `疑似泄漏凭据（${s.Title || s.RuleID}）`,
        });
      }
      for (const v of result.Vulnerabilities || []) {
        findings.push({
          capability: "deps",
          tool: "trivy",
          severity: normSeverity(v.Severity),
          rule: v.VulnerabilityID,
          file: result.Target,
          line: null,
          message: `${v.PkgName}@${v.InstalledVersion}: ${v.Title || v.VulnerabilityID}` +
            (v.FixedVersion ? `（修复版本 ${v.FixedVersion}）` : ""),
        });
      }
    }
    return { findings };
  } catch {
    return { error: "trivy 输出解析失败" };
  }
}

function runTrivy(target, scanners) {
  const r = run("trivy", [
    "fs", "--scanners", scanners.join(","), "--format", "json", "--quiet", target,
  ], target);
  const guardError = guardScanRun(r, "trivy");
  if (guardError) return { error: guardError };
  return parseTrivyOutput(r.stdout);
}

function runOsvScanner(target) {
  const r = run("osv-scanner", ["--format", "json", "-r", target], target);
  const guardError = guardScanRun(r, "osv-scanner");
  if (guardError) return { error: guardError };
  try {
    const data = JSON.parse(r.stdout || "{}");
    const findings = [];
    for (const result of data.results || []) {
      for (const pkg of result.packages || []) {
        for (const vuln of pkg.vulnerabilities || []) {
          findings.push({
            capability: "deps",
            tool: "osv-scanner",
            severity: normSeverity(
              vuln.database_specific?.severity || vuln.severity?.[0]?.type || "medium",
            ),
            rule: vuln.id,
            file: relative(target, result.source?.path || "") || result.source?.path || "",
            line: null,
            message: `${pkg.package?.name}@${pkg.package?.version}: ${vuln.summary || vuln.id}`,
          });
        }
      }
    }
    return { findings };
  } catch {
    return { error: "osv-scanner 输出解析失败" };
  }
}

function runNpmAudit(target) {
  const r = run(NPM_CMD, ["audit", "--json"], target);
  const guardError = guardScanRun(r, "npm audit");
  if (guardError) return { error: guardError };
  try {
    const data = JSON.parse(r.stdout || "{}");
    return {
      findings: Object.entries(data.vulnerabilities || {}).map(([name, adv]) => ({
        capability: "deps",
        tool: "npm-audit",
        severity: normSeverity(adv.severity),
        rule: (adv.via || []).map((v) => (typeof v === "object" ? v.source : v)).join(","),
        file: "package-lock.json",
        line: null,
        message: `${name}: ${adv.severity} 级依赖漏洞（${adv.range || ""}）`,
      })),
    };
  } catch {
    return { error: "npm audit 输出解析失败" };
  }
}

// ── 能力 → 后端选择 ──

function detectAvailability(target) {
  return {
    trivy: which("trivy"),
    semgrep: which("semgrep"),
    gitleaks: which("gitleaks"),
    "osv-scanner": which("osv-scanner"),
    "npm-audit": which("npm") && existsSync(join(target, "package-lock.json")),
  };
}

export function pickBackends(avail) {
  return {
    sast: avail.semgrep ? "semgrep" : null,
    secrets: avail.gitleaks ? "gitleaks" : avail.trivy ? "trivy" : null,
    deps: avail["osv-scanner"] ? "osv-scanner" : avail.trivy ? "trivy" : avail["npm-audit"] ? "npm-audit" : null,
  };
}

/** 按缺失能力算最小安装集：trivy 覆盖 secrets+deps，semgrep 是 sast 唯一后端 */
export function minimalInstallHint(missing) {
  const install = [];
  if (missing.includes("secrets") || missing.includes("deps")) install.push("trivy");
  if (missing.includes("sast")) install.push("semgrep");
  return install.length ? `装 ${install.join(" + ")}` : "";
}

export function summarize(findings) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  return bySeverity;
}

// ── 主流程 ──

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) main();

function main() {
const args = parseArgs(process.argv.slice(2));
handleHelpFlag(args, USAGE);
assertAllowedArgs(args, ALLOWED_ARGS, USAGE);

const { projectRoot: PROJECT_ROOT, outputDir: DEFAULT_OUTPUT_DIR } = resolveRoots();

const target = resolve(typeof args.target === "string" ? args.target : PROJECT_ROOT);
if (!existsSync(target)) {
  printUsageAndExit(USAGE, `扫描目标不存在：${target}`);
}

const avail = detectAvailability(target);
const backends = pickBackends(avail);

if (args.doctor) {
  const lines = ["🩺 xf-security-scan 工具矩阵", ""];
  for (const cap of CAPABILITIES) {
    const b = backends[cap];
    lines.push(`  ${cap.padEnd(7)} → ${b ? `✅ ${b}` : "❌ 无可用后端"}`);
  }
  lines.push("", "  本机工具：");
  for (const [tool, ok] of Object.entries(avail)) {
    lines.push(`    ${ok ? "✅" : "⬜"} ${tool}${!ok && INSTALL_HINTS[tool] ? ` — ${INSTALL_HINTS[tool]}` : ""}`);
  }
  const missing = CAPABILITIES.filter((c) => !backends[c]);
  if (missing.length) {
    lines.push("", `  ⚠️ 无覆盖的能力：${missing.join(", ")}。最小补齐方案：${minimalInstallHint(missing)}`);
  }
  console.error(lines.join("\n"));
  console.log(JSON.stringify({ capabilities: backends, tools: avail }));
  process.exit(0);
}

const outputDir = resolve(typeof args.output === "string" ? args.output : DEFAULT_OUTPUT_DIR);
mkdirSync(outputDir, { recursive: true });

let requestedCaps = CAPABILITIES;
if (typeof args.tools === "string") {
  requestedCaps = args.tools
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => TOOL_ALIASES[s] || s);
  const unknown = requestedCaps.filter((c) => !CAPABILITIES.includes(c));
  if (unknown.length) {
    printUsageAndExit(USAGE, `未知能力：${unknown.join(", ")}（可选：${CAPABILITIES.join(", ")}）`);
  }
}

const capabilities = {};
let findings = [];
// trivy 可能同时服务 secrets 和 deps，攒起来一次跑
const trivyScanners = [];

for (const cap of requestedCaps) {
  const backend = backends[cap];
  capabilities[cap] = { backend, requested: true };
  if (!backend) continue;
  if (backend === "trivy") {
    trivyScanners.push(cap === "secrets" ? "secret" : "vuln");
    continue;
  }
  const result =
    backend === "semgrep" ? runSemgrep(target)
    : backend === "gitleaks" ? runGitleaks(target, outputDir)
    : backend === "osv-scanner" ? runOsvScanner(target)
    : runNpmAudit(target);
  if (result.error) capabilities[cap].error = result.error;
  else findings = findings.concat(result.findings);
}

if (trivyScanners.length) {
  const result = runTrivy(target, trivyScanners);
  if (result.error) {
    for (const cap of requestedCaps) {
      if (capabilities[cap]?.backend === "trivy") capabilities[cap].error = result.error;
    }
  } else {
    findings = findings.concat(result.findings);
  }
}

findings.sort((a, b) => (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0));

const bySeverity = summarize(findings);
const gateBlocking = (bySeverity.critical || 0) + (bySeverity.high || 0);
const uncovered = requestedCaps.filter((c) => !capabilities[c].backend);
// 执行出错的能力与"无后端"同属覆盖缺口：不阻断门禁，但必须如实上报，不得算作"扫描通过"
const errored = requestedCaps.filter((c) => capabilities[c].error);

const report = {
  generated_by: "xf-security-scan.mjs",
  author: "cuiguangyu@bianfeng.com",
  target: relative(PROJECT_ROOT, target) || ".",
  capabilities,
  summary: bySeverity,
  findings,
};
const reportPath = join(outputDir, "scan-report.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");

const result = {
  pass: !(args.gate && gateBlocking > 0),
  gate: Boolean(args.gate),
  summary: bySeverity,
  blocking: gateBlocking,
  uncovered_capabilities: uncovered,
  errored_capabilities: errored,
  report: relative(PROJECT_ROOT, reportPath),
};

if (!args.json) {
  const lines = ["🛡️  安全扫描完成"];
  for (const cap of requestedCaps) {
    const c = capabilities[cap];
    if (!c.backend) {
      lines.push(`  - ${cap}: ⚠️ 无可用后端，已跳过（覆盖不完整，不等于无风险；--doctor 看安装建议）`);
    } else if (c.error) {
      lines.push(`  - ${cap}（${c.backend}）: ⚠️ ${c.error}`);
    } else {
      const n = findings.filter((f) => f.capability === cap).length;
      lines.push(`  - ${cap}（${c.backend}）: ${n} 个发现`);
    }
  }
  lines.push(
    `  汇总: critical=${bySeverity.critical} high=${bySeverity.high} ` +
      `medium=${bySeverity.medium} low=${bySeverity.low} info=${bySeverity.info}`,
  );
  lines.push(`  报告: ${result.report}`);
  if (args.gate && gateBlocking > 0) {
    lines.push(`  ⛔ 门禁阻断：存在 ${gateBlocking} 个 HIGH 及以上发现，请修复或在扫描器忽略配置中登记误报理由`);
  }
  console.error(lines.join("\n"));
}

console.log(JSON.stringify(result));
process.exit(result.pass ? 0 : 2);
}
