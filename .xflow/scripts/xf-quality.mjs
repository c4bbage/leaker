#!/usr/bin/env node
/**
 * xf-quality.mjs — xflow 节点级质量检查引擎（框架脚本，纯 Node，零 LLM）
 *
 * 职责（设计 方案 §13/§14，v2）：
 *   - L1 脚本判定：确定性规则（结构/占位符/格式/编号）直接 pass/fail。
 *   - L2 抽证据：semantic/script_evidence 规则抽 evidence pack（cross_ref/extracted/instruction），
 *     状态标 need_judge（落盘时转 pending_judge）；判定 100% 由 hub 独立裁判（agent-runner）完成。
 *   - 引擎从不调 LLM → 跨平台一致、可单测、零 token。
 *
 * 用法：
 *   node .xflow/scripts/xf-quality.mjs --node xf-clarify                 # 跑该节点全部规则，输出
 *   node .xflow/scripts/xf-quality.mjs --node xf-clarify --l1-only       # 命令内主 agent：判 L1、落盘、need_judge→pending_judge
 *   node .xflow/scripts/xf-quality.mjs --node xf-clarify --evidence-only # hub 裁判前：抽证据包输出（不落 <node>.json）
 *   node .xflow/scripts/xf-quality.mjs --rules G-1,S-6 --module user-auth
 *   node .xflow/scripts/xf-quality.mjs --node xf-design --json
 *
 * 退出码：0=无 L1 阻断 fail（need_judge 不影响）；1=有 L1 阻断 fail；2=脚本/配置错误。
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import {
  resolveFlowId, changesDir, modulesDir, resolveSpecRoot,
  flowFrameworkRoot, flowTemplatesDir, readChangeYaml,
  output, fatal, parseArgs, handleHelpFlag, assertAllowedArgs,
  qualityDir,
} from "./lib.mjs";
import { loadCatalog, buildManifest } from "./xf-manifest.mjs";

/** 配置/脚本错误 → 退出码 2（§4.2；区别于 L1 阻断的退出码 1） */
function configError(message) {
  console.error(`[xflow] Error: ${message}`);
  process.exit(2);
}

const USAGE = `用法: node .xflow/scripts/xf-quality.mjs [--node <id>] [--rules G-1,S-6] [--module <name>]
       [--l1-only] [--evidence-only] [--json] [--flow <flowId>]
  --node <id>         节点 id（xf-clarify/xf-brainstorm/xf-design/xf-detail/xf-task/xf-implement）
  --rules G-1,S-6     显式规则子集（覆盖 --node）
  --module <name>     只跑单个模块
  --l1-only           命令内用：判 L1、落盘 <node>.json/summary，need_judge→pending_judge
  --evidence-only     hub 裁判用：只抽证据输出 evidence pack（不落 <node>.json）
  --json              完整 JSON 输出到 stdout`;

const ALLOWED_ARGS = ["help", "node", "rules", "module", "l1-only", "evidence-only", "json", "flow"];
const TIMEOUT_MS = (() => {
  const raw = Number(process.env.XFLOW_QUALITY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
})();
const ENGINE_VERSION = "1.0-mvp";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// ─── 规则库加载（方案 §13.3；真解析，非空实现）────────────────────────────
function resolveRulesPath(flowId) {
  const candidates = [
    join(flowFrameworkRoot(flowId), "_shared", "doc-quality-rules.yaml"), // .xflow/<flow>/_shared/ (§13.3)
    join(SCRIPT_DIR, "..", "_shared", "doc-quality-rules.yaml"),          // .xflow/_shared/ (§4.1)
    join(dirname(SCRIPT_DIR), "_shared", "doc-quality-rules.yaml"),
    join(SCRIPT_DIR, "doc-quality-rules.yaml"), // .xflow/scripts/（installFlowScripts 整目录复制 pack/scripts 至此，含 .yaml）
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

/** 轻量解析 rules YAML：支持 inline 数组 [a,b]、block 列表（- item）、嵌套 map、标量。 */
function parseInlineArray(s) {
  return s
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((x) => x.trim().replace(/^["']|["']$/g, ""))
    .filter((x) => x.length > 0);
}

function unquote(s) {
  return s.replace(/^["']|["']$/g, "").trim();
}

export function parseRulesYaml(content) {
  const lines = content.split("\n");
  const rules = {};
  let version = null;
  let inRules = false;
  let curRule = null;      // 当前规则对象
  let curSub = null;       // 当前嵌套子块（如 config）
  let curListKey = null;   // 当前 block-list 的键（如 config.blacklist）
  let listIndent = -1;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.search(/\S/);
    const trimmed = line.trim();

    if (!inRules) {
      if (/^version\s*:/.test(trimmed)) { version = unquote(trimmed.split(":")[1] ?? ""); continue; }
      if (/^rules\s*:\s*$/.test(trimmed)) { inRules = true; continue; }
      continue;
    }

    // block-list item（- xxx）
    if (/^-\s/.test(trimmed) && curListKey && curRule) {
      const val = unquote(trimmed.replace(/^-\s*/, ""));
      const target = curSub && curSub[curListKey] !== undefined ? curSub : curRule;
      if (!Array.isArray(target[curListKey])) target[curListKey] = [];
      target[curListKey].push(val);
      continue;
    }

    // 规则 id（indent=2，键以冒号结尾或后跟子键）
    const ruleId = indent === 2 ? trimmed.match(/^([A-Z][A-Z0-9]*-\d+)\s*:/) : null;
    if (ruleId) {
      curRule = {};
      curSub = null;
      curListKey = null;
      rules[ruleId[1]] = curRule;
      // 可能 id 行同时带 inline 值（罕见）
      const rest = trimmed.slice(ruleId[0].length).trim();
      if (rest) Object.assign(curRule, parseScalarObj(ruleId[1], rest));
      continue;
    }

    if (!curRule) continue;

    // 字段键
    const kv = trimmed.match(/^([\w._-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const valPart = kv[2].trim();

    if (indent === 4) {
      curSub = null; curListKey = null;
      if (valPart === "") {
        // 嵌套块开始（如 config:）→ 后续更深缩进归入 curRule[key]
        curRule[key] = {};
        curSub = curRule[key];
      } else if (valPart.startsWith("[")) {
        curRule[key] = parseInlineArray(valPart);
      } else {
        curRule[key] = unquote(valPart);
      }
    } else if (indent >= 6 && curSub) {
      if (valPart === "") {
        // config 下的 block-list 子键（blacklist:）
        curListKey = key;
        curSub[key] = [];
      } else if (valPart.startsWith("[")) {
        curSub[key] = parseInlineArray(valPart);
      } else {
        curSub[key] = unquote(valPart);
      }
      listIndent = indent;
    }
  }

  function parseScalarObj(_id, rest) {
    // 形如 "G-1: { level: blocking }" 的行内简写（本库未用，兜底）
    const out = {};
    const m = rest.match(/^\{\s*([\w]+)\s*:\s*([^}]+)\s*\}$/);
    if (m) out[m[1]] = unquote(m[2]);
    return out;
  }

  return { version, rules };
}

export function loadRules(flowId) {
  const p = resolveRulesPath(flowId);
  if (!p) configError("未找到 doc-quality-rules.yaml");
  const { rules } = parseRulesYaml(readFileSync(p, "utf-8"));
  if (!rules || Object.keys(rules).length === 0) configError("doc-quality-rules.yaml 解析为空");
  return rules;
}

// ─── 节点归一与规则集（方案 §13.4）────────────────────────────────────────
export function normalizeNode(id) {
  if (!id) return "";
  return id.startsWith("xf-") ? id : `xf-${id}`;
}

export function rulesForNode(allRules, node) {
  const norm = normalizeNode(node);
  const out = [];
  for (const [id, r] of Object.entries(allRules)) {
    const phases = Array.isArray(r.phase) ? r.phase : [];
    if (phases.some((p) => normalizeNode(p) === norm)) out.push({ id, ...r });
  }
  return out;
}

// ─── 制品定位（方案 §13.5，走 change.yaml + manifest，不硬编码路径）─────────

/**
 * 阶段序号：拆分/澄清产物（spec/brainstorm）< design < detail < task < implement。
 * 用于"未到阶段的制品不检"：scaffold 在开变更时一次性铺齐全部模板文件，
 * clarify 阶段检 task.md 的占位符/空板块必然误报（它还是模板，本就不该在本阶段填写）。
 */
const PHASE_RANK = { brainstorm: 0, clarify: 0, design: 1, detail: 2, task: 3, implement: 4 };
export function phaseRankOf(id) {
  const n = normalizeNode(id).replace(/^xf-/, "");
  return PHASE_RANK[n] ?? 99; // 未知阶段 → 99（--rules 无 node 场景：不裁剪，全检）
}

export async function resolveTargets(flowId) {
  const change = await readChangeYaml(flowId);
  if (!change || !Array.isArray(change.affected_modules)) return { change, targets: [] };
  const catalog = await loadCatalog();
  const targets = [];
  for (const mod of change.affected_modules) {
    if (!mod || !mod.name) continue;
    const manifest = buildManifest({
      catalog,
      moduleType: mod.module_type,
      phase: null,
      allPhases: true,
      changeType: mod.change_type,
    });
    targets.push({
      module: mod.name,
      module_type: mod.module_type,
      change_type: mod.change_type,
      dir: join(changesDir(flowId), mod.name),
      baseDir: join(modulesDir(flowId), mod.name),
      manifestFiles: (manifest.files ?? []).map((f) => f.name),
      // 制品归属阶段（CATALOG.yaml file.phase）；key 去掉 .delta 以便 delta 文件同样命中
      manifestPhaseOf: Object.fromEntries(
        (manifest.files ?? [])
          .map((f) => [f.name.replace(/\.delta\.md$/, ".md"), f.phase])
          .filter(([, p]) => p),
      ),
    });
  }
  return { change, targets };
}

/**
 * 全变更制品指纹（方案 12 §4.1）：对受影响模块目录内存在的全部 *.md，
 * 按 模块名 → 文件名 排序拼接内容后 sha256 取前 16 位。
 * 写入方（本引擎落盘）与比对方（hub L1 重检链）必须用同一口径，否则 stale 判断失真。
 */
export function computeArtifactsFingerprint(targets) {
  const hash = createHash("sha256");
  const sorted = [...targets].sort((a, b) => a.module.localeCompare(b.module));
  for (const t of sorted) {
    let mds = [];
    try {
      for (const e of readdirSync(t.dir, { withFileTypes: true }))
        if (e.isFile() && e.name.endsWith(".md")) mds.push(e.name);
    } catch { continue; }
    for (const name of mds.sort()) {
      try { hash.update(readFileSync(join(t.dir, name))); } catch { /* 忽略单文件读失败 */ }
    }
  }
  return hash.digest("hex").slice(0, 16);
}

/** 规则 artifact ↔ 模块制品取交集；返回 [{name,path,baselinePath,exists}]。artifact 空=模块级(CODE)。
 *  nodeRank < ∞ 时裁剪：归属阶段晚于当前节点的制品（仍是 scaffold 模板）不参与本节点检查。 */
function matchArtifacts(rule, target, nodeRank = 99) {
  const arts = Array.isArray(rule.artifact) ? rule.artifact : [];
  if (arts.length === 0) return [{ name: null, path: null, baselinePath: null, exists: true }];
  let actualMds = [];
  try {
    for (const e of readdirSync(target.dir, { withFileTypes: true }))
      if (e.isFile() && e.name.endsWith(".md")) actualMds.push(e.name);
  } catch { /* 模块目录不存在 */ }
  const actualSet = new Set(actualMds);
  const manifestSet = new Set(target.manifestFiles);
  const names = new Set();
  for (const a of arts) {
    if (a === "*.md") { for (const m of actualMds) names.add(m); }
    else if (manifestSet.has(a) || actualSet.has(a)) names.add(a);
  }
  return [...names]
    .filter((name) => {
      const ownerPhase = target.manifestPhaseOf?.[name.replace(/\.delta\.md$/, ".md")];
      return !ownerPhase || phaseRankOf(ownerPhase) <= nodeRank;
    })
    .map((name) => {
      const path = join(target.dir, name);
      let baselinePath = null;
      if (target.change_type === "modified" && name.endsWith(".delta.md")) {
        const bp = join(target.baseDir, name.replace(/\.delta\.md$/, ".md"));
        if (existsSync(bp)) baselinePath = bp;
      }
      return { name, path, baselinePath, exists: existsSync(path) };
    });
}

// ─── ctx 构建（content / templateContent / relatedContent / baseline）─────
function readTemplateFor(flowId, moduleType, fileName) {
  if (!fileName) return null;
  const tdir = flowTemplatesDir(flowId);
  for (const mt of [moduleType, "_default"]) {
    const p = join(tdir, mt || "_default", fileName);
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }
  return null;
}

function relatedBaseKey(r) {
  return r.replace(/\.delta\.md$/, "").replace(/\.md$/, "");
}

function buildRelatedContent(flowId, rule, target) {
  const rel = {};
  for (const r of rule.related ?? []) {
    const key = relatedBaseKey(r);
    let path = null;
    if (r === "constitution.md") {
      path = [
        join(resolveSpecRoot(flowId), "constitution.md"),
        join(dirname(resolveSpecRoot(flowId)), "constitution.md"),
      ].find((p) => existsSync(p)) ?? null;
    } else if (r === "PRODUCT.md") {
      path = [
        join(modulesDir(flowId), "PRODUCT.md"),
        join(resolveSpecRoot(flowId), "PRODUCT.md"),
      ].find((p) => existsSync(p)) ?? null;
    } else {
      const deltaName =
        target.change_type === "modified" && r.endsWith(".md") && !r.endsWith(".delta.md")
          ? r.replace(/\.md$/, ".delta.md")
          : null;
      path = [
        deltaName && join(target.dir, deltaName),
        join(target.dir, r),
        join(target.baseDir, r),
      ].find((p) => p && existsSync(p)) ?? null;
    }
    if (path) rel[key] = readFileSync(path, "utf-8");
  }
  return rel;
}

// ─── Evidence Pack 构造器（方案 §4.6 冻结契约）──────────────────────────────
function evidencePack(rule, ctx, patch = {}) {
  return {
    rule: rule.id,
    name: rule.name ?? rule.id,
    level: rule.level ?? "blocking",
    check_kind: rule.check_kind ?? "semantic",
    module: ctx.module ?? null,
    artifact: ctx.path ?? ctx.artifact ?? null,
    status: "need_judge",                 // L1 handler 覆写 pass/fail；--l1-only 落盘转 pending_judge
    judged_by: null,
    auto_detail: null,
    evidence: { extracted: [], cross_ref: [], instruction: rule.description ?? "" },
    ...patch,
  };
}

// ─── 通用工具（移植自 feature-checkrules，§14.1）───────────────────────────
function stripCodeFences(text) {
  return text.replace(/```[\s\S]*?```/g, (m) => "\n".repeat(m.split("\n").length - 1));
}

function extractSections(text, levelRe = /^#{2,3}\s+(.+)$/gm) {
  const out = [];
  let m;
  levelRe.lastIndex = 0;
  while ((m = levelRe.exec(text)) !== null) {
    const raw = m[1].trim();
    out.push({ raw, norm: raw.replace(/^[\d.]+\s*/, "").trim() });
  }
  return out;
}

function extractACs(text) {
  const lines = text.split("\n");
  const acs = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    // 只认「AC 定义行」：行首（允许列表符/checkbox/表格管道/加粗前缀）即 AC-XX。
    // 行中提及不算定义——功能点元数据 `acs: AC-01, AC-02` 与正文引用（"见 AC-03"）
    // 行上无优先级/G-W-T，若当定义会把齐全的 AC 误报成缺项。
    const m = /^(?:[-*+]\s*(?:\[[ xX]\]\s*)?|\|\s*|\*\*)?AC-(\d+)\b/.exec(t);
    if (m) acs.push({ id: `AC-${m[1]}`, line: i + 1, text: t });
  }
  return acs;
}

/**
 * 定位「验收标准」章节正文（方案 12 T-E1：L1 解析不出 AC 时的升级证据源）。
 * 返回章节正文（截断 maxChars）；无该章节 → null（此时才是结构性缺失，可直判 fail）。
 */
function findAcceptanceSection(text, maxChars = 2000) {
  const lines = text.split("\n");
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (!h) continue;
    if (start >= 0 && h[1].length <= level) break; // 同级或更高级标题 → 章节结束
    if (start < 0 && /验收标准|验收条件|acceptance/i.test(h[2])) {
      start = i;
      level = h[1].length;
    }
  }
  if (start < 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s+/);
    if (h && h[1].length <= level) break;
    body.push(lines[i]);
    if (body.join("\n").length > maxChars) break;
  }
  const out = body.join("\n").trim();
  return out ? out.slice(0, maxChars) : null;
}

function extractTasks(text) {
  const lines = text.split("\n");
  const tasks = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const tm = l.match(/\bT(\d{3})\b/);
    if (!tm || !/^\s*[-*]\s*\[[ xX]\]/.test(l)) continue;
    tasks.push({
      id: `T${tm[1]}`,
      line: i + 1,
      raw: l.trim(),
      hasCheckbox: true,
      priority: (l.match(/\bP([012])\b/) || [])[0] ?? null,
      filePath: (l.match(/`?[\w./-]+\.(ts|tsx|js|jsx|py|go|vue|rs|java|md|sql|json|yaml)`?/) || [])[0] ?? null,
      refAC: l.match(/AC-\d+/g) || [],
      depends: (l.match(/depends:\s*([\w@, ]+)/) || [])[1]?.trim() ?? null,
    });
  }
  return tasks;
}

const SPEC_META_SECTIONS = /文档信息|修订记录|关键概念|术语|超出范围|假设|依赖|非功能|验收标准|背景|目标|索引/;
function extractFeatures(specText) {
  const lines = specText.split("\n");
  const feats = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^###\s+(.+)$/);
    if (!m) continue;
    const raw = m[1].trim();
    const num = (raw.match(/^([\d.]+)/) || [])[1] ?? "";
    const title = raw.replace(/^[\d.]+\s*/, "").trim();
    if (SPEC_META_SECTIONS.test(title)) continue;
    feats.push({ section: num, title, line: i + 1 });
  }
  return feats;
}

function extractHldAnchors(hldText) {
  const lines = hldText.split("\n");
  const anchors = [];
  let curHeading = "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h = l.match(/^#{2,4}\s+(.+)$/);
    if (h) {
      curHeading = h[1].replace(/^[\d.：:]+\s*/, "").trim();
      anchors.push({ loc: `hld L${i + 1}`, text: curHeading, kind: "heading" });
      continue;
    }
    const trow = l.match(/^\|\s*([^|]+?)\s*\|/);
    if (trow && !/^[-\s|:]+$/.test(l) && !/^\|\s*(项|字段|状态|阶段|cmdid|入口|需求点|分类|时间点|值|码)\b/.test(l)) {
      const cell = trow[1].trim();
      if (cell && cell.length <= 20 && !/^-+$/.test(cell))
        anchors.push({ loc: `hld L${i + 1}(${curHeading})`, text: cell, kind: "table" });
    }
    const mm = l.match(/["\[]([^"\]]{2,20})["\]]/);
    if (mm) anchors.push({ loc: `hld L${i + 1}`, text: mm[1].trim(), kind: "mermaid" });
  }
  return anchors;
}

function tokenizeCn(s) {
  const cn = s.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const tokens = new Set();
  for (const seg of cn) {
    tokens.add(seg);
    for (let n = 2; n <= 3; n++)
      for (let i = 0; i + n <= seg.length; i++) tokens.add(seg.slice(i, i + n));
  }
  return [...tokens].filter((t) => t.length >= 2);
}

/** 空板块判定（§14.1；"不适用"须带理由才算非空） */
function findEmptySections(content) {
  const lines = content.split("\n");
  const empty = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+)/);
    if (!m) continue;
    const title = m[1].trim();
    let hasContent = false, onlyNA = true, j = i + 1;
    while (j < lines.length && !lines[j].match(/^##\s/)) {
      const t = lines[j].trim();
      if (t && !t.startsWith(">") && !t.startsWith("---")) {
        hasContent = true;
        if (!/^不适用[，。:：]?\s*\S+/.test(t) && t !== "不适用") onlyNA = false;
      }
      j++;
    }
    if (!hasContent || onlyNA) empty.push(title);
  }
  return empty;
}

// 模板占位示例板块判定（FR-NNN / {{…}} / [接口名称] / [EntityName] 等）：实际制品会把
// 占位标题替换为真实名称，G-1 不应把这类占位板块当"必填缺失"误报。
// 模板约定：标题里的 [...] 一律是待替换占位（[接口名称]/[实体名，如：User]/[决策标题]/
// [核心流程名称]…），因此含 [...] 的期望标题整体豁免。
function isPlaceholderSectionName(norm) {
  if (!norm) return true;
  return (
    /\b(NNN|XXX|NN)\b/.test(norm) ||
    norm.includes("{{") ||
    /\[[^\]]+\]/.test(norm)
  );
}

// ─── 规则 handler 注册表（§14；need_judge 术语；L1 覆写 status，L2 只抽证据）─
const HANDLERS = {
  // G-1 结构完整（L1）：模板必填板块 − 实际板块 = 缺失
  "G-1": (rule, ctx) => {
    const pack = evidencePack(rule, ctx, { check_kind: "script", judged_by: "script" });
    if (!ctx.templateContent) {
      pack.status = "skip"; pack.auto_detail = "无对应模板可对照"; return pack;
    }
    // 排除模板自身的占位示例板块（FR-NNN/{{…}}/[功能模块…] 等），实际 spec 会替换为真实 FR，
    // 不应把占位板块当"必填缺失"误报（否则任何合规 spec 都会因 FR-NNN 失败）。
    const expected = extractSections(ctx.templateContent)
      .map((s) => s.norm)
      .filter((n) => !isPlaceholderSectionName(n));
    const actual = new Set(extractSections(ctx.content).map((s) => s.norm));
    const missing = expected.filter((e) => !actual.has(e));
    pack.status = missing.length === 0 ? "pass" : "fail";
    if (missing.length) pack.auto_detail = `缺失板块：${missing.join("、")}`;
    return pack;
  },

  // G-2 无占位符/TODO（L1）
  "G-2": (rule, ctx) => {
    const pack = evidencePack(rule, ctx, { check_kind: "script", judged_by: "script" });
    const body = stripCodeFences(ctx.content);
    const patterns = [
      { re: /\[[A-Z_]{3,}\]/g, name: "大写占位符" },
      { re: /\b(TODO|FIXME|XXX)\b/g, name: "TODO 标记" },
      { re: /<[^>]*…[^>]*>/g, name: "省略号占位" },
      { re: /\[(描述|如：|待补充|示例)[^\]]*\]/g, name: "模板示例文字" },
    ];
    const hits = [];
    for (const p of patterns) {
      const found = body.match(p.re);
      if (found) hits.push(`${p.name}(${[...new Set(found)].slice(0, 5).join(",")})`);
    }
    pack.status = hits.length === 0 ? "pass" : "fail";
    if (hits.length) pack.auto_detail = `残留：${hits.join("；")}`;
    return pack;
  },

  // G-3 无空板块（L1）
  "G-3": (rule, ctx) => {
    const pack = evidencePack(rule, ctx, { check_kind: "script", judged_by: "script" });
    const empty = findEmptySections(ctx.content);
    pack.status = empty.length === 0 ? "pass" : "fail";
    if (empty.length) pack.auto_detail = `空/仅占位板块：${empty.join("、")}`;
    return pack;
  },

  // G-5 模糊词（L1 定位 + L2 复核）
  "G-5": (rule, ctx) => {
    const pack = evidencePack(rule, ctx, { check_kind: "script_evidence" });
    const blacklist = rule.config?.blacklist ?? [
      "若干", "适当", "合理", "尽可能", "大量", "部分", "如有必要", "正常情况", "一般来说", "较快", "较好",
    ];
    const body = stripCodeFences(ctx.content).split("\n");
    body.forEach((line, i) => {
      const hit = blacklist.find((w) => line.includes(w));
      if (hit) pack.evidence.extracted.push({ loc: `${ctx.artifact} L${i + 1}`, text: line.trim(), hit_word: hit });
    });
    pack.status = pack.evidence.extracted.length === 0 ? "pass" : "need_judge";
    if (pack.status === "pass") pack.judged_by = "script";
    return pack;
  },

  // S-6 AC 编号 + 优先级（L1；判不准升级裁判 —— 方案 12 T-E1）
  "S-6": (rule, ctx) => {
    const pack = evidencePack(rule, ctx, { check_kind: "script", judged_by: "script" });
    const acs = extractACs(ctx.content);
    if (acs.length === 0) {
      // 有验收标准章节但解析不出 AC 定义行 → 抽章节原文转裁判，不直接 fail
      const section = findAcceptanceSection(ctx.content);
      if (section) {
        pack.status = "need_judge";
        pack.judged_by = null;
        pack.evidence.extracted.push({ loc: `${ctx.artifact} 验收标准章节`, text: section });
        pack.evidence.instruction =
          "脚本未能从验收标准章节解析出形如 AC-XX 的定义行。请阅读所给章节原文判定：若其中不存在可识别的验收标准（AC），或 AC 普遍无优先级（P0/P1/P2）标注 → FAIL；若 AC 与优先级可辨识（即便格式特殊）→ PASS。";
        return pack;
      }
      pack.status = "fail";
      pack.auto_detail = "未找到验收标准章节及任何 AC-XX 编号的验收标准";
      return pack;
    }
    const bad = acs.filter((ac) => !/\bP[012]\b/.test(ac.text));
    pack.status = bad.length === 0 ? "pass" : "fail";
    if (bad.length) pack.auto_detail = `缺优先级：${bad.map((a) => a.id).join("、")}`;
    return pack;
  },

  // S-7 AC 三要素（L1 查词 + L2 判 Then 可观测；判不准升级裁判 —— 方案 12 T-E1）
  "S-7": (rule, ctx) => {
    const pack = evidencePack(rule, ctx, { check_kind: "script_evidence" });
    const acs = extractACs(ctx.content);
    if (acs.length === 0) {
      const section = findAcceptanceSection(ctx.content);
      if (section) {
        pack.status = "need_judge";
        pack.judged_by = null;
        pack.evidence.extracted.push({ loc: `${ctx.artifact} 验收标准章节`, text: section });
        pack.evidence.instruction =
          "脚本未能从验收标准章节解析出形如 AC-XX 的定义行。请阅读所给章节原文判定：每条验收标准是否具备 Given/When/Then 三要素且 Then 可观测；无法辨识任何验收标准或普遍缺要素 → FAIL。";
        return pack;
      }
      pack.status = "fail";
      pack.auto_detail = "无验收标准章节，无 AC 可检";
      return pack;
    }
    const missing3 = [];
    for (const ac of acs) {
      const hasG = /Given|给定/.test(ac.text);
      const hasW = /When|当/.test(ac.text);
      const hasT = /Then|则|那么/.test(ac.text);
      if (!(hasG && hasW && hasT)) missing3.push(ac.id);
      else pack.evidence.extracted.push({ loc: `${ctx.artifact} L${ac.line}`, text: ac.text });
    }
    if (missing3.length) {
      pack.status = "fail"; pack.judged_by = "script";
      pack.auto_detail = `缺 G/W/T 要素：${missing3.join("、")}`;
    } else {
      pack.status = "need_judge";
    }
    return pack;
  },

  // S-8 AC 覆盖功能点（L2 semantic）
  "S-8": (rule, ctx) => {
    const pack = evidencePack(rule, ctx);
    const features = extractFeatures(ctx.content);
    const acs = extractACs(ctx.content).map((a) => a.text);
    features.forEach((f) => pack.evidence.cross_ref.push({ left: `功能点 ${f.section} ${f.title}`.trim(), right_candidates: acs }));
    pack.evidence.instruction =
      "对每个功能点，从 AC 全集里找语义覆盖它的 AC（按含义非编号）；P0 功能点须有 P0 AC。列出「功能点→AC」映射，无覆盖即 FAIL。";
    return pack;
  },

  // H-3 功能点→架构落点（L2）：spec 功能点 vs hld 落点锚
  "H-3": (rule, ctx) => {
    const pack = evidencePack(rule, ctx);
    const specText = ctx.relatedContent?.spec ?? "";
    const hldText = ctx.content ?? "";
    const features = extractFeatures(specText);
    const anchors = extractHldAnchors(hldText);
    for (const f of features) {
      const tokens = tokenizeCn(f.title);
      const hits = anchors.filter((a) => tokens.some((t) => a.text.includes(t)));
      pack.evidence.cross_ref.push({
        left: `功能点 ${f.section} ${f.title}`.trim(),
        left_loc: `spec#${f.section} L${f.line}`,
        right_candidates: hits.slice(0, 6).map((a) => `${a.loc} 「${a.text}」`),
        coverage_hint: hits.length === 0 ? "suspect_no_landing" : "has_candidate",
      });
    }
    pack.evidence.instruction =
      "逐个 spec 功能点在 hld 架构里找承接落点；coverage_hint=suspect_no_landing 重点复核；列「功能点→hld落点」映射，确无落点即 FAIL。";
    return pack;
  },

  // H-4 架构方向已选定（L2，补全）：抽 hld 选型/方向/决策段落 + 宪章约束
  "H-4": (rule, ctx) => {
    const pack = evidencePack(rule, ctx);
    const hldText = ctx.content ?? "";
    const sections = extractSections(hldText, /^#{2,3}\s+(.+)$/gm);
    const dirSections = sections.filter((s) => /选型|方向|决策|架构|方案/.test(s.norm));
    for (const s of dirSections) {
      const body = sliceSection(hldText, s.raw);
      if (body.trim()) pack.evidence.extracted.push({ loc: `hld#「${s.norm}」`, text: body.trim().slice(0, 500) });
    }
    const constitution = ctx.relatedContent?.constitution ?? "";
    const constPrinciples = extractSections(constitution, /^#{2,3}\s+(.+)$/gm)
      .filter((s) => /原则|约束|红线|技术/.test(s.norm))
      .map((s) => s.raw);
    constPrinciples.forEach((c) => pack.evidence.cross_ref.push({ left: `架构决策`, right_candidates: [c] }));
    pack.evidence.instruction =
      "确认①方向已明确选定（非待定）；②选定理由引用宪章约束或需求特征。贴选型原文 + 对应宪章条目。多方向须有备选+风险。";
    return pack;
  },

  // D-3 AC 实现落点（L2，补全）：P0/P1 AC 为 left；design/contracts/data-model 锚为 right
  "D-3": (rule, ctx) => {
    const pack = evidencePack(rule, ctx);
    const specText = ctx.relatedContent?.spec ?? "";
    const acs = extractACs(specText).filter((a) => /\bP[01]\b/.test(a.text));
    const anchors = [
      ...extractHldAnchors(ctx.content ?? ""),
      ...extractHldAnchors(ctx.relatedContent?.contracts ?? ""),
      ...extractHldAnchors(ctx.relatedContent?.["data-model"] ?? ""),
    ];
    for (const ac of acs) {
      const tokens = tokenizeCn(ac.text);
      const hits = anchors.filter((a) => tokens.some((t) => a.text.includes(t)));
      pack.evidence.cross_ref.push({
        left: `${ac.id}(${(/\bP([012])\b/.exec(ac.text) || [])[0] ?? ""}) ${ac.text.slice(0, 60)}`,
        left_loc: `spec L${ac.line}`,
        right_candidates: hits.slice(0, 6).map((a) => `${a.loc} 「${a.text}」`),
        coverage_hint: hits.length === 0 ? "suspect_no_landing" : "has_candidate",
      });
    }
    pack.evidence.instruction =
      "逐条 P0/P1 AC 在设计制品找承接的组件/接口/数据结构，列「AC→落点」映射；无落点即 FAIL。P2 不实现须显式声明。";
    return pack;
  },

  // DM-6 字段可定位（L2，补全）：引用字段 ∋ 已定义字段，差集为孤悬候选
  "DM-6": (rule, ctx) => {
    const pack = evidencePack(rule, ctx);
    const defined = extractFieldNames(ctx.content ?? "");
    const refs = new Set();
    for (const src of [ctx.relatedContent?.contracts, ctx.relatedContent?.design]) {
      if (!src) continue;
      for (const f of extractFieldNames(src)) refs.add(f);
    }
    const allowed = new Set(defined);
    const orphan = [...refs].filter((f) => !allowed.has(f));
    for (const o of orphan.slice(0, 30)) pack.evidence.cross_ref.push({ left: `字段 ${o}`, right_candidates: defined.slice(0, 12), coverage_hint: "suspect_orphan" });
    pack.evidence.auto_defined_count = defined.length;
    pack.evidence.instruction =
      "对每个 suspect_orphan 字段确认是否真在 data-model 有定义（考虑嵌套/命名转换）；确无即 FAIL。";
    return pack;
  },

  // C-1 接口六要素（L1 方法/路径 + L2 其余，补全）
  "C-1": (rule, ctx) => {
    const pack = evidencePack(rule, ctx, { check_kind: "script_evidence" });
    const dims = rule.config?.dimensions ?? {};
    const content = ctx.content ?? "";
    const blocks = content.split(/^#{2,3}\s+/m).filter((b) => b.trim());
    const suspects = [];
    for (const b of blocks) {
      const head = b.split("\n")[0].trim();
      const lower = b;
      const missing = [];
      if (!/GET|POST|PUT|DELETE|PATCH|\b(method|方法)\b/i.test(lower) && !(dims.method ?? []).some((k) => lower.includes(k))) missing.push("method");
      if (!/(\/api|\/v1|\/[a-z])/i.test(lower) && !(dims.path ?? []).some((k) => lower.includes(k))) missing.push("path");
      if (!(dims.request ?? []).some((k) => lower.includes(k)) && !/入参|参数|body/i.test(lower)) missing.push("request");
      if (!(dims.response ?? []).some((k) => lower.includes(k)) && !/响应|返回/i.test(lower)) missing.push("response");
      if (!(dims.error ?? []).some((k) => lower.includes(k)) && !/错误码/i.test(lower)) missing.push("error");
      if (!(dims.auth ?? []).some((k) => lower.includes(k)) && !/鉴权|认证|权限/i.test(lower)) missing.push("auth");
      if (missing.length) suspects.push({ head: head.slice(0, 40), missing });
    }
    if (blocks.length === 0) { pack.status = "fail"; pack.judged_by = "script"; pack.auto_detail = "contracts 无接口内容"; return pack; }
    if (suspects.length === 0) { pack.status = "pass"; pack.judged_by = "script"; return pack; }
    suspects.slice(0, 15).forEach((s) =>
      pack.evidence.extracted.push({ loc: `contracts#「${s.head}」`, text: `缺要素：${s.missing.join(",")}` }));
    pack.status = "need_judge";
    return pack;
  },

  // T-1 任务格式（L1）
  "T-1": (rule, ctx) => {
    const pack = evidencePack(rule, ctx, { check_kind: "script", judged_by: "script" });
    const tasks = extractTasks(ctx.content);
    if (tasks.length === 0) { pack.status = "fail"; pack.auto_detail = "未找到任何合法任务行（- [ ] T001 ...）"; return pack; }
    const problems = [];
    const ids = tasks.map((t) => parseInt(t.id.slice(1), 10));
    const dup = ids.filter((n, i) => ids.indexOf(n) !== i);
    if (dup.length) problems.push(`编号重复：T${[...new Set(dup)].map((n) => String(n).padStart(3, "0")).join(",T")}`);
    for (const t of tasks) {
      if (!t.priority) problems.push(`${t.id} 缺优先级`);
      if (!t.filePath) problems.push(`${t.id} 缺文件路径`);
    }
    pack.status = problems.length === 0 ? "pass" : "fail";
    if (problems.length) pack.auto_detail = problems.slice(0, 10).join("；");
    return pack;
  },

  // T-3 AC→任务追溯（L2，补全）：脚本报「无任务引用的 AC」，agent 复核
  "T-3": (rule, ctx) => {
    const pack = evidencePack(rule, ctx);
    const specText = ctx.relatedContent?.spec ?? "";
    const acs = extractACs(specText);
    const tasks = extractTasks(ctx.content ?? "");
    const referenced = new Set(tasks.flatMap((t) => t.refAC));
    const uncovered = acs.filter((a) => !referenced.has(a.id));
    uncovered.slice(0, 20).forEach((a) =>
      pack.evidence.cross_ref.push({ left: `${a.id}(${(/\bP([012])\b/.exec(a.text) || [])[0] ?? ""}) ${a.text.slice(0, 50)}`, right_candidates: tasks.map((t) => t.id).slice(0, 10), coverage_hint: "suspect_no_task" }));
    pack.evidence.auto_detail2 = uncovered.length ? `无任务引用的 AC：${uncovered.map((a) => a.id).join("、")}` : null;
    pack.evidence.instruction =
      "确认每个功能任务关联 AC；对「无任务的 AC」复核是否真遗漏。P0 AC 缺任务即 FAIL(高危)。";
    return pack;
  },

  // T-6 依赖方向合规（L2，补全）：PRODUCT.md 声明 vs task 跨模块依赖
  "T-6": (rule, ctx) => {
    const pack = evidencePack(rule, ctx);
    const tasks = extractTasks(ctx.content ?? "");
    const crossDeps = [];
    for (const t of tasks) {
      const deps = (t.depends ?? "").split(/[,，]\s*/).map((d) => d.trim()).filter((d) => d.includes("@"));
      for (const d of deps) crossDeps.push({ task: t.id, dep: d });
    }
    const product = ctx.relatedContent?.PRODUCT ?? "";
    crossDeps.slice(0, 20).forEach((c) =>
      pack.evidence.cross_ref.push({ left: `${c.task} → ${c.dep}`, right_candidates: ["见 PRODUCT.md 依赖声明"], coverage_hint: "suspect_direction" }));
    if (product) pack.evidence.extracted.push({ loc: "PRODUCT.md", text: product.slice(0, 200) });
    pack.evidence.instruction =
      "对照 PRODUCT.md 依赖方向，确认跨模块依赖无未声明/反向/环。环/反向即 FAIL。贴依赖边 + PRODUCT.md 声明。";
    return pack;
  },

  // CODE-1 构建/测试全绿（L1，执行真实命令；拿不到命令→unverifiable）
  "CODE-1": (rule, ctx) => {
    const pack = evidencePack(rule, ctx, { check_kind: "script", judged_by: "script" });
    const cmds = rule.config?.commands ?? ["npm run build", "npm run lint", "npm run typecheck", "npm test"];
    const timeout = Number(rule.config?.timeout_ms ?? 300000);
    if (!existsSync(join(process.cwd(), "package.json"))) {
      pack.status = "unverifiable";
      pack.auto_detail = "当前目录无 package.json，无法执行构建/测试命令（不默认 pass）";
      return pack;
    }
    const failures = [];
    for (const cmd of cmds) {
      const [bin, ...a] = cmd.split(/\s+/);
      const r = spawnSync(bin, a, { shell: true, timeout, cwd: process.cwd(), encoding: "utf-8" });
      if (r.error && r.error.code === "ENOENT") { pack.status = "unverifiable"; pack.auto_detail = `命令不可用：${cmd}`; return pack; }
      if (r.status !== 0) failures.push(`${cmd} (exit=${r.status})`);
    }
    pack.status = failures.length === 0 ? "pass" : "fail";
    if (failures.length) pack.auto_detail = `失败命令：${failures.join("；")}`;
    return pack;
  },

  // CODE-2 测试先行（L2，补全）：git 提交时序；拿不到→unverifiable
  "CODE-2": (rule, ctx) => {
    const pack = evidencePack(rule, ctx);
    const gitLog = spawnSync("git", ["log", "--oneline", "--name-status", "-30"], { cwd: process.cwd(), encoding: "utf-8" });
    if (gitLog.status !== 0) {
      pack.status = "unverifiable"; pack.judged_by = "script";
      pack.auto_detail = "无法读取 git 提交时序（不可取证，不默认 pass）";
      return pack;
    }
    const lines = gitLog.stdout.split("\n").filter(Boolean);
    const commits = lines.filter((l) => /^[0-9a-f]{7,}\s/.test(l));
    const testTouches = lines.filter((l) => /\.(test|spec)\.(ts|js|tsx|jsx|py)/.test(l));
    pack.evidence.extracted.push({ loc: "git log", text: `近30次提交 ${commits.length} 次，其中测试文件变更 ${testTouches.length} 处` });
    pack.evidence.instruction =
      "基于提交时序判断红→绿是否真实发生；对可疑放宽断言逐处确认。无证据须报「无法取证」而非 PASS。";
    return pack;
  },

  // CODE-5 实现与设计一致（L2，补全）：contracts/data-model vs 代码（抽证据交 judge）
  "CODE-5": (rule, ctx) => {
    const pack = evidencePack(rule, ctx);
    const contracts = ctx.relatedContent?.contracts ?? "";
    const dm = ctx.relatedContent?.["data-model"] ?? "";
    const ifaces = extractHldAnchors(contracts).filter((a) => a.kind === "table" || a.kind === "heading");
    const fields = extractFieldNames(dm);
    pack.evidence.cross_ref.push({ left: "contracts 接口签名", right_candidates: ifaces.slice(0, 12).map((a) => a.text), coverage_hint: "needs_code_check" });
    pack.evidence.cross_ref.push({ left: "data-model 字段", right_candidates: fields.slice(0, 12), coverage_hint: "needs_code_check" });
    pack.evidence.instruction =
      "逐个对照设计接口/字段与代码实现，签名/字段不一致即 FAIL，贴设计原文 + 代码原文。";
    return pack;
  },

  // CODE-6 任务勾选与代码索引一致性（设计 17 · C3；advisory：自检线索，非裁决，不影响退出码）
  // 交叉信号：task.md [x] 勾选（人工权威声明）× codegraph 文件已索引（客观事实）。
  // 已勾但声明文件未被索引 = "言行不一"线索（可能漏提交/漏 sync/路径不符），供自查。
  // 与 web 控制台 buildImplementReport（src/projection/codegraph.ts）同一算法、同一口径。
  // 只判"文件是否被索引"，绝不判"实现对错"；codegraph 缺失 → unverifiable，不误报。
  "CODE-6": (rule, ctx) => {
    const pack = evidencePack(rule, ctx, { check_kind: "script", judged_by: "script" });
    const taskMdPath = ctx.dir ? join(ctx.dir, "task.md") : null;
    if (!taskMdPath || !existsSync(taskMdPath)) {
      pack.status = "skip";
      pack.auto_detail = "无 task.md，无法交叉校验";
      return pack;
    }
    const dbPath = join(process.cwd(), ".codegraph", "codegraph.db");
    if (!existsSync(dbPath)) {
      pack.status = "unverifiable";
      pack.auto_detail = "codegraph 索引缺失（.codegraph/codegraph.db），无法交叉校验（可 xflow init/sync 建索引）";
      return pack;
    }
    const taskMd = readFileSync(taskMdPath, "utf-8");
    // 与 extractFilePathsFromTask 同口径：反引号 + 源码扩展名；排除测试文件
    const FILE_RE = /`([a-zA-Z0-9_./@-]+\.(?:vue|ts|tsx|js|jsx|mjs|cjs|py|go|rs|zig|c|cpp|h|hpp|java))`/g;
    const isTestFile = (p) => p.includes("__tests__") || /\.(test|spec)\.[a-z]+$/.test(p);
    const fileIndexed = (f) => {
      const r = spawnSync(
        "sqlite3",
        ["-json", `file:${dbPath}?mode=ro`,
          `SELECT COUNT(*) c FROM nodes WHERE file_path = '${f.replace(/'/g, "''")}';`],
        { encoding: "utf-8", timeout: 8000 },
      );
      if (r.error || r.status !== 0) return null; // sqlite3 不可用/查询失败 → 未知
      try {
        return ((JSON.parse(r.stdout.trim() || '[{"c":0}]')[0]?.c) ?? 0) > 0;
      } catch {
        return null;
      }
    };
    const inconsistencies = [];
    let checked = 0, consistent = 0, pending = 0;
    for (const line of taskMd.split("\n")) {
      const m = /^\s*-\s*\[([ xX])\]\s*(T\d{3})\b(.*)$/.exec(line);
      if (!m) continue;
      const done = m[1].toLowerCase() === "x";
      if (!done) { pending += 1; continue; }
      checked += 1;
      const files = new Set();
      for (const fm of m[3].matchAll(FILE_RE)) if (!isTestFile(fm[1])) files.add(fm[1]);
      if (files.size === 0) { consistent += 1; continue; } // 纯走查类：无文件可校，不误报
      const unindexed = [];
      for (const f of files) {
        const indexed = fileIndexed(f);
        if (indexed === null) {
          pack.status = "unverifiable";
          pack.auto_detail = "sqlite3 不可用或 codegraph.db 读取失败，无法交叉校验";
          return pack;
        }
        if (!indexed) unindexed.push(f);
      }
      if (unindexed.length === 0) consistent += 1;
      else inconsistencies.push({ task: m[2], unindexed });
    }
    pack.evidence.extracted.push({
      loc: "task.md × codegraph",
      text: `已勾任务 ${checked}（已实现 ${consistent}，待核实 ${inconsistencies.length}）；未勾 ${pending}`,
    });
    for (const it of inconsistencies.slice(0, 10)) {
      pack.evidence.extracted.push({
        loc: it.task,
        text: `已勾选完成，但代码图谱未找到声明的文件：${it.unindexed.join(", ")}（可能未提交/未 xflow sync/路径不符/实现在其他文件，建议核对）`,
      });
    }
    if (inconsistencies.length > 0) {
      pack.status = "fail";
      pack.auto_detail = `待核实 ${inconsistencies.length} 项：任务已勾选完成，但代码图谱未找到声明的代码文件（advisory 级，供自查，不阻断流程）`;
    } else {
      pack.status = "pass";
      pack.auto_detail = "已勾任务的声明文件均已在代码中找到（或任务未声明代码文件）";
    }
    return pack;
  },

  // R-2 研究结论回写（L2，补全；无 research.md 时整体 skip 由 matchArtifacts 处理）
  "R-2": (rule, ctx) => {
    const pack = evidencePack(rule, ctx);
    const research = ctx.content ?? "";
    const conclusions = extractSections(research, /^#{2,3}\s+(.+)$/gm).map((s) => s.norm);
    const designText = (ctx.relatedContent?.hld ?? "") + "\n" + (ctx.relatedContent?.design ?? "");
    for (const c of conclusions) {
      const tokens = tokenizeCn(c);
      const hit = tokens.some((t) => designText.includes(t));
      pack.evidence.cross_ref.push({ left: `研究结论 「${c}」`, right_candidates: ["hld/design 全文"], coverage_hint: hit ? "has_candidate" : "suspect_no_writeback" });
    }
    pack.evidence.instruction =
      "逐条研究结论确认是否在 hld/design 有实质回写（非仅关键词碰撞）；未回写即 FAIL。";
    return pack;
  },
};

function sliceSection(text, headingRaw) {
  const idx = text.indexOf(headingRaw);
  if (idx === -1) return "";
  const after = text.slice(idx + headingRaw.length);
  const next = after.search(/^#{2,3}\s+/m);
  return next === -1 ? after : after.slice(0, next);
}

function extractFieldNames(text) {
  const names = new Set();
  for (const m of text.matchAll(/`?([a-zA-Z_][a-zA-Z0-9_]*)`?\s*[:：|]/g)) {
    const n = m[1];
    if (n.length >= 2 && !/^(type|interface|const|function|return|value|label|name)$/i.test(n)) names.add(n);
  }
  for (const m of text.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g)) {
    const n = m[1];
    if (n.length >= 2) names.add(n);
  }
  return [...names];
}

// ─── 主流程 ─────────────────────────────────────────────────────────────────
export async function main(args) {
  const flowId = typeof args.flow === "string" ? args.flow : resolveFlowId();
  const normNode = normalizeNode(args.node);

  const allRules = loadRules(flowId);
  let ruleSet;
  if (typeof args.rules === "string") {
    const ids = args.rules.split(",").map((s) => s.trim()).filter(Boolean);
    ruleSet = ids.map((id) => (allRules[id] ? { id, ...allRules[id] } : { id }));
  } else if (typeof args.node === "string") {
    ruleSet = rulesForNode(allRules, normNode);
  } else {
    configError("需要 --node <id> 或 --rules <id列表>");
  }
  if (ruleSet.length === 0) {
    // 非质量检查清单内的节点（如拆分/归档/宪章）：干净跳过，不读 change.yaml、不报错。
    // wrapper 对每个节点命令都会调本脚本，须靠 node_skipped 让主 agent 直接略过。
    output({ node: normNode, flow: flowId, summary: { total: 0, node_skipped: true,
      skip_reason: "该节点不在质量检查清单内，无需检查" }, rules: [] });
    return;
  }

  const { change, targets } = await resolveTargets(flowId);
  if (!change) configError("未找到 change.yaml 或无 affected_modules");
  const scopedTargets = args.module ? targets.filter((t) => t.module === args.module) : targets;
  if (scopedTargets.length === 0) configError(args.module ? `模块 ${args.module} 不在 affected_modules` : "无可用模块");

  // 全变更制品指纹（落盘用，供 hub 判 stale / 触发重检；按全部 targets 算，与 --module 无关）
  const artifactsFingerprint = computeArtifactsFingerprint(targets);

  const packs = [];
  const nodeRank = phaseRankOf(normNode);
  for (const rule of ruleSet) {
    const handler = HANDLERS[rule.id];
    if (!allRules[rule.id] || !handler) {
      packs.push({ rule: rule.id, name: rule.name ?? rule.id, level: rule.level ?? "blocking",
        check_kind: rule.check_kind ?? "semantic", module: null, artifact: null,
        status: "error", judged_by: null, auto_detail: `未实现或不存在的规则 handler：${rule.id}`,
        evidence: { extracted: [], cross_ref: [], instruction: "" } });
      continue;
    }
    for (const target of scopedTargets) {
      const matched = matchArtifacts(rule, target, nodeRank);
      if (matched.length === 0) {
        packs.push({ ...evidencePack(rule, { module: target.module }), status: "skip",
          auto_detail: "该模块无此制品（不适用当前节点/模块类型）" });
        continue;
      }
      for (const art of matched) {
        if (!art.exists) {
          packs.push({ ...evidencePack(rule, { module: target.module, artifact: art.name, path: art.path }),
            status: "skip", auto_detail: `制品不存在：${art.name}` });
          continue;
        }
        const ctx = {
          module: target.module,
          module_type: target.module_type,
          artifact: art.name,
          path: art.path,
          // 模块级规则（CODE 组，artifact:[]）无挂靠制品 → art.path=null，不能 readFileSync(null)
          content: art.path ? readFileSync(art.path, "utf-8") : null,
          // 模块目录（CODE-6 等模块级规则读 task.md 用）
          dir: target.dir,
          templateContent: art.name ? readTemplateFor(flowId, target.module_type, art.name) : null,
          baseline: art.baselinePath ? readFileSync(art.baselinePath, "utf-8") : null,
          relatedContent: buildRelatedContent(flowId, rule, target),
        };
        try {
          packs.push(handler(rule, ctx));
        } catch (e) {
          packs.push({ ...evidencePack(rule, ctx), status: "error", auto_detail: `handler 异常：${e.message}` });
        }
      }
    }
  }

  const summary = computeSummary(packs);
  const l1Fail = packs.filter((p) => p.level === "blocking" && p.status === "fail").length;

  // ——evidence-only：只抽证据输出，不落 <node>.json（hub 裁判用）——
  if (args["evidence-only"]) {
    output({ node: normNode, flow: flowId, generated_at: new Date().toISOString(), summary, rules: packs });
    return;
  }

  // ——l1-only：命令内主 agent 用，need_judge→pending_judge，落盘 <node>.json + summary.json——
  if (args["l1-only"]) {
    const finalPacks = packs.map((p) => (p.status === "need_judge" ? { ...p, status: "pending_judge" } : p));
    await writeQualityFiles(flowId, normNode, finalPacks, change?.id ?? null, artifactsFingerprint);
    output({ node: normNode, summary: computeSummary(finalPacks), rules: finalPacks });
    // 用 exitCode 而非 process.exit：exit 会在 stdout flush 前杀进程，截断 JSON 输出
    process.exitCode = l1Fail > 0 ? 1 : 0;
    return;
  }

  // ——默认：输出结果（JSON）——
  output({ node: normNode, flow: flowId, generated_at: new Date().toISOString(), summary, rules: packs });
  return;
}

export function computeSummary(packs) {
  return {
    total: packs.length,
    l1_pass: packs.filter((p) => p.status === "pass").length,
    l1_fail: packs.filter((p) => p.status === "fail").length,
    need_judge: packs.filter((p) => p.status === "need_judge").length,
    pending_judge: packs.filter((p) => p.status === "pending_judge").length,
    skip: packs.filter((p) => p.status === "skip").length,
    unverifiable: packs.filter((p) => p.status === "unverifiable").length,
    error: packs.filter((p) => p.status === "error").length,
  };
}

async function writeQualityFiles(flowId, node, packs, changeId, sourceFingerprint = null) {
  const qd = qualityDir(flowId, changeId);
  if (!qd) return; // 无 changeId → 不落盘质量结果（避免污染全局目录）
  const generatedAt = new Date().toISOString();
  // 变更级 summary
  const byModule = {};
  for (const p of packs) {
    const m = p.module ?? "(module-level)";
    const e = (byModule[m] ??= { blocked: false, blocking_fail: 0, advisory_fail: 0, count: 0 });
    e.count++;
    if (p.status === "fail" && p.level === "blocking") e.blocking_fail++;
    if (p.status === "fail" && p.level === "advisory") e.advisory_fail++;
  }
  for (const m of Object.values(byModule)) m.blocked = m.blocking_fail > 0;
  const l1_blocked = Object.values(byModule).some((m) => m.blocking_fail > 0);
  const pending = packs.some((p) => p.status === "pending_judge");
  const summary = {
    node,
    blocked: l1_blocked,                  // L2 判完前暂等于 l1_blocked；hub 合并后更新
    l1_blocked,
    pending,
    pending_since: pending ? new Date().toISOString() : null,
    pending_count: packs.filter((p) => p.status === "pending_judge").length,
    skipped_l2: false,
    counts: {
      blocking_fail: packs.filter((p) => p.status === "fail" && p.level === "blocking").length,
      advisory_fail: packs.filter((p) => p.status === "fail" && p.level === "advisory").length,
    },
    modules: byModule,
    // 本次 L1 落盘时的制品指纹（方案 12 §4.1）：hub 判 stale / 触发重检的依据
    source_fingerprint: sourceFingerprint,
    generated_at: generatedAt,
  };
  await mkdir(qd, { recursive: true });
  await writeFile(join(qd, `${node}.summary.json`), JSON.stringify(summary, null, 2) + "\n", "utf-8");

  // 节点级 <node>.json（按模块分组写 quality/<changeId>/<module>/）
  const grouped = new Map();
  for (const p of packs) {
    const key = p.module ?? "(module-level)";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(p);
  }
  for (const [modName, modPacks] of grouped) {
    const blocked = modPacks.some((p) => p.status === "fail" && p.level === "blocking");
    const nodeDoc = {
      node,
      module: modName === "(module-level)" ? null : modName,
      generated_at: generatedAt,
      engine_version: ENGINE_VERSION,
      // 与 summary 同一份全变更指纹（方案 12 §4.2）：module 视图判 stale 就近取用
      source_fingerprint: sourceFingerprint,
      verdict: {
        blocked,
        counts: {
          blocking_fail: modPacks.filter((p) => p.status === "fail" && p.level === "blocking").length,
          advisory_fail: modPacks.filter((p) => p.status === "fail" && p.level === "advisory").length,
          unverifiable: modPacks.filter((p) => p.status === "unverifiable").length,
          pass: modPacks.filter((p) => p.status === "pass").length,
        },
      },
      rules: modPacks,
    };
    const dir = modName === "(module-level)" ? qd : join(qd, modName);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${node}.json`), JSON.stringify(nodeDoc, null, 2) + "\n", "utf-8");
  }
}

// ─── CLI 入口 + 30s 超时守卫（照抄 xf-validate 范式）───────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
let timer = null;
if (isMain) {
  timer = setTimeout(() => {
    console.error(`[xflow] Error: xf-quality.mjs timed out after ${TIMEOUT_MS / 1000}s`);
    process.exit(1);
  }, TIMEOUT_MS);

  (async () => {
    const args = parseArgs();
    handleHelpFlag(args, USAGE);
    assertAllowedArgs(args, ALLOWED_ARGS, USAGE);
    await main(args);
  })().then(() => {
    clearTimeout(timer);
  }).catch((err) => {
    clearTimeout(timer);
    console.error(`[xflow] Error: ${err.message}`);
    process.exit(2);
  });
}
