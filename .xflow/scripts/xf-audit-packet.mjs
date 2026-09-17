#!/usr/bin/env node

/**
 * xf-audit-packet.mjs — /xf-analyze 预烘焙审计包
 *
 * 审计中所有可机械提取的事实（AC 清单、任务清单、AC↔任务映射、威胁表、
 * 接口端点、模糊词命中、悬空依赖）由本脚本一次性提取为结构化 JSON，
 * agent 只做语义判断不做搬运——省 token 且提取结果确定、可测试。
 *
 * 职责边界：只提取事实，不做任何判断。"任务未引用 AC 编号但实质覆盖了它"
 * 这类语义对应关系仍由 agent 复核（机械映射保召回，agent 保精度）。
 *
 * 只读脚本：不写任何文件，输出到 stdout。
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  resolveFlowId,
  changesDir,
  parseArgs,
  printUsageAndExit,
  handleHelpFlag,
  assertAllowedArgs,
  fatal,
} from "./lib.mjs";
import { parseTaskFile } from "./xf-deps.mjs";

/**
 * change.yaml 元数据最小解析（id/name/phase + affected_modules）。
 * lib.mjs 的 parseChangeYaml 在多-Flow 重构后转为私有，这里只取审计所需字段，
 * 与 lib 的解析规则保持一致（顶层 key:value + affected_modules 列表项）。
 */
function parseChangeMeta(content) {
  const result = { affected_modules: [] };
  let current = null;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line || line.trimStart().startsWith("#")) continue;
    if (/^\s+-\s+name:/.test(line)) {
      current = { name: line.match(/name:\s*"?([^"]+)"?/)?.[1]?.trim() };
      result.affected_modules.push(current);
      continue;
    }
    if (current && /^\s+change_type:/.test(line)) {
      current.change_type = line.match(/change_type:\s*"?([^"]+)"?/)?.[1]?.trim();
      continue;
    }
    if (current && /^\s+type:/.test(line)) {
      const v = line.match(/type:\s*"?([^"]+)"?/)?.[1]?.trim();
      current.change_type = current.change_type || (v === "new" ? "added" : v);
      continue;
    }
    if (current && /^\s+module_type:/.test(line)) {
      current.module_type = line.match(/module_type:\s*"?([^"]+)"?/)?.[1]?.trim();
      continue;
    }
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      current = null;
      if (/^affected_modules:\s*$/.test(line)) continue;
      const m = line.match(/^(\w+):\s*"?([^"]*)"?\s*$/);
      if (m) result[m[1]] = m[2].trim();
    }
  }
  return result;
}

const ALLOWED_ARGS = ["help", "module", "dir", "json"];

const USAGE = {
  usage: "node .xflow/scripts/xf-audit-packet.mjs [--module <name>] [--json]",
  description:
    "为 /xf-analyze 预提取跨文档审计所需的机械事实（只读）：\n" +
    "  - change scope（include/exclude）与受影响模块\n" +
    "  - 各制品章节清单（标题 / 行号 / 内容长度，空章节一目了然）\n" +
    "  - AC 清单、任务清单、AC↔任务机械映射与未覆盖 AC\n" +
    "  - hld 安全设计威胁表行、contracts 接口端点、depends 悬空引用\n" +
    "  - spec/hld 模糊词命中行（等/若干/适当/合理/如有必要/尽可能）",
  optional: {
    "--module <name>": "只提取指定模块（默认：change.yaml 全部 affected_modules）",
    "--dir <path>": "changes 目录路径（默认：xspec/changes/；供 eval fixture 复用）",
    "--json": "stdout 只输出 JSON（默认额外打印人类可读摘要到 stderr）",
    "--help, -h": "打印本帮助并退出",
  },
  examples: [
    "node .xflow/scripts/xf-audit-packet.mjs",
    "node .xflow/scripts/xf-audit-packet.mjs --module user-auth",
  ],
  notes: [
    "机械映射保召回、agent 保精度：uncovered_acs 里的条目可能被未引用编号的任务实质覆盖，须语义复核",
    "vague_hits 是纯文本命中（如「合理性」也会命中「合理」），由 agent 过滤误报",
  ],
};

// ── 纯提取函数（导出供测试锁定契约） ──

/** 章节清单：标题 / 行号 / 内容字符数（chars=0 即空章节候选） */
export function extractSections(content) {
  const lines = content.split(/\r?\n/);
  const sections = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (m) {
      current = { level: m[1].length, title: m[2].trim(), line: i + 1, chars: 0 };
      sections.push(current);
    } else if (current) {
      const t = lines[i].trim();
      // 水平分隔线（---/***/___）是排版元素不算正文，否则"空章节 + 分隔线"读不出 chars=0
      if (/^([-*_])\1{2,}$/.test(t)) continue;
      current.chars += t.length;
    }
  }
  return sections;
}

/** AC 定义清单：每个 AC-XX 编号取首次出现行（spec 内即定义处） */
export function extractAcDefs(content, file) {
  const lines = content.split(/\r?\n/);
  const seen = new Map();
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/\bAC-\d{1,3}\b/g)) {
      if (!seen.has(m[0])) {
        seen.set(m[0], { id: m[0], file, line: i + 1, text: lines[i].trim() });
      }
    }
  }
  return [...seen.values()];
}

/** hld 安全设计章节内的威胁表行（跳过表头与分隔行，cells 为原始单元格） */
export function extractThreatRows(content, file) {
  const lines = content.split(/\r?\n/);
  const rows = [];
  let inSecurity = false;
  let securityLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (h) {
      if (/安全设计/.test(h[2])) {
        inSecurity = true;
        securityLevel = h[1].length;
      } else if (inSecurity && h[1].length <= securityLevel) {
        inSecurity = false;
      }
      continue;
    }
    if (!inSecurity || !/^\s*\|/.test(lines[i])) continue;
    const cells = lines[i].split("|").map((c) => c.trim()).filter((c, idx, arr) => idx > 0 && idx < arr.length - 1);
    if (!cells.length) continue;
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // 分隔行
    if (/^威胁$/.test(cells[0])) continue; // 表头
    rows.push({ file, line: i + 1, cells });
  }
  return rows;
}

/** contracts 接口端点：兼容表格行（| POST | /login |）与标题行（### POST /login） */
export function extractEndpoints(content, file) {
  const lines = content.split(/\r?\n/);
  const seen = new Map();
  for (let i = 0; i < lines.length; i++) {
    const normalized = lines[i].replace(/\|/g, " ");
    for (const m of normalized.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s`)]*)/g)) {
      const key = `${m[1]} ${m[2]}`;
      if (!seen.has(key)) {
        seen.set(key, { method: m[1], path: m[2], file, line: i + 1, text: lines[i].trim() });
      }
    }
  }
  return [...seen.values()];
}

/** 模糊词命中（analyze 步骤 9 的固定词表；"等"只匹配枚举收尾用法以降噪） */
export const VAGUE_TERMS = ["若干", "适当", "合理", "如有必要", "尽可能", "尽快"];

export function extractVagueHits(content, file) {
  const lines = content.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const term of VAGUE_TERMS) {
      if (line.includes(term)) hits.push({ file, line: i + 1, term, text: line.trim() });
    }
    if (/等[。，；）]/.test(line) || /等$/.test(line.trimEnd())) {
      hits.push({ file, line: i + 1, term: "等", text: line.trim() });
    }
  }
  return hits;
}

/** AC↔任务机械映射：任务描述文本中出现 AC 编号即建立候选关联 */
export function buildAcTaskCoverage(acs, tasks) {
  const coverage = [];
  const uncovered = [];
  for (const ac of acs) {
    const matched = tasks
      .filter((t) => t.description.includes(ac.id))
      .map((t) => `${t.id}@${t.module}`);
    if (matched.length) coverage.push({ ac: ac.id, file: ac.file, tasks: matched });
    else uncovered.push({ ac: ac.id, file: ac.file, text: ac.text });
  }
  return { coverage, uncovered };
}

/** depends 悬空引用：TNNN 或 TNNN@module 指向不存在的任务 */
export function findDanglingDepends(tasks) {
  const known = new Set(tasks.map((t) => `${t.id}@${t.module}`));
  const dangling = [];
  for (const t of tasks) {
    for (const dep of t.depends || []) {
      const ref = dep.includes("@") ? dep : `${dep}@${t.module}`;
      if (!known.has(ref)) dangling.push({ task: `${t.id}@${t.module}`, depends: dep });
    }
  }
  return dangling;
}

/** change.yaml 的 scope.include / scope.exclude 列表 */
export function extractScope(content) {
  const lines = content.split(/\r?\n/);
  const scope = { include: [], exclude: [] };
  let current = null;
  for (const raw of lines) {
    if (/^scope:\s*$/.test(raw)) { current = "scope"; continue; }
    if (current && /^\S/.test(raw)) current = null; // 回到顶层键，scope 块结束
    if (!current) continue;
    if (/^\s+include:\s*$/.test(raw)) { current = "include"; continue; }
    if (/^\s+exclude:\s*$/.test(raw)) { current = "exclude"; continue; }
    const item = raw.match(/^\s+-\s+"?([^"]+)"?\s*$/);
    if (item && (current === "include" || current === "exclude")) {
      scope[current].push(item[1].trim());
    }
  }
  return scope;
}

// ── 组装 ──

function listModuleFiles(moduleDir) {
  if (!existsSync(moduleDir) || !statSync(moduleDir).isDirectory()) return [];
  return readdirSync(moduleDir).filter((f) => f.endsWith(".md"));
}

export function buildPacket(changesDir, onlyModule) {
  const yamlPath = join(changesDir, "change.yaml");
  if (!existsSync(yamlPath)) fatal(`未找到 ${yamlPath}——无活跃变更，/xf-analyze 无审计对象`);
  const yamlContent = readFileSync(yamlPath, "utf-8");
  const change = parseChangeMeta(yamlContent);
  const scope = extractScope(yamlContent);

  let targets = change.affected_modules || [];
  if (onlyModule) {
    targets = targets.filter((m) => m.name === onlyModule);
    if (!targets.length) fatal(`模块 ${onlyModule} 不在 affected_modules 中`);
  }

  const modules = {};
  const allAcs = [];
  const allTasks = [];

  for (const mod of targets) {
    const dir = join(changesDir, mod.name);
    const entry = {
      module_type: mod.module_type || null,
      change_type: mod.change_type || null,
      files: {},
      acceptance_criteria: [],
      tasks: [],
      threat_rows: [],
      endpoints: [],
      vague_hits: [],
    };
    for (const f of listModuleFiles(dir)) {
      const rel = `${mod.name}/${f}`;
      const content = readFileSync(join(dir, f), "utf-8");
      entry.files[f] = { sections: extractSections(content) };
      if (/^spec(\.delta)?\.md$/.test(f)) {
        entry.acceptance_criteria = entry.acceptance_criteria.concat(extractAcDefs(content, rel));
        entry.vague_hits = entry.vague_hits.concat(extractVagueHits(content, rel));
      }
      if (/^hld(\.delta)?\.md$/.test(f)) {
        entry.threat_rows = entry.threat_rows.concat(extractThreatRows(content, rel));
        entry.vague_hits = entry.vague_hits.concat(extractVagueHits(content, rel));
      }
      if (/^contracts(\.delta)?\.md$/.test(f)) {
        entry.endpoints = entry.endpoints.concat(extractEndpoints(content, rel));
      }
      if (f === "task.md") {
        entry.tasks = parseTaskFile(content, mod.name);
      }
    }
    allAcs.push(...entry.acceptance_criteria);
    allTasks.push(...entry.tasks);
    modules[mod.name] = entry;
  }

  const { coverage, uncovered } = buildAcTaskCoverage(allAcs, allTasks);

  return {
    generated_by: "xf-audit-packet.mjs",
    change: {
      id: change.id || null,
      name: change.name || null,
      phase: change.phase || null,
      scope_include: scope.include,
      scope_exclude: scope.exclude,
      affected_modules: (change.affected_modules || []).map((m) => ({
        name: m.name, change_type: m.change_type || null, module_type: m.module_type || null,
      })),
    },
    modules,
    cross: {
      ac_task_coverage: coverage,
      uncovered_acs: uncovered,
      dangling_depends: findDanglingDepends(allTasks),
    },
  };
}

// ── 入口 ──

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  handleHelpFlag(args, USAGE);
  assertAllowedArgs(args, ALLOWED_ARGS, USAGE);

  // --dir 显式指定时直接用（供 eval fixture，与 Flow 布局无关）；否则从活跃 Flow 推导
  const targetDir = typeof args.dir === "string"
    ? resolve(args.dir)
    : changesDir(resolveFlowId());
  if (!existsSync(targetDir)) printUsageAndExit(USAGE, `changes 目录不存在：${targetDir}`);

  const packet = buildPacket(targetDir, typeof args.module === "string" ? args.module : null);

  if (!args.json) {
    const mods = Object.keys(packet.modules);
    const counts = mods.map((m) => {
      const e = packet.modules[m];
      return `  - ${m}: AC ${e.acceptance_criteria.length} / 任务 ${e.tasks.length} / 威胁行 ${e.threat_rows.length} / 端点 ${e.endpoints.length} / 模糊词 ${e.vague_hits.length}`;
    });
    console.error(
      [
        `📦 审计包（change: ${packet.change.id || "?"}，模块 ${mods.length} 个）`,
        ...counts,
        `  未覆盖 AC: ${packet.cross.uncovered_acs.length} / 悬空 depends: ${packet.cross.dangling_depends.length}（均为机械结果，须语义复核）`,
      ].join("\n"),
    );
  }
  console.log(JSON.stringify(packet, null, 2));
}
