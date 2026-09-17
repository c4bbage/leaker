#!/usr/bin/env node
/**
 * xf-validate.mjs — Flow 动态自检（baseflow 版）
 *
 * 读取 .xflow/<flowName>/validate-rules.yaml 中的 phases: 块（由 xflow init 从 flow.yaml 生成）。
 * 脚本自动从 change.yaml 读取当前活跃 flow 定位文件。
 *
 * validate-rules.yaml 格式（per-flow，无命名空间前缀）：
 *   phases:
 *     <nodeId>:
 *       mechanicalChecks:
 *         fileExists: true
 *         noPlaceholder: true
 *       semantic_checks:
 *         - id: rule1
 *           name: 规则名称
 *           fail_condition: 判断标准
 *       outputs:
 *         - dir: active
 *           artifact: result.md
 *
 * 用法：  node .xflow/scripts/xf-validate.mjs --node <nodeId>
 * 退出码：0 = 全部通过，1 = 有 failure
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const XFLOW_DIR = resolve(SCRIPT_DIR, "..");
const PROJECT_ROOT = resolve(XFLOW_DIR, "..");

const TIMEOUT_MS = 15_000;

// dir 归一："" / "." 视为 root（flow spec 根目录）；其余原样（未知值调用侧回退 changes）
// 抽到模块级以便单测；main 内的 LAYER_DIRS.root 与之配对。
export function resolveLayer(out) {
  const l = out.dir ?? out.layer ?? "changes";
  return l === "" || l === "." ? "root" : l;
}

// ─── 主逻辑 ───────────────────────────────────────────────────────────────────

export async function main(args) {
  const nodeId = String(args.node);
  const flowNameArg = typeof args.flow === "string" ? args.flow : null;

  // 从 --flow 参数或 change.yaml 读取当前活跃 flow
  const activeFlow = flowNameArg ?? readActiveFlow();

  if (!activeFlow) {
    const result = {
      node: nodeId,
      pass: true,
      summary: { total: 0, passed: 0, failed: 0 },
      mechanical: [],
      semantic: [],
    };
    console.log(JSON.stringify(result));
    return result;
  }

  // 读取 per-flow validate-rules.yaml
  const RULES_PATH = join(XFLOW_DIR, activeFlow, "validate-rules.yaml");
  const nodesConfig = readNodesConfig(RULES_PATH);

  const node = nodesConfig[nodeId];

  if (!node) {
    const result = {
      node: nodeId,
      pass: true,
      summary: { total: 0, passed: 0, failed: 0 },
      mechanical: [],
      semantic: [],
    };
    console.log(JSON.stringify(result));
    return result;
  }

  const mc = node.mechanicalChecks ?? {};
  const placeholders = node.placeholders ?? [];
  const outputs = node.outputs ?? [];
  const mechanicalResults = [];

  // per-flow 路径：xspec/<flow>/changes, xspec/<flow>/modules, xspec/<flow>/archive
  const SPEC_ROOT = join(PROJECT_ROOT, "xspec");
  const flowRoot = join(SPEC_ROOT, activeFlow);
  const LAYER_DIRS = {
    active: join(flowRoot, "changes"),
    sot: join(flowRoot, "modules"),
    archive: join(flowRoot, "archive"),
    // root：flow spec 根目录，用于 constitution.md / PRODUCT.md 等根级制品
    // （web 侧根目录文件存 dir=""；与 init.ts formatWrapperOutputPaths 保持一致）
    root: flowRoot,
  };

  const resolveOutputPath = (out) => {
    const artifact = out.artifact ?? out.path ?? String(out);
    const dir = LAYER_DIRS[resolveLayer(out)] ?? join(flowRoot, "changes");
    return { artifact, filePath: join(dir, artifact) };
  };

  // 相对仓库根的展示路径（报错信息用，避免打印绝对路径或错误的 layer 名）
  const relPath = (filePath) =>
    filePath.startsWith(PROJECT_ROOT + "/")
      ? filePath.slice(PROJECT_ROOT.length + 1)
      : filePath;

  // fileExists：outputs[] 声明的文件必须存在
  if (mc.fileExists && outputs.length) {
    for (const out of outputs) {
      const { artifact, filePath } = resolveOutputPath(out);
      mechanicalResults.push({
        rule: "fileExists",
        file: artifact,
        path: filePath,
        status: existsSync(filePath) ? "pass" : "fail",
        detail: existsSync(filePath)
          ? undefined
          : `文件不存在：${relPath(filePath)}`,
      });
    }
  }

  // noPlaceholder：检查残留占位符
  if (placeholders.length > 0 && outputs.length) {
    for (const out of outputs) {
      const { artifact, filePath } = resolveOutputPath(out);
      if (!existsSync(filePath)) continue;
      try {
        const content = readFileSync(filePath, "utf-8");
        const found = placeholders.filter((p) => content.includes(p));
        mechanicalResults.push({
          rule: "noPlaceholder",
          file: artifact,
          status: found.length === 0 ? "pass" : "fail",
          detail:
            found.length > 0 ? `残留占位符：${found.join("、")}` : undefined,
        });
      } catch {
        /* 忽略读取失败 */
      }
    }
  }

  // requiredSections：文件必须包含 ## 章节标题（至少一个）
  if (mc.requiredSections && outputs.length) {
    for (const out of outputs) {
      const { artifact, filePath } = resolveOutputPath(out);
      if (!artifact.endsWith(".md")) continue;
      if (!existsSync(filePath)) continue;
      try {
        const content = readFileSync(filePath, "utf-8");
        const sections = content.match(/^##\s+.+/gm) ?? [];
        mechanicalResults.push({
          rule: "requiredSections",
          file: artifact,
          status: sections.length > 0 ? "pass" : "fail",
          detail:
            sections.length === 0 ? "文件中未找到任何 ## 章节" : undefined,
        });
      } catch {
        /* 忽略 */
      }
    }
  }

  // noEmptySection：检查空的 ## 章节
  if (mc.noEmptySection && outputs.length) {
    for (const out of outputs) {
      const { artifact, filePath } = resolveOutputPath(out);
      if (!artifact.endsWith(".md")) continue;
      if (!existsSync(filePath)) continue;
      try {
        const content = readFileSync(filePath, "utf-8");
        const emptySections = findEmptySections(content);
        mechanicalResults.push({
          rule: "noEmptySection",
          file: artifact,
          status: emptySections.length === 0 ? "pass" : "fail",
          detail:
            emptySections.length > 0
              ? `空章节：${emptySections.join("、")}`
              : undefined,
        });
      } catch {
        /* 忽略 */
      }
    }
  }

  const semanticRules = node.semantic_checks ?? [];
  const failed = mechanicalResults.filter((r) => r.status === "fail");
  const passed = mechanicalResults.filter((r) => r.status === "pass");

  const result = {
    node: nodeId,
    pass: failed.length === 0,
    summary: {
      total: mechanicalResults.length,
      passed: passed.length,
      failed: failed.length,
    },
    mechanical: mechanicalResults,
    semantic: semanticRules,
  };

  console.log(JSON.stringify(result, null, 2));
  return result;
}

// ─── 读取 phases: 块（与 pack 格式对齐）─────────────────────────────────────

export function readNodesConfig(rulesPath) {
  if (!existsSync(rulesPath)) {
    return {};
  }
  const raw = readFileSync(rulesPath, "utf-8");
  // phases: 可能不在文件首行（生成的文件开头有注释头 + 空行），故用 (?:^|\n) 兜住，
  // 而非依赖 ^ 锚定字符串开头（否则前置注释会导致整块匹配失败、所有节点被判 total:0）。
  const phasesMatch = raw.match(/(?:^|\n)phases:[^\n]*\n([\s\S]*?)(?=\n\S|$)/);
  if (!phasesMatch) return {};

  const result = {};
  const block = phasesMatch[1];
  const lines = block.split("\n");
  let currentNode = null;
  let currentSection = null;
  let currentRule = null;

  for (const line of lines) {
    if (line.match(/^\s*#/)) continue;

    const nodeMatch = line.match(/^  ([^\s#]+):\s*$/);
    if (nodeMatch) {
      currentNode = nodeMatch[1];
      result[currentNode] = {
        mechanicalChecks: {},
        semantic_checks: [],
        outputs: [],
        placeholders: [],
      };
      currentSection = null;
      continue;
    }
    if (!currentNode) continue;

    const sectionMatch = line.match(
      /^    (placeholders|outputs|semantic_checks):\s*(\[\])?$/,
    );
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      currentRule = null;
      continue;
    }

    const boolMatch = line.match(
      /^    (fileExists|requiredSections|noEmptySection):\s*(true|false)/,
    );
    if (boolMatch) {
      result[currentNode].mechanicalChecks[boolMatch[1]] =
        boolMatch[2] === "true";
      continue;
    }

    if (currentSection === "placeholders") {
      const pMatch = line.match(/^      - "?(.+?)"?\s*$/);
      if (pMatch) result[currentNode].placeholders.push(pMatch[1]);
    } else if (currentSection === "semantic_checks") {
      const newRule = line.match(/^      - id:\s*(\S+)/);
      if (newRule) {
        currentRule = { id: newRule[1], name: "", fail_condition: "" };
        result[currentNode].semantic_checks.push(currentRule);
        continue;
      }
      if (currentRule) {
        const nameMatch = line.match(/^        name:\s*(.+)/);
        const fcMatch = line.match(/^        fail_condition:\s*(.+)/);
        if (nameMatch)
          currentRule.name = nameMatch[1].trim().replace(/^"|"$/g, "");
        if (fcMatch)
          currentRule.fail_condition = fcMatch[1].trim().replace(/^"|"$/g, "");
      }
    } else if (currentSection === "outputs") {
      const dirMatch = line.match(/^      - (?:dir|layer):\s*(\S+)/);
      const artifactMatch = line.match(/^        artifact:\s*(\S+)/);
      if (dirMatch)
        result[currentNode].outputs.push({ dir: dirMatch[1], artifact: "" });
      if (artifactMatch && result[currentNode].outputs.length > 0) {
        result[currentNode].outputs[
          result[currentNode].outputs.length - 1
        ].artifact = artifactMatch[1];
      }
    }
  }
  return result;
}

// ─── 从 change.yaml 读取当前活跃 flow ──────────────────────────────────────────

function readActiveFlow() {
  const SPEC_ROOT = join(PROJECT_ROOT, "xspec");
  // 扫描所有 Flow 目录找有 change.yaml 的（per-flow 路径：xspec/<flow>/changes/change.yaml）
  if (existsSync(SPEC_ROOT)) {
    for (const dir of readdirSync(SPEC_ROOT)) {
      const flow = readFlowFieldFromYaml(
        join(SPEC_ROOT, dir, "changes", "change.yaml"),
      );
      if (flow) return flow;
    }
  }
  // 降级：从 init.json 读取
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

function findEmptySections(content) {
  const lines = content.split("\n");
  const empty = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+)/);
    if (!m) continue;
    const title = m[1].trim();
    let hasContent = false,
      j = i + 1;
    while (j < lines.length && !lines[j].match(/^##\s/)) {
      if (lines[j].trim()) {
        hasContent = true;
        break;
      }
      j++;
    }
    if (!hasContent) empty.push(title);
  }
  return empty;
}

function parseArgs(argv) {
  const r = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2),
        next = argv[i + 1];
      r[k] = next && !next.startsWith("-") ? (i++, next) : true;
    } else if (a.startsWith("-")) {
      r[a.slice(1)] = true;
    }
  }
  return r;
}

const USAGE = `xf-validate.mjs — Flow 动态自检
用法：node .xflow/scripts/xf-validate.mjs --node <nodeId>
  --node <nodeId>  要校验的节点 ID
  --flow <name>    指定 Flow 名称（可选，默认从 change.yaml 读取）
  --help, -h       显示此帮助
校验规则由 .xflow/<flowName>/validate-rules.yaml 的 phases: 块定义（xflow init 生成）`;

// ─── CLI 入口（仅在直接运行时执行；被单测 import 时不触发，避免 process.exit）──────
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const timer = setTimeout(() => {
    console.error("[xflow] Error: xf-validate.mjs timed out after 15s");
    process.exit(1);
  }, TIMEOUT_MS);

  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    clearTimeout(timer);
    console.log(USAGE);
    process.exit(0);
  }
  if (!args.node) {
    clearTimeout(timer);
    console.error("缺少 --node 参数\n\n" + USAGE);
    process.exit(1);
  }

  main(args)
    .then(({ pass }) => {
      clearTimeout(timer);
      process.exit(pass ? 0 : 1);
    })
    .catch((err) => {
      clearTimeout(timer);
      console.error(`[xflow] Error: ${err.message}`);
      process.exit(1);
    });
}
