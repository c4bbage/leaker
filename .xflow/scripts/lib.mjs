import { readdir, readFile, stat, mkdir, writeFile } from "fs/promises";
import { resolve, join, dirname, basename } from "path";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
} from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { generateChangeId } from "./xf-change-id.mjs";

// ── 路径计算 ──────────────────────────────────────────────────────────
// 运行时位置：.xflow/<flow>/scripts/lib.mjs → 上跳 3 级到项目根
// 源码仓库位置：.xflow/scripts/lib.mjs → 上跳 2 级（开发时，init.json 不在 grandparent）
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// 检测：grandparent 含 init.json 表示运行时部署（.xflow/<flow>/scripts/）
const _parentDir = resolve(SCRIPT_DIR, "..");
const _grandParentDir = resolve(_parentDir, "..");
const _isDeployed = existsSync(join(_grandParentDir, "init.json"));

const PROJECT_ROOT = _isDeployed
  ? resolve(SCRIPT_DIR, "../../..") // .xflow/<flow>/scripts/ → 3 级
  : resolve(SCRIPT_DIR, "../.."); // .xflow/scripts/ → 2 级（源码仓库开发时）

const XFLOW_ROOT = join(PROJECT_ROOT, ".xflow");
const SPEC_ROOT = join(PROJECT_ROOT, "xspec");

/** 框架目录（非 Flow 目录），resolveFlowId group 模式时排除 */
const FRAMEWORK_DIRS = new Set([
  "scripts",
  "templates",
  "profiles",
  "reference",
  "tools",
]);

// ── Flow 识别 ────────────────────────────────────────────────────────
/**
 * 解析当前活跃 Flow ID。
 *
 * 运行时（已部署）：从目录位置提取 flowId（dirname 即 .xflow/<flowId>/）
 * 或从 .xflow/init.json 读取。
 *
 * 返回 string（单 Flow）或 string[]（Group 模式多 Flow）。
 * 未初始化或格式非法时 fatal。
 */
export function resolveFlowId() {
  // 优先从 init.json 读取（权威来源）
  const initPath = join(XFLOW_ROOT, "init.json");
  if (!existsSync(initPath)) {
    // 无 init.json：尝试从部署位置提取
    if (_isDeployed) {
      return basename(_parentDir);
    }
    fatal("未初始化：.xflow/init.json 不存在，请先执行 xflow init");
  }
  const initJson = JSON.parse(readFileSync(initPath, "utf-8"));
  if (initJson.mode === "flow") {
    if (typeof initJson.flow !== "string" || !initJson.flow) {
      fatal("init.json 格式错误：mode=flow 但 flow 字段缺失");
    }
    return initJson.flow;
  }
  if (initJson.mode === "group") {
    const dirs = readdirSync(XFLOW_ROOT).filter(
      (d) =>
        d !== "init.json" &&
        !FRAMEWORK_DIRS.has(d) &&
        existsSync(join(XFLOW_ROOT, d)) &&
        statSync(join(XFLOW_ROOT, d)).isDirectory(),
    );
    if (dirs.length === 0) fatal("init.json mode=group 但无 Flow 目录");

    const args = parseArgs();
    if (args.flow && typeof args.flow === "string") {
      if (!dirs.includes(args.flow)) {
        fatal(
          `--flow "${args.flow}" 不在当前 Group 中，可用：${dirs.join(", ")}`,
        );
      }
      return args.flow;
    }

    // Group 模式：扫描各 flow 目录下的 per-flow change.yaml
    for (const d of dirs) {
      const changeYamlPath = join(SPEC_ROOT, d, "changes", "change.yaml");
      if (existsSync(changeYamlPath)) {
        try {
          const content = readFileSync(changeYamlPath, "utf-8");
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
            if (value && dirs.includes(value)) return value;
          }
        } catch {
          /* fall through */
        }
      }
    }

    fatal(
      `Group 模式需要指定 Flow。可用 Flow：${dirs.join(", ")}\n` +
        `请通过 --flow <name> 参数指定，或在 xspec/<flow>/changes/change.yaml 中声明 flow: <name>`,
    );
  }
  fatal(
    `init.json 格式非法：mode 字段必须为 "flow" 或 "group"，实际为 "${initJson.mode ?? "(缺失)"}"`,
  );
}

// ── 数据层路径工厂（xspec/<flow>/...） ──────────────────────────────
export function resolveSpecRoot(flowId) {
  return join(SPEC_ROOT, flowId);
}
export function modulesDir(flowId) {
  return join(resolveSpecRoot(flowId), "modules");
}
export function changesDir(flowId) {
  return join(resolveSpecRoot(flowId), "changes");
}
export function archiveDir(flowId) {
  return join(resolveSpecRoot(flowId), "archive");
}
export function gatesDir(flowId) {
  return join(changesDir(flowId), ".gates");
}

// ── 框架层路径工厂（.xflow/<flow>/...） ────────────────────────────
export function flowFrameworkRoot(flowId) {
  return join(XFLOW_ROOT, flowId);
}

// ── 质量检查结果（机器本地 ~/.xflow，不进项目仓库）─────────────────
export function projectRootDir() {
  return PROJECT_ROOT;
}
export function artifactRootDir() {
  return process.env.XFLOW_ARTIFACT_ROOT?.trim() || join(homedir(), ".xflow", "artifacts");
}
export function projectPathHash(projectPath) {
  let resolved = projectPath;
  try {
    if (existsSync(projectPath)) resolved = realpathSync(projectPath);
  } catch { /* use raw path */ }
  return createHash("sha256").update(resolved).digest("hex").slice(0, 12);
}
/** quality/<changeId> 基准目录；flowId/changeId 缺失返回 null */
export function qualityDir(flowId, changeId) {
  if (!flowId || !changeId) return null;
  return join(artifactRootDir(), projectPathHash(PROJECT_ROOT), flowId, "quality", changeId);
}
export function flowTemplatesDir(flowId) {
  return join(flowFrameworkRoot(flowId), "templates");
}

// ── Flow.yaml 加载 ──────────────────────────────────────────────────
export function loadFlowYaml(flowId) {
  const p = join(flowFrameworkRoot(flowId), "Flow.yaml");
  if (!existsSync(p)) return null;
  const content = readFileSync(p, "utf-8");
  // 使用简单 YAML 解析（Flow.yaml 结构固定，不需要完整 YAML 库）
  // 这里返回原始文本，消费者按需解析
  return content;
}

// ── Flow/Group name 合法性校验 ──────────────────────────────────────
// 名称约束（禁止连续 --）在 xflow-admin Web 端创建时校验，CLI 不重复检查
export function isValidFlowName(name) {
  return /^[a-z0-9][a-z0-9._-]*$/.test(name);
}

// ── checkFrozen：脚本侧 frozen 写保护 ───────────────────────────────
/**
 * 检查本 Flow 的 frozen 保护规则是否允许当前写操作。
 * 只处理 frozen（write: none），public/protect 由 protect.js plugin 鉴权。
 *
 * @param {string} flowId   - 当前 Flow 名称
 * @param {string} filePath - 被写入的相对路径（相对于 xspec/<flow>/）
 * @param {string|null} nodeId - 当前执行节点 ID（如 "archive"），用于 bypassNodes
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function checkFrozen(flowId, filePath, nodeId = null) {
  const yamlContent = loadFlowYaml(flowId);
  if (!yamlContent) return { allowed: true };

  // 简单解析 visibility 规则（从 YAML 文本中提取）
  const visibility = parseVisibilityRules(yamlContent);
  if (!visibility || visibility.length === 0) return { allowed: true };

  for (const rule of visibility) {
    if (!matchPattern(filePath, rule.pattern)) continue;

    // 非 frozen 规则（write != none）：不限制
    if (rule.write !== "none") return { allowed: true };

    // frozen 规则（write: none）—— 检查豁免
    // 1. except 白名单
    if (rule.except && rule.except.some((e) => matchPattern(filePath, e))) {
      return { allowed: true };
    }

    // 2. bypassNodes 豁免
    if (rule.bypassNodes && nodeId && rule.bypassNodes.includes(nodeId)) {
      return { allowed: true };
    }

    // 未豁免：拒绝
    return {
      allowed: false,
      reason: `${flowId}:${filePath} 已被 frozen 保护（write: none）`,
    };
  }

  return { allowed: true };
}

// ── resolveArtifactRef：解析 input/output 条目 ─────────────────────
/**
 * 解析结构化 input/output 条目，dir → 本地路径。
 * 自封闭：只接受 { dir, artifact }。
 */
export function resolveArtifactRef(ref, flowId) {
  const dirMap = { active: "changes", sot: "modules", archive: "archive" };
  const base = dirMap[ref.dir];
  if (!base) throw new Error(`无效 dir: ${ref.dir}（允许 active/sot/archive）`);
  return { localPath: join(resolveSpecRoot(flowId), base, ref.artifact) };
}

// ── validateInputs：节点 inputs 前置条件校验 ─────────────────────────
/**
 * 节点启动前：校验所有 inputs 的前置条件（文件存在性）。
 * 跨 Flow 引用由 Group 运行时在文件映射阶段完成，不在此处校验。
 */
export function validateInputs(inputs, flowId) {
  const errors = [];
  for (const input of inputs) {
    const { localPath } = resolveArtifactRef(input, flowId);
    if (!existsSync(localPath)) {
      errors.push(`${flowId}/${input.dir}/${input.artifact} 不存在`);
    }
  }
  return errors;
}

// ── readChangeYaml（flow-aware 版本） ─────────────────────────────────
/**
 * 读取指定 Flow 的 change.yaml。
 * @param {string} flowId - Flow 名称（必填）。
 */
export async function readChangeYaml(flowId) {
  const p = join(changesDir(flowId), "change.yaml");
  if (!existsSync(p)) return null;
  const content = await readFile(p, "utf-8");
  return parseChangeYaml(content);
}

// 去掉标量值两端的成对引号（"x" / 'x' → x），未加引号原样返回
function dequoteScalar(s) {
  return s.replace(/^(["'])(.*)\1$/, "$2");
}

function parseChangeYaml(content) {
  const result = {
    flow: null,
    id: null,
    name: null,
    status: null,
    phase: null,
    affected_modules: [],
  };
  const lines = content.split(/\r?\n/);
  let inModules = false;
  let currentModule = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line || /^\s*#/.test(line)) continue;
    if (/^\s+(-|\w)/.test(raw)) {
      if (inModules) {
        const inner = raw.replace(/^\s+/, "").trim();
        if (inner.startsWith("- name:")) {
          if (currentModule) result.affected_modules.push(currentModule);
          currentModule = { name: dequoteScalar(inner.slice(7).trim()), change_type: null, module_type: null, summary: null };
        } else if (currentModule && inner.startsWith("change_type:")) {
          currentModule.change_type = dequoteScalar(inner.slice(12).trim()) || null;
        } else if (currentModule && inner.startsWith("module_type:")) {
          currentModule.module_type = dequoteScalar(inner.slice(12).trim()) || null;
        } else if (currentModule && inner.startsWith("summary:")) {
          currentModule.summary = dequoteScalar(inner.slice(8).trim()) || null;
        }
      }
      continue;
    }
    inModules = false;
    if (currentModule) {
      result.affected_modules.push(currentModule);
      currentModule = null;
    }
    const ci = line.indexOf(":");
    if (ci <= 0) continue;
    const key = line.slice(0, ci).trim();
    // change.yaml 的标量值统一带双引号（见 writePhase）；解析时剥掉外层引号，
    // 与 xf-current-change 文档契约（--field phase → clarify，不带引号）一致，
    // 也确保 assertCommandPhase 能把 phase 值和 ALLOWED_PHASES 正确比对。
    const val = unquoteScalar(line.slice(ci + 1).trim());
    if (key === "affected_modules") {
      inModules = true;
      continue;
    }
    if (key in result && !Array.isArray(result[key])) {
      result[key] = val || null;
    }
  }
  if (currentModule) result.affected_modules.push(currentModule);
  return result;
}

// ── visibility 规则简易解析器 ────────────────────────────────────────
/**
 * 从 Flow.yaml 文本中提取 visibility 规则数组。
 * 简单实现：按行解析 visibility 块，不依赖完整 YAML 库。
 */
function parseVisibilityRules(yamlContent) {
  const lines = yamlContent.split("\n");
  const rules = [];
  let inVisibility = false;
  let currentRule = null;
  let inExcept = false;
  let inBypass = false;

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // 检测 visibility: 块开始
    if (/^visibility:\s*$/.test(trimmed)) {
      inVisibility = true;
      continue;
    }

    // 退出 visibility 块（遇到同级或更高级的 key）
    if (inVisibility && /^\S/.test(trimmed) && !trimmed.startsWith("#")) {
      inVisibility = false;
      if (currentRule) rules.push(currentRule);
      break;
    }

    if (!inVisibility) continue;

    // 新规则开始（- pattern:）
    if (/^\s+-\s*pattern:/.test(trimmed)) {
      if (currentRule) rules.push(currentRule);
      const pattern = trimmed.match(/pattern:\s*"?([^"#]+)"?/)?.[1]?.trim();
      currentRule = {
        pattern,
        read: "any_flow",
        write: "own_flow",
        except: null,
        bypassNodes: null,
      };
      inExcept = false;
      inBypass = false;
      continue;
    }

    if (!currentRule) continue;

    if (inExcept && /^\s+-\s/.test(trimmed)) {
      const val = trimmed.match(/-\s*"?([^"#]+)"?/)?.[1]?.trim();
      if (val) currentRule.except.push(val);
      continue;
    }
    if (inExcept) inExcept = false;

    if (inBypass && /^\s+-\s/.test(trimmed)) {
      const val = trimmed.match(/-\s*"?([^"#]+)"?/)?.[1]?.trim();
      if (val) currentRule.bypassNodes.push(val);
      continue;
    }
    if (inBypass) inBypass = false;

    // read:
    if (/^\s+read:/.test(trimmed)) {
      currentRule.read = trimmed.match(/read:\s*(\S+)/)?.[1] || "any_flow";
      continue;
    }
    // write:
    if (/^\s+write:/.test(trimmed)) {
      currentRule.write = trimmed.match(/write:\s*(\S+)/)?.[1] || "own_flow";
      continue;
    }
    // except: 支持两种格式：多行块 和 inline [a, b]
    if (/^\s+except:\s*$/.test(trimmed)) {
      inExcept = true;
      currentRule.except = [];
      continue;
    }
    if (/^\s+except:\s*\[/.test(trimmed)) {
      const match = trimmed.match(/except:\s*\[([^\]]*)\]/);
      if (match) {
        currentRule.except = match[1]
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      }
      continue;
    }
    // bypassNodes: 支持两种格式：多行块 和 inline [a, b]
    if (/^\s+bypassNodes:\s*$/.test(trimmed)) {
      inBypass = true;
      currentRule.bypassNodes = [];
      continue;
    }
    if (/^\s+bypassNodes:\s*\[/.test(trimmed)) {
      const match = trimmed.match(/bypassNodes:\s*\[([^\]]*)\]/);
      if (match) {
        currentRule.bypassNodes = match[1]
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      }
      continue;
    }
  }

  if (currentRule) rules.push(currentRule);
  return rules;
}

// ── 简单 glob 匹配 ──────────────────────────────────────────────────
/**
 * 简易 glob 匹配（支持 ** 和 *）。
 * 不依赖 minimatch 库，覆盖 Flow.yaml visibility 中的常见 pattern。
 */
function matchPattern(filePath, pattern) {
  if (pattern === "**") return true;
  // 路径前缀匹配（pattern 以 / 结尾表示目录前缀）
  if (pattern.endsWith("/")) {
    return filePath.startsWith(pattern) || filePath === pattern.slice(0, -1);
  }
  // * 通配符转正则
  const regexStr =
    "^" +
    pattern
      .replace(/\*\*/g, "§§")
      .replace(/\*/g, "[^/]*")
      .replace(/§§/g, ".*")
      .replace(/\//g, "\\/") +
    "$";
  return new RegExp(regexStr).test(filePath);
}

// ── 基础工具函数 ─────────────────────────────────────────────────────

export function exists(p) {
  return existsSync(p);
}

export async function ensureDir(p) {
  if (!existsSync(p)) {
    await mkdir(p, { recursive: true });
    return true;
  }
  return false;
}

/**
 * Minimal block-style YAML parser for nested maps.
 *
 * Supports:
 *   - Nested maps with consistent indentation (2 spaces recommended)
 *   - Scalar values: key: value  /  key: "quoted value"
 *   - Comments (# ...) and blank lines
 *
 * Does NOT support:
 *   - Arrays / sequences (use explicit map keys instead)
 *   - Flow-style maps ({ ... })
 *   - Multiline strings / anchors / merge keys
 *
 * Throws an Error with line number on malformed input.
 */
export function parseCatalogYaml(content) {
  const lines = content.split("\n");
  const root = {};
  const stack = [{ indent: -1, obj: root }];

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const raw = lines[lineNo].replace(/\r$/, "");
    if (!raw.trim() || raw.trim().startsWith("#")) continue;

    const indent = raw.search(/\S/);
    const trimmed = raw.trim();

    // Strip trailing inline comment (only when preceded by whitespace, and not inside quotes)
    let line = trimmed;
    const inlineCommentIdx = findInlineComment(line);
    if (inlineCommentIdx !== -1)
      line = line.slice(0, inlineCommentIdx).trimEnd();

    if (indent % 2 !== 0) {
      throw new Error(
        `YAML 解析错误（第 ${lineNo + 1} 行）：缩进必须是 2 的倍数，实际 ${indent}`,
      );
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      throw new Error(
        `YAML 解析错误（第 ${lineNo + 1} 行）：期望 "key: value" 或 "key:" 格式，实际 "${line}"`,
      );
    }

    const key = line.slice(0, colonIdx).trim();
    const valPart = line.slice(colonIdx + 1).trim();

    // Pop stack until we find the parent (indent < current)
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    if (stack.length === 0) {
      throw new Error(`YAML 解析错误（第 ${lineNo + 1} 行）：缩进层次异常`);
    }

    const parent = stack[stack.length - 1].obj;

    if (valPart === "") {
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else {
      parent[key] = unquoteScalar(valPart);
    }
  }

  return root;
}

function findInlineComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(line[i - 1])) return i;
    }
  }
  return -1;
}

function unquoteScalar(s) {
  if (s.length >= 2) {
    if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
    if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  }
  return s;
}

/**
 * List immediate subdirectory names under a path.
 */
export async function listDirs(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/**
 * Recursively copy a directory tree from src to dest.
 */
export async function copyDir(src, dest) {
  await ensureDir(dest);
  const entries = await readdir(src, { withFileTypes: true });
  const copied = [];
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copied.push(...(await copyDir(srcPath, destPath)));
    } else {
      const content = await readFile(srcPath);
      await writeFile(destPath, content);
      copied.push(destPath);
    }
  }
  return copied;
}

/**
 * Remove all contents inside a directory, keeping the directory itself.
 * Optionally writes a .gitkeep to keep it tracked.
 */
export async function emptyDir(dir, keepGitkeep = true) {
  if (!existsSync(dir)) return;
  const { rm } = await import("fs/promises");
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (keepGitkeep && entry.name === ".gitkeep") continue;
    await rm(join(dir, entry.name), { recursive: true, force: true });
  }
  if (keepGitkeep && !existsSync(join(dir, ".gitkeep"))) {
    await writeFile(join(dir, ".gitkeep"), "");
  }
}

/**
 * Print JSON result to stdout and exit.
 */
export function output(data) {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Print error to stderr and exit with code 1.
 */
export function fatal(message) {
  console.error(`[xflow] Error: ${message}`);
  process.exit(1);
}

/**
 * Parse CLI arguments into a simple { key: value } map.
 * Supports --key value, --flag (boolean true), and -h/--help shortcut.
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "-h") {
      args.help = true;
      continue;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--") && next !== "-h") {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

/**
 * Render a USAGE descriptor into a human-readable, AI-parseable block.
 *
 * The USAGE descriptor is a structured object so we can guarantee a uniform
 * format across all xflow scripts. AI agents (and humans) reading the error
 * output get the same skeleton every time:
 *
 *   用法: <oneliner>
 *
 *   说明:
 *     <description, optional, multi-line ok>
 *
 *   必填参数:
 *     --foo <value>    描述
 *
 *   可选参数:
 *     --bar            描述
 *
 *   合法值:
 *     --foo: a | b | c
 *
 *   示例:
 *     node script.mjs --foo a
 *     node script.mjs --foo b --bar
 *
 *   注意:
 *     - <gotcha 1>
 *     - <gotcha 2>
 *
 * Sections that are absent from the descriptor are skipped silently.
 */
export function renderUsage(usage) {
  const lines = [];
  if (usage.usage) lines.push(`用法: ${usage.usage}`);
  if (usage.description) {
    lines.push("");
    lines.push("说明:");
    for (const ln of usage.description.split("\n")) lines.push(`  ${ln}`);
  }
  if (usage.required && Object.keys(usage.required).length > 0) {
    lines.push("");
    lines.push("必填参数:");
    for (const [k, v] of Object.entries(usage.required))
      lines.push(`  ${pad(k, 28)}${v}`);
  }
  if (usage.optional && Object.keys(usage.optional).length > 0) {
    lines.push("");
    lines.push("可选参数:");
    for (const [k, v] of Object.entries(usage.optional))
      lines.push(`  ${pad(k, 28)}${v}`);
  }
  if (usage.values && Object.keys(usage.values).length > 0) {
    lines.push("");
    lines.push("合法值:");
    for (const [k, v] of Object.entries(usage.values))
      lines.push(`  ${pad(k, 28)}${v}`);
  }
  if (usage.examples && usage.examples.length > 0) {
    lines.push("");
    lines.push("示例:");
    for (const ex of usage.examples) lines.push(`  ${ex}`);
  }
  if (usage.notes && usage.notes.length > 0) {
    lines.push("");
    lines.push("注意:");
    for (const n of usage.notes) lines.push(`  - ${n}`);
  }
  return lines.join("\n");
}

function pad(s, width) {
  if (s.length >= width) return s + "  ";
  return s + " ".repeat(width - s.length);
}

/**
 * Print error message + USAGE block to stderr and exit with code 1.
 *
 * Design intent: when an AI agent invokes an xflow script with wrong/missing
 * args, the script's exit output should give the AI everything it needs to
 * self-correct without consulting external docs. So we always echo the full
 * USAGE descriptor next to the error.
 */
export function printUsageAndExit(usage, errorMessage) {
  console.error(`[xflow] Error: ${errorMessage}`);
  console.error("");
  console.error(renderUsage(usage));
  process.exit(1);
}

/**
 * Print USAGE block to stdout and exit cleanly. Used for explicit `--help` /
 * `-h` invocations where the user/AI is querying the spec, not erroring out.
 */
export function printHelpAndExit(usage) {
  console.log(renderUsage(usage));
  process.exit(0);
}

/**
 * If args.help is truthy, print USAGE and exit 0. Convenience helper for
 * scripts so they can do `handleHelpFlag(args, USAGE)` as the first thing in
 * main().
 */
export function handleHelpFlag(args, usage) {
  if (args.help) printHelpAndExit(usage);
}

/**
 * Levenshtein 距离（迭代版，O(m*n) 时空，足够 CLI 参数名场景）。
 *
 * 仅用于 assertAllowedArgs 的"你是不是想写"建议，不暴露为公开 API。
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const m = a.length;
  const n = b.length;
  // 滚动数组：prev / curr 各 n+1 长度
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // insert
        prev[j] + 1, // delete
        prev[j - 1] + cost, // substitute
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * 在 allowed 列表里找一个最接近 input 的候选，距离 > maxDist 时返回 null。
 *
 * 设计偏保守（默认 maxDist=2）：避免给出离谱的推荐误导 agent。比较时大小写不敏感
 * 也忽略风格差异（连字符 / 下划线 / 驼峰统一规范化），这样 `--moduleType`、
 * `--module_type`、`--ModuleType` 都能映射到 `--module-type`。
 */
function suggestSimilar(input, allowed, maxDist = 2) {
  const norm = (s) => s.toLowerCase().replace(/[-_]/g, "");
  const target = norm(input);
  let best = null;
  let bestDist = Infinity;
  for (const cand of allowed) {
    const d = levenshtein(target, norm(cand));
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  }
  return bestDist <= maxDist ? best : null;
}

/**
 * 校验 args 中只包含 allowed 列表里的 key，否则立刻 exit 1 + 打印错误 + USAGE。
 *
 * 设计意图：xflow 脚本主要由 AI agent 调用。agent 最常见的错法不是值不对，而是
 * **参数名拼错**（`--moduleType` vs `--module-type`、漏写连字符、大小写错）。
 * `parseArgs` 默默接受未知 key，导致后续业务校验给出"必填参数缺失"这种误导性
 * 报错，agent 反复重试都对不上。本 helper 的核心价值是：
 *   1. 立刻 exit 1：让 agent 100% 感知到失败
 *   2. 给候选项："未知参数 --moduleType（你是不是想写 --module-type？）"
 *   3. 附带列出全部合法参数，agent 看一眼就能自我纠正
 *
 * 用法：
 *   const args = parseArgs();
 *   handleHelpFlag(args, USAGE);
 *   assertAllowedArgs(args, ["help", "module-type", "phase", "all-phases"], USAGE);
 *   // 此后 args 里只可能有 allowed 列表里的 key
 *
 * 注意：allowed 必须包含 "help"（因为 -h/--help 都会被 parseArgs 解析为 args.help）。
 */
export function assertAllowedArgs(args, allowed, usage) {
  const allowedSet = new Set(allowed);
  allowedSet.add("flow");
  for (const k of Object.keys(args)) {
    if (allowedSet.has(k)) continue;
    const hint = suggestSimilar(k, allowed);
    const allowedDisplay = allowed.map((a) => `--${a}`).join(" / ");
    const msg = hint
      ? `未知参数 --${k}（你是不是想写 --${hint}？）\n合法参数：${allowedDisplay}`
      : `未知参数 --${k}\n合法参数：${allowedDisplay}`;
    printUsageAndExit(usage, msg);
  }
}

// ── writePhase（统一写入入口）─────────────────────────────────────────
/**
 * 设置 change.yaml 的 phase 字段（幂等）。
 * 这是所有 phase 写入的唯一入口：CLI 命令、脚本、AI 指令都应调用此函数。
 *
 * @param {string} flowId - Flow 名称
 * @param {string} nodeId - 目标 phase（节点 ID）
 * @param {object} [opts]
 * @param {string} [opts.flowName] - flow 字段值（Group 模式必填）
 * @returns {{ ok: boolean, phase: string, created: boolean }}
 */
/**
 * 把 Flow 节点 ID 归一为 canonical phase（短名）。
 *
 * xflow 里 `phase` 的唯一真源是**短名**（clarify / design …），与模板
 * `_shared/change.yaml`、文档、命令保持一致；而 Flow.yaml 的节点 ID 通常带 flow
 * 前缀（如 xf 流的 `xf-clarify`）。写入 / 比对 phase 前统一走这里剥前缀：
 *   - 已知 flowId 时优先剥 `${flowId}-`（最精确，兼容多段 flow 名）；
 *   - 否则回退剥首个 `-` 前的段（与 xf-enter-node 推导 commandName 同一约定）；
 *   - 短名（无 `-`）或 "null" 原样返回。
 * 这样 `clarify`、`xf-clarify` 归一后都得到 `clarify`，写入准确、比对稳健。
 */
export function nodeToPhase(nodeId, flowId) {
  if (!nodeId || nodeId === "null") return nodeId;
  if (flowId && nodeId.startsWith(`${flowId}-`)) {
    return nodeId.slice(flowId.length + 1);
  }
  const i = nodeId.indexOf("-");
  return i >= 0 ? nodeId.slice(i + 1) : nodeId;
}

export function writePhase(flowId, nodeId, opts = {}) {
  const flowName = opts.flowName ?? null;
  const yamlPath = join(changesDir(flowId), "change.yaml");
  const timestamp = new Date().toISOString();
  const today = timestamp.slice(0, 10);
  // canonical phase = 完整节点 ID（如 xf-split）。整条 flow-engine 与 web 后端都以节点
  // 全 ID 为唯一标识：gates.json 的 requires、.gates/<nodeId>.json、后端 GateReview
  // 唯一键 (flowName, nodeId, changeId)、approve-new 的 nodeId、审核插件的门禁判定、
  // Web 深链的 node 参数——全用全 ID。因此这里"先写准确"（写全 ID），phase 入口校验
  // (xf-check-phase) 再用 nodeToPhase 做前缀双向容错兜底，兼容历史遗留的短名 change.yaml。
  const phaseValue = nodeId;
  let created = false;

  if (!existsSync(yamlPath)) {
    mkdirSync(changesDir(flowId), { recursive: true });
    writeFileSync(
      yamlPath,
      _renderPhaseTemplate(phaseValue, today, flowName, timestamp, flowId),
      "utf-8",
    );
    created = true;
  } else {
    let content = readFileSync(yamlPath, "utf-8");
    content = _upsertYamlField(content, "phase", phaseValue);
    content = _upsertYamlField(content, "updated_at", today);
    if (flowName) {
      content = _upsertYamlField(content, "flow", flowName);
    }
    writeFileSync(yamlPath, content, "utf-8");
  }

  return { ok: true, phase: phaseValue, created };
}

/** 首次创建时的精简模板 */
function _renderPhaseTemplate(phase, date, flow, timestamp, flowId) {
  const id = generateChangeId({
    projectId: PROJECT_ROOT,
    timestamp,
    flow: flow || flowId,
  });
  const lines = [
    "# 变更元数据（机器可读）",
    "",
    `id: "${id}"`,
    `name: ""`,
    `status: "in-progress"`,
    `phase: "${phase}"`,
    `created_at: "${date}"`,
    `updated_at: "${date}"`,
  ];
  if (flow) lines.push(`flow: "${flow}"`);
  lines.push("");
  return lines.join("\n");
}

/**
 * 更新顶层 key 的值；若该 key 不存在则在文件末尾追加。
 * 值统一加双引号，匹配读取端正则 /^key:\s*["']?...["']?/。
 */
function _upsertYamlField(content, key, value) {
  const re = new RegExp(`^${key}:.*$`, "m");
  const line = `${key}: "${value}"`;
  if (re.test(content)) {
    return content.replace(re, line);
  }
  const sep = content.endsWith("\n") || content === "" ? "" : "\n";
  return content + sep + line + "\n";
}
