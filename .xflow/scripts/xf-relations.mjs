#!/usr/bin/env node

/**
 * xf-relations — Relationship Graph Engine（Parser / Effective View / Graph / Index / CLI）
 *
 * 职责：
 *   1. parseSpec() / parseDesign() / parseTask()
 *      按定版 Relationship DSL 机械解析 Markdown，产出业务对象（不产 Edge）：
 *        Spec:   FR-xxx + acs: AC-01, AC-02        （FR → AC）
 *        Design: DS-xxx + fr: FR-xxx + depends: DS-xxx[@module]  （FR → DS、DS → DS）
 *        Task:   Txxx   + ds: DS-xxx + depends: Txxx[@module]    （DS → Task、Task → Task）
 *   2. resolveObjectRef()
 *      FR/DS/Task/AC 统一引用解析。Graph 内部唯一稳定 Key 格式：module/object-id
 *      （如 todo-core/DS-003）。不产出旧格式 DS-001@todo-core。
 *   3. removed: DSL 解析（唯一对象删除 DSL；V1 不允许 @module 跨模块删除）
 *        spec.delta.md   只允许 FR / AC
 *        design.delta.md 只允许 DS
 *        task.delta.md   只允许 Task
 *   4. buildEffectiveView() / buildEffectiveViewFromDirs()
 *      Modules baseline + Active Change 的对象级 覆盖 / 新增 / 删除 → 内存 Effective View。
 *      覆盖是"整个对象替换"，不做字段级 merge。本阶段全部在内存完成，
 *      不读写 relationship-index.json。
 *   5. buildGraph()
 *      Effective View → 内存 Graph { nodes: {}, edges: [] }（不落盘）。
 *      Node：key = module/object-id，保存 type / id，data 仅有 title（有 title 时），
 *      source 直接复用 Effective View 已有 source；不自动创建 Effective View 之外的对象。
 *      Edge 固定五种模式（type 取 DSL 字段名）：
 *        acs(FR→AC) / fr(FR→DS) / ds(DS→Task) / depends(DS→DS) / depends(Task→Task)。
 *      跨模块引用经 resolveObjectRef() 解析为稳定 Key；引用目标不存在仍生成 Edge，
 *      不自动补 Node（悬空引用由 validate 阶段识别）。
 *   6. build / validate / query / impact / next-id
 *      已接线为正式 CLI；持久化 build 安全替换 relationship-index.json，next-id 只读扫描历史。
 *
 * 设计边界：
 *   - @module 只负责跨模块定位；关系语义由 acs / fr / ds / depends 字段决定
 *   - Parser 只认明确 DSL，不做自然语言语义猜测（"这句话可能意味着删除"一律不识别）
 *   - 关系字段在业务对象中保留原始引用字符串（如 "DS-001@todo-validation"），
 *     由 buildGraph() 解析为稳定 Key 并构建 Edge
 *   - Engine 核心不依赖 lib.mjs / xf-current-change.mjs（避免 cwd 耦合与扩大既有脚本职责）；CLI 入口段复用 lib.mjs。
 *     change.yaml 采用最小行解析（接口参考 xf-current-change 输出形状）
 *
 * 错误码（RelationError.code）：
 *   REMOVE_CONFLICT          同一 Change 中同一对象既重新定义又 removed（需求固定）
 *   REMOVE_TARGET_NOT_FOUND  removed 指向 baseline 不存在的对象（需求固定）
 *   INVALID_REFERENCE        非法引用：空引用 / 多个 @ / @ 左空 / @ 右空 / 缺模块 / 不支持的 ID
 *   DUPLICATE_NODE            同一模块中同一对象被重复定义
 *   DUPLICATE_MODULE          change.yaml 中 affected_modules 重复声明同名模块
 *   REMOVED_CROSS_MODULE     removed 中出现 @module（V1 禁止跨模块删除）
 *   REMOVED_TYPE_MISMATCH    removed 对象类型与 delta 文件类型不匹配（如 design.delta 删 FR）
 *   INVALID_NEW_AC_ID        本 Change 新增 AC 使用非 canonical legacy ID
 *   NODE_OUTSIDE_KNOWN_GRAPH partial/unknown snapshot 未覆盖请求的 focus Node
 *   INVALID_MODULE           next-id 的 module 参数不安全或非法
 *   INVALID_ID_TYPE          next-id 只支持 fr / ds
 *   PROJECT_NOT_FOUND        next-id 的当前 Flow 数据根缺失或不是目录
 *   ID_SPACE_EXHAUSTED       三位 FR/DS canonical 编号已用尽
 */

import { readFile, readdir, writeFile, rename, unlink, mkdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// ── 错误 ─────────────────────────────────────────────────────────────

export class RelationError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "RelationError";
    this.code = code;
    this.detail = detail;
  }
}

async function assertDirectoryRoots(roots, { code, operation }) {
  const invalidRoots = [];
  for (const [name, path] of Object.entries(roots)) {
    if (typeof path !== "string" || path.length === 0) {
      invalidRoots.push({ name, path, reason: "invalid_path" });
      continue;
    }
    try {
      const info = await stat(path);
      if (!info.isDirectory()) invalidRoots.push({ name, path, reason: "not_directory" });
    } catch (error) {
      invalidRoots.push({
        name,
        path,
        reason: error?.code === "ENOENT" ? "missing" : "unavailable",
        ...(error?.code ? { error_code: error.code } : {}),
      });
    }
  }
  if (invalidRoots.length > 0) {
    const summary = invalidRoots.map((item) => `${item.name}=${item.reason}`).join("，");
    throw new RelationError(
      code,
      `${operation} 的数据根不可用：${summary}`,
      { invalid_roots: invalidRoots },
    );
  }
}

// ── 对象 ID 规则（稳定 Key = module/object-id）─────────────────────
// FR/DS/Task 三位编号与 xf-deps TASK_RE（T\d{3}）保持一致；
// Existing AC identity 宽读：AC- + 安全 token（字母/数字/-，无空段）且至少含一位数字。
// 新 AC issuance 仍由 CANONICAL_AC_ID_RE 约束为 AC-\d{1,3}。
const CANONICAL_AC_ID_RE = /^AC-\d{1,3}$/;
const EXISTING_AC_ID_PATTERN = "AC-(?=[A-Za-z0-9-]*\\d)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*";
const EXISTING_AC_ID_RE = new RegExp(`^${EXISTING_AC_ID_PATTERN}$`);

const ID_TYPE_RULES = [
  { type: "fr", re: /^FR-\d{3}$/ },
  { type: "ac", re: EXISTING_AC_ID_RE },
  { type: "ds", re: /^DS-\d{3}$/ },
  { type: "task", re: /^T\d{3}$/ },
];

const AC_TABLE_DEFINITION_RE = new RegExp(`^\\s*\\|\\s*(${EXISTING_AC_ID_PATTERN})\\s*\\|(.*)$`);
const AC_HEADING_DEFINITION_RE = new RegExp(`^#{1,6}\\s+\\**\\s*(${EXISTING_AC_ID_PATTERN})(?![A-Za-z0-9-])\\s*\\**\\s*[:：]?\\s*(.*)$`);
const AC_CHECKBOX_DEFINITION_RE = new RegExp(`^\\s*[-*]\\s+\\[[ x]\\]\\s+\\**\\s*(${EXISTING_AC_ID_PATTERN})(?![A-Za-z0-9-])\\s*\\**\\s*[:：]?\\s*(.*)$`);
const AC_LIST_DEFINITION_RE = new RegExp(`^\\s*[-*]\\s+\\**\\s*(${EXISTING_AC_ID_PATTERN})(?![A-Za-z0-9-])\\s*\\**\\s*[:：]?\\s*(.*)$`);
const AC_STANDALONE_DEFINITION_RE = new RegExp(`^\\s*(${EXISTING_AC_ID_PATTERN})(?![A-Za-z0-9-])\\s*[:：]\\s*(.*)$`);

/** 返回 ID 的对象类型（fr/ac/ds/task），不支持则 null */
export function detectIdType(id) {
  for (const rule of ID_TYPE_RULES) {
    if (rule.re.test(id)) return rule.type;
  }
  return null;
}

// ── resolveObjectRef：统一引用解析 ──────────────────────────────────

/**
 * 把引用解析为稳定 Key。FR/DS/Task/AC 同一套规则。
 *
 *   resolveObjectRef("FR-001", "todo-core")              → todo-core/FR-001
 *   resolveObjectRef("DS-001@todo-validation", "x")      → todo-validation/DS-001
 *
 * @param {string} ref 引用原文（可含 @module）
 * @param {string} defaultModule 无 @module 时的当前模块名
 * @returns {{ module: string, id: string, type: string, key: string }}
 * @throws {RelationError} INVALID_REFERENCE
 */
export function resolveObjectRef(ref, defaultModule) {
  const fail = (reason) => {
    throw new RelationError(
      "INVALID_REFERENCE",
      `非法对象引用 "${ref ?? ""}"：${reason}`,
      { ref, reason },
    );
  };

  if (typeof ref !== "string") fail("引用不是字符串");
  const trimmed = ref.trim();
  if (!trimmed) fail("空引用");

  const atCount = (trimmed.match(/@/g) || []).length;
  if (atCount > 1) fail("出现多个 @");

  let idPart = trimmed;
  let modulePart = defaultModule;
  if (atCount === 1) {
    const idx = trimmed.indexOf("@");
    idPart = trimmed.slice(0, idx).trim();
    modulePart = trimmed.slice(idx + 1).trim();
    if (!idPart) fail("@ 左侧（对象 ID）为空");
    if (!modulePart) fail("@ 右侧（模块名）为空");
  }

  if (typeof modulePart !== "string" || !modulePart.trim()) fail("缺少模块名");
  modulePart = modulePart.trim();
  if (/[@/\s]/.test(modulePart)) fail("模块名非法（不能含 @、/ 或空白）");

  const type = detectIdType(idPart);
  if (!type) fail("不支持的对象 ID（支持 FR-xxx / AC-xx / DS-xxx / Txxx）");

  return { module: modulePart, id: idPart, type, key: `${modulePart}/${idPart}` };
}

// ── 业务对象构造 ────────────────────────────────────────────────────

function makeObject(module, type, id, title, file) {
  return {
    key: `${module}/${id}`,
    module,
    type, // fr | ac | ds | task
    id,
    title: title || "",
    refs: {}, // 关系字段保留原始引用字符串；buildGraph() 据此构建 Edge
    source: { file, anchor: id },
  };
}

function splitRefList(raw) {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function markdownLines(content) {
  const lines = [];
  let fence = null;
  for (const line of content.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      const char = marker[1][0];
      if (!fence) fence = { char, length: marker[1].length };
      else if (fence.char === char && marker[1].length >= fence.length) fence = null;
      lines.push({ line, fenced: true, boundary: true });
      continue;
    }
    lines.push({ line, fenced: Boolean(fence), boundary: false });
  }
  return lines;
}

// ── parseSpec：FR / AC ──────────────────────────────────────────────
//
// FR 定义（三种等价写法）：
//   ### FR-001 创建订单        ← 标题行
//   **FR-001** 创建订单        ← 加粗行
//   FR-001 创建订单            ← 普通行
//   - **FR-001** 创建订单      ← 列表行
// FR 字段：acs: AC-01, AC-02
// AC 定义：验收标准表格行（当前 spec.md 模板真实格式）/ 标题 / 列表项。
// acs: 只保存 AC 引用；被引用但文档未真实定义的 AC 不自动补节点，
// buildGraph() 仍会为悬空引用生成 Edge（不补 Node），
// 此类 dangling reference 由后续 validate 阶段识别。

/**
 * 解析 Spec（spec.md 或 spec.delta.md 内容），返回业务对象数组（FR + AC）。
 * @param {string} content Markdown 原文
 * @param {string} module 模块名
 * @param {string} file 来源文件路径（写入 source.file）
 */
export function parseSpec(content, module, file) {
  const objects = new Map();
  let current = null;

  for (const entry of markdownLines(content)) {
    const { line } = entry;
    if (entry.fenced) {
      if (entry.boundary) current = null;
      continue;
    }
    // 1) FR 定义
    let m =
      line.match(/^#{1,6}\s+\**\s*(FR-\d{3})\b\s*\**\s*[:：]?\s*(.*)$/) ||
      line.match(/^\s*\*\*(FR-\d{3})\*\*\s*[:：]?\s*(.*)$/) ||
      line.match(/^\s*[-*]\s+\**\s*(FR-\d{3})\b\s*\**\s*[:：]?\s*(.*)$/) ||
      line.match(/^\s*(FR-\d{3})\b\s*(.*)$/);
    if (m) {
      const key = `${module}/${m[1]}`;
      if (objects.has(key)) {
        throw new RelationError("DUPLICATE_NODE", `重复定义对象 ${key}`, { key });
      }
      current = makeObject(module, "fr", m[1], (m[2] || "").trim(), file);
      objects.set(current.key, current);
      continue;
    }

    // 2) AC 定义：表格行（模板真实格式：| AC-01 | 关联 | Given | When | Then | 优先级 |）
    m = line.match(AC_TABLE_DEFINITION_RE);
    if (m) {
      const id = m[1];
      const key = `${module}/${id}`;
      if (objects.has(key)) {
        throw new RelationError("DUPLICATE_NODE", `重复定义对象 ${key}`, { key });
      }
      const cells = m[2]
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);
      objects.set(key, makeObject(module, "ac", id, cells.join(" | "), file));
      current = null;
      continue;
    }

    // 3) AC 定义：标题 / 列表项 / 独立行
    m =
      line.match(AC_HEADING_DEFINITION_RE) ||
      line.match(AC_CHECKBOX_DEFINITION_RE) ||
      line.match(AC_LIST_DEFINITION_RE) ||
      line.match(AC_STANDALONE_DEFINITION_RE);
    if (m) {
      const id = m[1];
      const key = `${module}/${id}`;
      if (objects.has(key)) {
        throw new RelationError("DUPLICATE_NODE", `重复定义对象 ${key}`, { key });
      }
      objects.set(key, makeObject(module, "ac", id, (m[2] || "").trim(), file));
      current = null;
      continue;
    }

    // 4) FR 字段：acs:
    m = line.match(/^\s*acs:\s*(.+)$/);
    if (m && current && current.type === "fr") {
      current.refs.acs = [...(current.refs.acs || []), ...splitRefList(m[1])];
      continue;
    }

    // 5) 关系字段必须紧跟对象头；进入正文后关闭当前对象块
    if (line.trim() !== "") current = null;
  }

  return [...objects.values()];
}

// ── parseDesign：DS ─────────────────────────────────────────────────
//
// DS 定义（三种等价写法，同 FR）：
//   ### DS-003 完成 Todo
// DS 字段：
//   fr: FR-003                          ← 保留为数组，不写死单个
//   depends: DS-001, DS-001@todo-validation

/**
 * 解析 Design（design.md 或 design.delta.md 内容），返回 DS 业务对象数组。
 */
export function parseDesign(content, module, file) {
  const objects = new Map();
  let current = null;

  for (const entry of markdownLines(content)) {
    const { line } = entry;
    if (entry.fenced) {
      if (entry.boundary) current = null;
      continue;
    }
    const m =
      line.match(/^#{1,6}\s+\**\s*(DS-\d{3})\b\s*\**\s*[:：]?\s*(.*)$/) ||
      line.match(/^\s*\*\*(DS-\d{3})\*\*\s*[:：]?\s*(.*)$/) ||
      line.match(/^\s*(DS-\d{3})\b\s*(.*)$/);
    if (m) {
      const key = `${module}/${m[1]}`;
      if (objects.has(key)) {
        throw new RelationError("DUPLICATE_NODE", `重复定义对象 ${key}`, { key });
      }
      current = makeObject(module, "ds", m[1], (m[2] || "").trim(), file);
      objects.set(current.key, current);
      continue;
    }

    let f = line.match(/^\s*fr:\s*(.+)$/);
    if (f && current) {
      current.refs.fr = [...(current.refs.fr || []), ...splitRefList(f[1])];
      continue;
    }

    f = line.match(/^\s*depends:\s*(.+)$/);
    if (f && current) {
      current.refs.depends = [...(current.refs.depends || []), ...splitRefList(f[1])];
      continue;
    }

    if (line.trim() !== "") current = null;
  }

  return [...objects.values()];
}

// ── parseTask：Task ─────────────────────────────────────────────────
//
// Task 定义：
//   - [ ] T040 实现完成 Todo     ← checkbox 行（仓库真实格式，同 xf-deps TASK_RE）
//   - [x] T041 已完成任务        ← done=true
//   T040 实现完成 Todo           ← 普通行 / 标题行（delta 文档等价写法）
// Task 字段（允许任务行与字段行之间有空行）：
//   ds: DS-003
//   depends: T030, T001@todo-validation

/**
 * 解析 Task（task.md 或 task.delta.md 内容），返回 Task 业务对象数组。
 */
export function parseTask(content, module, file) {
  const objects = new Map();
  let current = null;

  for (const entry of markdownLines(content)) {
    const { line } = entry;
    if (entry.fenced) {
      if (entry.boundary) current = null;
      continue;
    }
    let id = null;
    let title = "";
    let done = false;
    let isDef = false;

    // checkbox 行（真实仓库格式）
    let m = line.match(/^- \[([ x])\]\s+(T\d{3})\b\s*(.*)$/);
    if (m) {
      id = m[2];
      title = (m[3] || "").trim();
      done = m[1] === "x";
      isDef = true;
    } else {
      m =
        line.match(/^#{1,6}\s+\**\s*(T\d{3})\b\s*\**\s*[:：]?\s*(.*)$/) ||
        line.match(/^\s*(T\d{3})\b\s*(.*)$/);
      if (m) {
        id = m[1];
        title = (m[2] || "").trim();
        isDef = true;
      }
    }

    if (isDef) {
      const key = `${module}/${id}`;
      if (objects.has(key)) {
        throw new RelationError("DUPLICATE_NODE", `重复定义对象 ${key}`, { key });
      }
      current = makeObject(module, "task", id, title, file);
      current.done = done;
      objects.set(current.key, current);
      continue;
    }

    let f = line.match(/^\s*ds:\s*(.+)$/);
    if (f && current) {
      current.refs.ds = [...(current.refs.ds || []), ...splitRefList(f[1])];
      continue;
    }

    f = line.match(/^\s*depends:\s*(.+)$/);
    if (f && current) {
      current.refs.depends = [...(current.refs.depends || []), ...splitRefList(f[1])];
      continue;
    }

    if (line.trim() !== "") current = null;
  }

  return [...objects.values()];
}

// ── removed: DSL ────────────────────────────────────────────────────

/** delta 文件类型 → 允许 removed 的对象类型 */
export const REMOVED_ALLOWED_TYPES = {
  spec: ["fr", "ac"],
  design: ["ds"],
  task: ["task"],
};

/**
 * 解析文档中的 removed: 行（唯一对象删除 DSL）。
 * 规则：逗号分隔多个 ID；V1 不允许 @module；类型必须匹配 delta 文件白名单。
 *
 * @returns {string[]} 被删对象的稳定 Key 列表（module/object-id）
 * @throws {RelationError} REMOVED_CROSS_MODULE | INVALID_REFERENCE | REMOVED_TYPE_MISMATCH
 */
export function parseRemoved(content, module, file, allowedTypes) {
  const keys = new Set();
  for (const entry of markdownLines(content)) {
    if (entry.fenced) continue;
    const { line } = entry;
    const m = line.match(/^\s*removed:\s*(.+)$/);
    if (!m) continue;
    for (const raw of splitRefList(m[1])) {
      if (raw.includes("@")) {
        throw new RelationError(
          "REMOVED_CROSS_MODULE",
          `removed: 不允许跨模块删除（V1）："${raw}"（${file}）。删除其它模块对象须在该模块自己的 Change 文档中声明`,
          { ref: raw, file },
        );
      }
      const ref = resolveObjectRef(raw, module);
      if (!allowedTypes.includes(ref.type)) {
        throw new RelationError(
          "REMOVED_TYPE_MISMATCH",
          `${file} 只允许删除 [${allowedTypes.join(" / ")}] 类型对象，出现 "${raw}"`,
          { ref: raw, file, allowedTypes },
        );
      }
      keys.add(ref.key);
    }
  }
  return [...keys];
}

/** 解析 spec.delta.md：FR/AC 对象 + removed（仅 FR/AC） */
export function parseSpecDelta(content, module, file) {
  return {
    objects: parseSpec(content, module, file),
    removedKeys: parseRemoved(content, module, file, REMOVED_ALLOWED_TYPES.spec),
  };
}

/** 解析 design.delta.md：DS 对象 + removed（仅 DS） */
export function parseDesignDelta(content, module, file) {
  return {
    objects: parseDesign(content, module, file),
    removedKeys: parseRemoved(content, module, file, REMOVED_ALLOWED_TYPES.design),
  };
}

/** 解析 task.delta.md：Task 对象 + removed（仅 Task） */
export function parseTaskDelta(content, module, file) {
  return {
    objects: parseTask(content, module, file),
    removedKeys: parseRemoved(content, module, file, REMOVED_ALLOWED_TYPES.task),
  };
}

// ── Effective View（纯内存）─────────────────────────────────────────

/**
 * Modules baseline + Change（对象级覆盖/新增/删除）→ Effective View。
 *
 * 覆盖语义：同一稳定 Key 出现在 Change 中时，Change 对象【整体替换】baseline 对象，
 * 不做字段级 merge，不继承旧字段。
 *
 * @param {{ baseline: object[], changeObjects: object[], removedKeys: string[] }} args
 * @returns {{ view: Map<string, object>, stats: { baselineCount: number, added: string[], overwritten: string[], removed: string[] } }}
 * @throws {RelationError} REMOVE_CONFLICT | REMOVE_TARGET_NOT_FOUND
 */
export function buildEffectiveView({ baseline, changeObjects, removedKeys }) {
  const view = new Map();
  for (const obj of baseline) view.set(obj.key, obj);

  const removedSet = new Set(removedKeys);
  const changeKeySet = new Set(changeObjects.map((o) => o.key));

  // 冲突：同一 Change 中同一对象既重新定义又 removed
  for (const key of removedSet) {
    if (changeKeySet.has(key)) {
      throw new RelationError(
        "REMOVE_CONFLICT",
        `同一变更中对象既被重新定义又被 removed：${key}`,
        { key },
      );
    }
  }
  // 删除目标必须存在于 baseline
  for (const key of removedSet) {
    if (!view.has(key)) {
      throw new RelationError(
        "REMOVE_TARGET_NOT_FOUND",
        `removed 目标在 Modules baseline 中不存在：${key}`,
        { key },
      );
    }
  }

  // Existing legacy AC 可被读取、引用和覆盖；本轮真正新增的 AC 仍只允许 canonical ID。
  for (const obj of changeObjects) {
    if (obj.type === "ac" && !view.has(obj.key) && !CANONICAL_AC_ID_RE.test(obj.id)) {
      throw new RelationError(
        "INVALID_NEW_AC_ID",
        `新建 AC 必须使用 canonical ID（AC-1 至 AC-999）：${obj.key}`,
        { key: obj.key, id: obj.id },
      );
    }
  }

  for (const key of removedSet) view.delete(key);

  const added = new Set();
  const overwritten = new Set();
  for (const obj of changeObjects) {
    if (view.has(obj.key)) overwritten.add(obj.key);
    else added.add(obj.key);
    view.set(obj.key, obj); // 整体替换
  }

  return {
    view,
    stats: {
      baselineCount: baseline.length,
      added: [...added],
      overwritten: [...overwritten],
      removed: [...removedSet],
    },
  };
}

// ── change.yaml 最小解析（接口参考 xf-current-change 输出形状）─────

function dequoteScalar(s) {
  const t = s.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * 剥离 YAML 行内注释：引号外的 # 且前导空白（或行首）才视为注释起点，
 * 引号内的 #（如 id 模板）不剥离。
 */
function stripInlineComment(s) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "#" && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(s[i - 1])) return s.slice(0, i);
    }
  }
  return s;
}

/**
 * 只读投影 modules/<module>/module.yaml 中的 Relationship migration coverage。
 * metadata 缺失、未知值或无法识别时一律保守解释为 partial；本函数不写 transition。
 */
export function parseRelationshipCoverage(content) {
  if (typeof content !== "string") return "partial";
  let relationshipIndent = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    const relationship = line.match(/^(\s*)relationship:\s*(?:#.*)?$/);
    if (relationship) {
      relationshipIndent = relationship[1].length;
      continue;
    }
    if (relationshipIndent === null) continue;
    if (indent <= relationshipIndent) {
      relationshipIndent = null;
      continue;
    }

    const coverage = line.match(/^\s*coverage:\s*(.+)$/);
    if (!coverage) continue;
    const value = dequoteScalar(stripInlineComment(coverage[1])).trim();
    return value === "complete" ? "complete" : "partial";
  }
  return "partial";
}

/** 最小 change.yaml 行解析：只取 Relationship 需要的字段
 * （id / phase / status / affected_modules[name, change_type, module_type]）。
 * "new" 归一化为 "added"（与 xf-audit-packet 一致）。
 * 值解析先剥离行内注释再去引号（真实模板大量使用行内注释）。
 */
export function parseChangeYaml(content) {
  const meta = { id: null, name: null, status: null, phase: null, affected_modules: [] };
  let inModules = false;
  let cur = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;

    const top = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (top) {
      const key = top[1];
      inModules = key === "affected_modules";
      cur = null;
      if (key === "id") meta.id = dequoteScalar(stripInlineComment(top[2]));
      else if (key === "name") meta.name = dequoteScalar(stripInlineComment(top[2]));
      else if (key === "status") meta.status = dequoteScalar(stripInlineComment(top[2]));
      else if (key === "phase") meta.phase = dequoteScalar(stripInlineComment(top[2]));
      continue;
    }

    if (!inModules) continue;

    const nameM = line.match(/^\s*-\s+name:\s*(.+)$/);
    if (nameM) {
      cur = {
        name: dequoteScalar(stripInlineComment(nameM[1])),
        change_type: null,
        module_type: null,
      };
      meta.affected_modules.push(cur);
      continue;
    }
    if (!cur) continue;
    const ctM = line.match(/^\s*change_type:\s*(.+)$/);
    if (ctM) {
      cur.change_type = dequoteScalar(stripInlineComment(ctM[1]));
      continue;
    }
    const mtM = line.match(/^\s*module_type:\s*(.+)$/);
    if (mtM) cur.module_type = dequoteScalar(stripInlineComment(mtM[1]));
  }

  const moduleNames = new Set();
  for (const m of meta.affected_modules) {
    if (moduleNames.has(m.name)) {
      throw new RelationError("DUPLICATE_MODULE", `change.yaml 中模块 ${m.name} 被重复声明`, { module: m.name });
    }
    moduleNames.add(m.name);
    if (m.change_type === "new") m.change_type = "added";
  }
  return meta;
}

// ── 目录级加载（Modules baseline / Active Change）──────────────────

const DOC_KINDS = [
  { kind: "spec", full: "spec.md", delta: "spec.delta.md", parse: parseSpec, parseDelta: parseSpecDelta },
  { kind: "design", full: "design.md", delta: "design.delta.md", parse: parseDesign, parseDelta: parseDesignDelta },
  { kind: "task", full: "task.md", delta: "task.delta.md", parse: parseTask, parseDelta: parseTaskDelta },
];

async function readIfExists(path) {
  if (!existsSync(path)) return null;
  return readFile(path, "utf-8");
}

async function loadBaselineSnapshot(modulesDir, flowId) {
  if (!existsSync(modulesDir)) return { objects: [], moduleNames: [] };
  const entries = await readdir(modulesDir, { withFileTypes: true });
  const moduleNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const objects = [];
  for (const moduleName of moduleNames) {
    objects.push(...(await loadModuleObjects(join(modulesDir, moduleName), moduleName, flowId)));
  }
  return { objects, moduleNames };
}

/** 读取当前模块的 coverage projection；缺 metadata 保守为 partial。 */
export async function loadCoverageProjection({ modulesDir, moduleNames }) {
  const modules = {};
  for (const moduleName of [...new Set(moduleNames)].sort()) {
    const content = await readIfExists(join(modulesDir, moduleName, "module.yaml"));
    modules[moduleName] = parseRelationshipCoverage(content);
  }
  return {
    overall: Object.values(modules).some((status) => status !== "complete") ? "partial" : "complete",
    modules,
  };
}

/** 读取 modules/<name>/ 下 spec/design/task 全量文件 → 业务对象 */
export async function loadModuleObjects(moduleDir, moduleName, flowId) {
  const objects = [];
  for (const d of DOC_KINDS) {
    const content = await readIfExists(join(moduleDir, d.full));
    if (content === null) continue;
    // source.file 使用稳定的项目内逻辑相对路径（正斜杠）：xspec/<flowId>/modules/...
    // flowId 由调用链传入（运行时来自 resolveFlowId()，与 lib.mjs 数据层路径工厂一致），不硬编码任何具体 Flow 名
    const logicalFile = `xspec/${flowId}/modules/${moduleName}/${d.full}`;
    objects.push(...d.parse(content, moduleName, logicalFile));
  }
  return objects;
}

/** 读取 modules/ 全部模块 → baseline 对象数组 */
export async function loadBaseline(modulesDir, flowId) {
  return (await loadBaselineSnapshot(modulesDir, flowId)).objects;
}

/**
 * 按 change.yaml affected_modules 读取 changes/ 下各模块文件：
 *   added（含 new/未标注）→ 全量文件（spec.md / design.md / task.md）
 *   modified              → delta 文件（*.delta.md，含 removed: 解析）
 *   removed               → 整模块删除（不读文件，由调用方展开为 baseline key 删除）
 *
 * flowId 用于构造 source.file 的稳定逻辑路径 xspec/<flowId>/changes/<module>/<file>
 */
export async function loadChangeObjects(changesDir, meta, flowId) {
  const objects = [];
  const removedKeys = [];
  const moduleRemovals = [];

  for (const mod of meta.affected_modules || []) {
    if (mod.change_type === "removed") {
      moduleRemovals.push(mod.name);
      continue;
    }
    const dir = join(changesDir, mod.name);
    const isModified = mod.change_type === "modified";
    for (const d of DOC_KINDS) {
      const fileName = isModified ? d.delta : d.full;
      const filePath = join(dir, fileName);
      const content = await readIfExists(filePath);
      if (content === null) continue;
      // source.file 使用稳定的项目内逻辑相对路径（正斜杠）：xspec/<flowId>/changes/...
      // flowId 由调用链传入（运行时来自 resolveFlowId()），不硬编码任何具体 Flow 名
      const logicalFile = `xspec/${flowId}/changes/${mod.name}/${fileName}`;
      if (isModified) {
        const { objects: objs, removedKeys: rk } = d.parseDelta(content, mod.name, logicalFile);
        objects.push(...objs);
        removedKeys.push(...rk);
      } else {
        objects.push(...d.parse(content, mod.name, logicalFile));
      }
    }
  }

  return { objects, removedKeys, moduleRemovals };
}

// ── 历史安全编号（只读）────────────────────────────────────────────

const NEXT_ID_RULES = {
  fr: { prefix: "FR", full: "spec.md", delta: "spec.delta.md", parse: parseSpec, parseDelta: parseSpecDelta },
  ds: { prefix: "DS", full: "design.md", delta: "design.delta.md", parse: parseDesign, parseDelta: parseDesignDelta },
};

function validateNextIdModule(module) {
  if (
    typeof module !== "string" ||
    module.length === 0 ||
    module === "." ||
    module === ".." ||
    /[@/\\\s]/.test(module)
  ) {
    throw new RelationError(
      "INVALID_MODULE",
      `next-id 的 module 非法：${module ?? ""}`,
      { module },
    );
  }
}

function collectParsedIds({ parsed, module, type, used }) {
  for (const object of parsed.objects || parsed) {
    if (object.module === module && object.type === type) used.add(object.id);
  }
  for (const key of parsed.removedKeys || []) {
    const prefix = `${module}/`;
    if (!key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    if (detectIdType(id) === type) used.add(id);
  }
}

async function collectIdsFromDocument({ path, logicalFile, module, type, rule, delta, used }) {
  const content = await readIfExists(path);
  if (content === null) return;
  const parsed = delta
    ? rule.parseDelta(content, module, logicalFile)
    : rule.parse(content, module, logicalFile);
  collectParsedIds({ parsed, module, type, used });
}

/**
 * 机械扫描同一 module/type 在 Modules、当前 Active Change 与 Archive 中的正式 identity，
 * 返回历史最大编号 + 1。只调用现有 Markdown parser，不做正文正则搜索，也不写任何文件。
 */
export async function nextRelationshipId({ modulesDir, changesDir, archiveDir, module, type }) {
  validateNextIdModule(module);
  const rule = NEXT_ID_RULES[type];
  if (!rule) {
    throw new RelationError(
      "INVALID_ID_TYPE",
      `next-id 的 type 必须为 fr 或 ds：${type ?? ""}`,
      { type },
    );
  }

  await assertDirectoryRoots(
    { modulesDir, changesDir, archiveDir },
    { code: "PROJECT_NOT_FOUND", operation: "next-id" },
  );

  const used = new Set();
  await collectIdsFromDocument({
    path: join(modulesDir, module, rule.full),
    logicalFile: `modules/${module}/${rule.full}`,
    module,
    type,
    rule,
    delta: false,
    used,
  });

  const changeYaml = await readIfExists(join(changesDir, "change.yaml"));
  if (changeYaml !== null) {
    const meta = parseChangeYaml(changeYaml);
    const affected = meta.affected_modules.find((entry) => entry.name === module);
    if (affected && affected.change_type !== "removed") {
      const delta = affected.change_type === "modified";
      const fileName = delta ? rule.delta : rule.full;
      await collectIdsFromDocument({
        path: join(changesDir, module, fileName),
        logicalFile: `changes/${module}/${fileName}`,
        module,
        type,
        rule,
        delta,
        used,
      });
    }
  }

  const archives = (await readdir(archiveDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const archive of archives) {
    for (const [fileName, delta] of [[rule.full, false], [rule.delta, true]]) {
      await collectIdsFromDocument({
        path: join(archiveDir, archive.name, module, fileName),
        logicalFile: `archive/${archive.name}/${module}/${fileName}`,
        module,
        type,
        rule,
        delta,
        used,
      });
    }
  }

  const max = [...used].reduce((value, id) => Math.max(value, Number(id.slice(3))), 0);
  if (max >= 999) {
    throw new RelationError(
      "ID_SPACE_EXHAUSTED",
      `${rule.prefix} 三位编号已用尽：${module}/${rule.prefix}-999`,
      { module, type, max_id: `${rule.prefix}-999` },
    );
  }
  return {
    module,
    type,
    next_id: `${rule.prefix}-${String(max + 1).padStart(3, "0")}`,
  };
}

/**
 * 完整链路：Modules baseline + Active Change → Effective View（内存）。
 * 无 change.yaml 时 Effective View = baseline。
 * source.file 输出稳定的项目内逻辑相对路径：xspec/<flowId>/modules/... 与
 * xspec/<flowId>/changes/...（统一正斜杠），与 lib.mjs 数据层路径工厂
 * （modulesDir(flowId) / changesDir(flowId)）的运行时真实目录一一对应，
 * 不含本机绝对路径或临时目录路径。
 *
 * @param {{ modulesDir: string, changesDir: string, flowId: string }} dirs
 *   modulesDir / changesDir 为显式物理路径（不依赖 cwd）；
 *   flowId 为运行时 Flow ID（生产调用链由 lib.mjs resolveFlowId() 解析后传入），
 *   仅用于 source.file 逻辑路径构造，禁止调用方硬编码具体 Flow 名。
 */
export async function buildEffectiveViewFromDirs({ modulesDir, changesDir, flowId }) {
  if (typeof flowId !== "string" || flowId.trim() === "") {
    throw new RelationError(
      "INVALID_REFERENCE",
      "buildEffectiveViewFromDirs: flowId 必填（由调用链传入运行时 Flow ID，不硬编码）",
      { flowId },
    );
  }
  const baselineSnapshot = await loadBaselineSnapshot(modulesDir, flowId);
  const baseline = baselineSnapshot.objects;

  const yamlContent = await readIfExists(join(changesDir, "change.yaml"));
  const meta = yamlContent === null ? null : parseChangeYaml(yamlContent);
  const hasActive = meta !== null && meta.affected_modules.length > 0;

  if (!hasActive) {
    return {
      view: new Map(baseline.map((o) => [o.key, o])),
      baseline,
      moduleNames: baselineSnapshot.moduleNames,
      change: null,
      stats: { baselineCount: baseline.length, added: [], overwritten: [], removed: [] },
    };
  }

  const change = await loadChangeObjects(changesDir, meta, flowId);
  const baselineKeysOfRemovedModules = baseline
    .filter((o) => change.moduleRemovals.includes(o.module))
    .map((o) => o.key);
  const removedKeys = [...new Set([...change.removedKeys, ...baselineKeysOfRemovedModules])];

  const { view, stats } = buildEffectiveView({
    baseline,
    changeObjects: change.objects,
    removedKeys,
  });
  const moduleNames = new Set(baselineSnapshot.moduleNames);
  for (const moduleName of change.moduleRemovals) moduleNames.delete(moduleName);
  for (const affected of meta.affected_modules) {
    if (affected.change_type !== "removed") moduleNames.add(affected.name);
  }

  return {
    view,
    baseline,
    moduleNames: [...moduleNames].sort(),
    change: {
      id: meta.id,
      phase: meta.phase,
      status: meta.status,
      affected_modules: meta.affected_modules,
      moduleRemovals: change.moduleRemovals,
      // 仅供本次内存 build context 判定阶段性过渡；不写入 relationship-index.json。
      explicitRemovedKeys: change.removedKeys,
    },
    stats,
  };
}

// ── Nodes + Edges Builder（纯内存）─────────────────────────────────

/**
 * Effective View → 内存 Graph { nodes: {}, edges: [] }（不落盘）。
 *
 * Node（仅来自 Effective View，不自动创建任何不存在的对象）：
 *   nodes[key] = { type, id, data, source }
 *     key    = module/object-id（Effective View 稳定 Key）
 *     type   = fr | ac | ds | task
 *     id     = 对象 ID（如 FR-001）
 *     data   = { title }（仅当对象有非空 title 时保留）
 *     source = 直接复用 Effective View 已有 source（同一引用）
 *
 * Edge 固定五种模式（type 取 DSL 字段名；一条关系一条 Edge：{ from, to, type }）：
 *   acs:     FR → AC      （来自 FR.refs.acs）
 *   fr:      FR → DS      （来自 DS.refs.fr）
 *   ds:      DS → Task    （来自 Task.refs.ds）
 *   depends: DS → DS      （来自 DS.refs.depends）
 *   depends: Task → Task  （来自 Task.refs.depends）
 *
 * 跨模块引用（如 DS-001@todo-validation）继续使用 resolveObjectRef() 解析为
 * 稳定 Key。引用目标在 Effective View 中不存在时仍生成 Edge（悬空引用），
 * 不自动补 Node，由后续 validate 阶段检查。重复关系去重为一条 Edge；
 * 自依赖（depends 指向自身）也按原始关系事实生成。非法引用抛 INVALID_REFERENCE（与既有约束一致）。
 *
 * @param {Map<string, object>} view Effective View（buildEffectiveView / buildEffectiveViewFromDirs 产出）
 * @returns {{ nodes: Record<string, object>, edges: Array<{ from: string, to: string, type: string }> }}
 * @throws {RelationError} INVALID_REFERENCE
 */
export function buildGraph(view) {
  const nodes = {};
  for (const [key, obj] of view) {
    const node = { type: obj.type, id: obj.id };
    node.data = obj.title ? { title: obj.title } : {};
    node.source = obj.source;
    nodes[key] = node;
  }

  // 五种固定 Edge 模式（type 取 DSL 字段名）。方向按需求票定义：
  //   acs: FR → AC     acs 字段存于 FR 对象 → 自然方向 from=obj(FR), to=target(AC)
  //   fr:  FR → DS     fr 字段存于 DS 对象 → 反向 from=target(FR), to=obj(DS)
  //   ds:  DS → Task   ds 字段存于 Task 对象 → 反向 from=target(DS), to=obj(Task)
  //   depends: DS→DS / Task→Task  depends 字段存于 DS/Task → 自然方向
  // reversed=true 表示引用字段存于目标侧对象，需要把 from/to 对调。
  const REL_FIELDS = [
    { field: "acs", type: "acs", reversed: false },
    { field: "fr", type: "fr", reversed: true },
    { field: "ds", type: "ds", reversed: true },
    { field: "depends", type: "depends", reversed: false },
  ];

  const edges = [];
  const seen = new Set(); // from|to|type 去重，重复关系只产一条 Edge

  for (const obj of view.values()) {
    for (const rel of REL_FIELDS) {
      const refs = obj.refs?.[rel.field];
      if (!Array.isArray(refs) || refs.length === 0) continue;
      for (const raw of refs) {
        // 跨模块引用继续使用 resolveObjectRef() 解析为稳定 Key（module/object-id）
        const target = resolveObjectRef(raw, obj.module);
        const fromKey = rel.reversed ? target.key : obj.key;
        const toKey = rel.reversed ? obj.key : target.key;
        const sig = `${fromKey}|${toKey}|${rel.type}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        edges.push({ from: fromKey, to: toKey, type: rel.type });
      }
    }
  }

  return { nodes, edges };
}

// ── Graph Validation（纯内存）────────────────────────────────────────

/**
 * 校验 Graph 中的悬空引用、depends 自依赖与依赖环。
 * 不修改 Graph，也不为悬空引用自动补 Node。
 *
 * Progressive 只改变 UNREFERENCED_AC 分类；其它 Graph hardening 保持原语义。
 * @param {{ nodes: Record<string, object>, edges: Array<{ from: string, to: string, type: string }>, coverage?: object, validationContext?: object }} graph
 * @returns {{ valid: boolean, errors: Array<object>, warnings: Array<object>, legacy_gaps: Array<object> }}
 */
export function validateGraph({ nodes, edges, coverage = { overall: "unknown", modules: {} }, validationContext = {} }) {
  const errors = [];
  const warnings = [];
  const legacy_gaps = [];

  for (const edge of edges) {
    if (!nodes[edge.from] || !nodes[edge.to]) {
      errors.push({
        code: "DANGLING_REFERENCE",
        from: edge.from,
        to: edge.to,
      });
    }

    if (edge.type === "depends" && edge.from === edge.to) {
      errors.push({
        code: "SELF_DEPENDENCY",
        from: edge.from,
        to: edge.to,
      });
    }
  }

  const acsTargets = new Set(
    edges
      .filter((edge) => edge.type === "acs")
      .map((edge) => edge.to),
  );
  const frToAcEvidence = validationContext.fr_to_ac || {};
  const baselineReferencedAcKeys = new Set(frToAcEvidence.baseline_referenced_ac_keys || []);
  const changeAddedAcKeys = new Set(frToAcEvidence.change_added_ac_keys || []);
  const changeOverwrittenAcKeys = new Set(frToAcEvidence.change_overwritten_ac_keys || []);
  for (const [key, node] of Object.entries(nodes)) {
    if (node.type !== "ac" || acsTargets.has(key)) continue;
    const moduleName = key.slice(0, key.lastIndexOf("/"));
    let reason = null;
    if (coverage.modules?.[moduleName] === "complete") reason = "complete_module";
    else if (baselineReferencedAcKeys.has(key)) reason = "baseline_reference_regression";
    else if (changeAddedAcKeys.has(key)) reason = "change_added_ac";
    else if (changeOverwrittenAcKeys.has(key)) reason = "change_overwritten_ac";

    const finding = {
      code: "UNREFERENCED_AC",
      from: null,
      to: key,
      source: node.source,
      message: `AC '${node.id}' 没有 FR 通过 acs: 引用`,
    };
    if (reason) {
      errors.push({ ...finding, reason });
    } else {
      legacy_gaps.push({
        code: "LEGACY_GAP",
        relation: "FR_TO_AC",
        from: null,
        to: key,
        source: node.source,
        message: `AC '${node.id}' 当前没有已知 FR 引用；模块 coverage 非 complete，按历史未迁移缺口处理`,
      });
    }
  }

  // 只在同类型的、非悬空 depends 子图中找长度至少为 2 的 SCC。
  function findDependencyCycles(type) {
    const adjacency = new Map();
    for (const edge of edges) {
      if (
        edge.type !== "depends" ||
        edge.from === edge.to ||
        !nodes[edge.from] ||
        !nodes[edge.to] ||
        nodes[edge.from].type !== type ||
        nodes[edge.to].type !== type
      ) {
        continue;
      }
      if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
      adjacency.get(edge.from).add(edge.to);
    }

    const indexByNode = new Map();
    const lowLink = new Map();
    const stack = [];
    const onStack = new Set();
    const components = [];
    let nextIndex = 0;

    function visit(node) {
      indexByNode.set(node, nextIndex);
      lowLink.set(node, nextIndex);
      nextIndex += 1;
      stack.push(node);
      onStack.add(node);

      for (const next of [...(adjacency.get(node) || [])].sort()) {
        if (!indexByNode.has(next)) {
          visit(next);
          lowLink.set(node, Math.min(lowLink.get(node), lowLink.get(next)));
        } else if (onStack.has(next)) {
          lowLink.set(node, Math.min(lowLink.get(node), indexByNode.get(next)));
        }
      }

      if (lowLink.get(node) !== indexByNode.get(node)) return;
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length >= 2) components.push(component.sort());
    }

    for (const node of [...adjacency.keys()].sort()) {
      if (!indexByNode.has(node)) visit(node);
    }

    return components.sort((a, b) => a[0].localeCompare(b[0])).map((component) => {
      const members = new Set(component);
      const start = component[0];

      function pathToStart(node, path, visited) {
        for (const next of [...(adjacency.get(node) || [])].sort()) {
          if (!members.has(next)) continue;
          if (next === start) return [...path, start];
          if (visited.has(next)) continue;
          visited.add(next);
          const result = pathToStart(next, [...path, next], visited);
          if (result) return result;
          visited.delete(next);
        }
        return null;
      }

      return pathToStart(start, [start], new Set([start]));
    });
  }

  const taskCycles = findDependencyCycles("task");
  const designCycles = findDependencyCycles("ds");
  for (const cycle of taskCycles) {
    errors.push({ code: "TASK_DEPENDENCY_CYCLE", cycle });
  }
  for (const cycle of designCycles) {
    warnings.push({ code: "DESIGN_DEPENDENCY_CYCLE", cycle });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    legacy_gaps,
  };
}

/**
 * 读取并校验持久化关系索引文档。
 * @param {{ indexPath: string }} options
 * @returns {Promise<object>}
 * @throws {RelationError} INDEX_NOT_FOUND | INVALID_INDEX
 */
async function readRelationshipIndexDocument({ indexPath }) {
  let content;
  try {
    content = await readFile(indexPath, "utf-8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new RelationError(
        "INDEX_NOT_FOUND",
        `关系索引文件不存在：${indexPath}`,
        { indexPath },
      );
    }
    throw error;
  }

  let document;
  try {
    document = JSON.parse(content);
  } catch (error) {
    throw new RelationError(
      "INVALID_INDEX",
      `关系索引 JSON 无法解析：${indexPath}`,
      { indexPath, parseError: error.message },
    );
  }

  if (
    document === null ||
    typeof document !== "object" ||
    document.nodes === null ||
    typeof document.nodes !== "object" ||
    Array.isArray(document.nodes) ||
    !Array.isArray(document.edges)
  ) {
    throw new RelationError(
      "INVALID_INDEX",
      `关系索引缺少有效的 nodes（对象）或 edges（数组）：${indexPath}`,
      { indexPath },
    );
  }

  if (document.schema_version === 2) {
    const coverage = document.coverage;
    const frToAc = document.validation_context?.fr_to_ac;
    const snapshotContext = document.snapshot_context;
    const moduleStatuses = coverage?.modules && typeof coverage.modules === "object" && !Array.isArray(coverage.modules)
      ? Object.values(coverage.modules)
      : [];
    const projectedOverall = moduleStatuses.some((status) => status !== "complete") ? "partial" : "complete";
    const validCoverage =
      coverage &&
      (coverage.overall === "partial" || coverage.overall === "complete") &&
      coverage.modules &&
      typeof coverage.modules === "object" &&
      !Array.isArray(coverage.modules) &&
      moduleStatuses.every((status) => status === "partial" || status === "complete") &&
      coverage.overall === projectedOverall;
    const validEvidence =
      frToAc &&
      Array.isArray(frToAc.baseline_referenced_ac_keys) &&
      Array.isArray(frToAc.change_added_ac_keys) &&
      Array.isArray(frToAc.change_overwritten_ac_keys);
    const validSnapshotContext =
      snapshotContext &&
      (snapshotContext.build_mode === "manual" || snapshotContext.build_mode === "node") &&
      (snapshotContext.node === null || typeof snapshotContext.node === "string");
    if (!validCoverage || !validEvidence || !validSnapshotContext) {
      throw new RelationError(
        "INVALID_INDEX",
        `Relationship Index v2 缺少有效的 coverage、validation_context 或 snapshot_context：${indexPath}`,
        { indexPath },
      );
    }
  }

  return document;
}

function relationshipSnapshotMetadata(document) {
  if (document.schema_version === 2) {
    const snapshotContext = document.snapshot_context;
    const transitionalLifecycleSnapshot =
      document.coverage.overall === "complete" &&
      snapshotContext.build_mode === "node" &&
      (snapshotContext.node === "xf-design" || snapshotContext.node === "xf-task");
    return {
      coverage: document.coverage,
      validationContext: document.validation_context,
      snapshotContext,
      resultSemantics:
        document.coverage.overall === "complete" && !transitionalLifecycleSnapshot
          ? "relationship_snapshot"
          : "known_graph_only",
      requiresRebuild: false,
    };
  }
  return {
    coverage: { overall: "unknown", modules: {} },
    validationContext: {},
    snapshotContext: { build_mode: "unknown", node: null },
    resultSemantics: "known_graph_only",
    requiresRebuild: true,
  };
}

function missingNodeError({ key, indexPath, snapshot }) {
  const outsideKnownGraph = snapshot.resultSemantics === "known_graph_only";
  return new RelationError(
    outsideKnownGraph ? "NODE_OUTSIDE_KNOWN_GRAPH" : "NODE_NOT_FOUND",
    outsideKnownGraph
      ? `当前已知 Relationship Graph 未覆盖或未记录 Node：${key}`
      : `关系索引中不存在 Node：${key}`,
    {
      key,
      indexPath,
      coverage: snapshot.coverage,
      result_semantics: snapshot.resultSemantics,
      snapshot_context: snapshot.snapshotContext,
    },
  );
}

/**
 * 读取并校验已有的持久化关系索引。
 * 只取索引文档中的 nodes / edges 交给 validateGraph，不重新构建或写回文件。
 *
 * @param {{ indexPath: string }} options
 * @returns {Promise<{ valid: boolean, errors: Array<object>, warnings: Array<object> }>}
 * @throws {RelationError} INDEX_NOT_FOUND | INVALID_INDEX
 */
export async function validateRelationshipIndex({ indexPath }) {
  const document = await readRelationshipIndexDocument({ indexPath });
  const snapshot = relationshipSnapshotMetadata(document);
  return {
    ...validateGraph({
      nodes: document.nodes,
      edges: document.edges,
      coverage: snapshot.coverage,
      validationContext: snapshot.validationContext,
    }),
    coverage: snapshot.coverage,
    result_semantics: snapshot.resultSemantics,
    snapshot_context: snapshot.snapshotContext,
    requires_rebuild: snapshot.requiresRebuild,
  };
}

/**
 * 查询索引中某个 Node 的直接关系。
 * 只读取已有索引，不构建或修改索引。
 *
 * @param {{ indexPath: string, key: string }} options
 * @returns {Promise<{ focus: object, incoming_edges: Array<object>, outgoing_edges: Array<object>, related_nodes: object }>}
 * @throws {RelationError} INDEX_NOT_FOUND | INVALID_INDEX | NODE_OUTSIDE_KNOWN_GRAPH | NODE_NOT_FOUND
 */
export async function queryRelationshipIndex({ indexPath, key }) {
  const document = await readRelationshipIndexDocument({ indexPath });
  const snapshot = relationshipSnapshotMetadata(document);
  const node = document.nodes[key];
  if (!node) {
    throw missingNodeError({ key, indexPath, snapshot });
  }

  const incoming_edges = document.edges.filter((edge) => edge.to === key);
  const outgoing_edges = document.edges.filter((edge) => edge.from === key);
  const relatedKeys = new Set();
  for (const edge of [...incoming_edges, ...outgoing_edges]) {
    const relatedKey = edge.from === key ? edge.to : edge.from;
    if (relatedKey !== key) relatedKeys.add(relatedKey);
  }

  const related_nodes = {};
  for (const relatedKey of relatedKeys) {
    const relatedNode = document.nodes[relatedKey];
    if (!relatedNode) continue;
    const result = { type: relatedNode.type, source: relatedNode.source };
    if (Object.hasOwn(relatedNode, "data")) result.data = relatedNode.data;
    related_nodes[relatedKey] = result;
  }

  return {
    focus: { key, ...node },
    incoming_edges,
    outgoing_edges,
    related_nodes,
    coverage: snapshot.coverage,
    result_semantics: snapshot.resultSemantics,
    snapshot_context: snapshot.snapshotContext,
  };
}

/**
 * 按层双向扩散查询索引中指定 Node 的影响范围。
 * 只读取已有索引，不构建或修改索引。
 *
 * @param {{ indexPath: string, key: string, depth?: number }} options
 * @returns {Promise<{ focus: string, levels: Array<{ depth: number, nodes: Array<{ key: string, type: string, source: { file: string, anchor: string } }> }> }>}
 * @throws {RelationError} INVALID_DEPTH | INDEX_NOT_FOUND | INVALID_INDEX | NODE_OUTSIDE_KNOWN_GRAPH | NODE_NOT_FOUND
 */
export async function impactRelationshipIndex({ indexPath, key, depth = 1 }) {
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1) {
    throw new RelationError(
      "INVALID_DEPTH",
      `影响范围查询深度必须是正整数：${depth}`,
      { depth },
    );
  }

  const document = await readRelationshipIndexDocument({ indexPath });
  const snapshot = relationshipSnapshotMetadata(document);
  if (!document.nodes[key]) {
    throw missingNodeError({ key, indexPath, snapshot });
  }

  const levels = [];
  const visited = new Set([key]);
  let currentLevel = [key];

  for (let currentDepth = 1; currentDepth <= depth; currentDepth += 1) {
    const nextKeys = new Set();
    for (const currentKey of currentLevel) {
      for (const edge of document.edges) {
        let relatedKey;
        if (edge.from === currentKey) relatedKey = edge.to;
        else if (edge.to === currentKey) relatedKey = edge.from;
        else continue;

        if (visited.has(relatedKey) || !document.nodes[relatedKey]) continue;
        visited.add(relatedKey);
        nextKeys.add(relatedKey);
      }
    }

    if (nextKeys.size === 0) break;
    const nodes = [...nextKeys].map((relatedKey) => {
      const relatedNode = document.nodes[relatedKey];
      return {
        key: relatedKey,
        type: relatedNode.type,
        source: relatedNode.source,
      };
    });
    levels.push({ depth: currentDepth, nodes });
    currentLevel = [...nextKeys];
  }

  return {
    focus: key,
    levels,
    coverage: snapshot.coverage,
    result_semantics: snapshot.resultSemantics,
    snapshot_context: snapshot.snapshotContext,
  };
}

/**
 * 从当前 Effective View 全量构建并安全替换持久化关系索引。
 * @param {{ modulesDir: string, changesDir: string, flowId: string, outputPath: string, node?: string }} options
 * @returns {Promise<{ schema_version: 2, generated_at: string, coverage: object, validation_context: object, snapshot_context: object, nodes: object, edges: Array<object> }>}
 * @throws {RelationError} BUILD_FAILED
 */
export async function buildRelationshipIndex({ modulesDir, changesDir, flowId, outputPath, node }) {
  await assertDirectoryRoots(
    { modulesDir, changesDir },
    { code: "BUILD_FAILED", operation: "build" },
  );
  const effective = await buildEffectiveViewFromDirs({ modulesDir, changesDir, flowId });
  const graph = buildGraph(effective.view);
  const explicitRemovedKeys = new Set(effective.change?.explicitRemovedKeys || []);
  if (node === "xf-design" || node === "xf-task") {
    const transition = node === "xf-design"
      ? { type: "fr", removedType: "fr", downstreamType: "ds" }
      : { type: "ds", removedType: "ds", downstreamType: "task" };
    graph.edges = graph.edges.filter((edge) => {
      if (edge.type !== transition.type || !explicitRemovedKeys.has(edge.from)) return true;
      const downstream = graph.nodes[edge.to];
      return !(
        detectIdType(edge.from.slice(edge.from.lastIndexOf("/") + 1)) === transition.removedType &&
        downstream?.type === transition.downstreamType &&
        downstream.source?.file?.includes(`/modules/`)
      );
    });
  }
  const coverage = await loadCoverageProjection({ modulesDir, moduleNames: effective.moduleNames });
  const baselineReferencedAcKeys = new Set();
  for (const object of effective.baseline) {
    if (object.type !== "fr" || !Array.isArray(object.refs?.acs)) continue;
    for (const raw of object.refs.acs) {
      try {
        const target = resolveObjectRef(raw, object.module);
        if (target.type === "ac") baselineReferencedAcKeys.add(target.key);
      } catch (error) {
        // 无法形成稳定 AC key 的旧引用不是 baseline Relationship fact；
        // Current Effective View 若仍保留该非法引用，buildGraph 已按既有规则严格失败。
        if (!(error instanceof RelationError) || error.code !== "INVALID_REFERENCE") throw error;
      }
    }
  }
  const validation_context = {
    fr_to_ac: {
      baseline_referenced_ac_keys: [...baselineReferencedAcKeys].sort(),
      change_added_ac_keys: effective.stats.added.filter((key) => graph.nodes[key]?.type === "ac").sort(),
      change_overwritten_ac_keys: effective.stats.overwritten.filter((key) => graph.nodes[key]?.type === "ac").sort(),
    },
  };
  const snapshot_context = {
    build_mode: node ? "node" : "manual",
    node: node || null,
  };
  const validation = validateGraph({
    ...graph,
    coverage,
    validationContext: validation_context,
  });
  if (validation.errors.length > 0) {
    throw new RelationError(
      "BUILD_FAILED",
      "关系索引构建失败：Graph 校验未通过",
      { errors: validation.errors, legacy_gaps: validation.legacy_gaps },
    );
  }

  const document = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    coverage,
    validation_context,
    snapshot_context,
    nodes: graph.nodes,
    edges: graph.edges,
  };
  const outputDir = dirname(outputPath);
  await mkdir(outputDir, { recursive: true });
  const tempPath = `${outputPath}.tmp-${randomUUID()}`;
  try {
    await writeFile(tempPath, JSON.stringify(document, null, 2) + "\n", "utf-8");
    await rename(tempPath, outputPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }

  return document;
}

// ── CLI 入口（Engine 核心保持显式传参，不依赖运行时环境）──────────────

import {
  parseArgs,
  handleHelpFlag,
  assertAllowedArgs,
  printUsageAndExit,
  resolveFlowId,
  resolveSpecRoot,
  modulesDir,
  changesDir,
  archiveDir,
} from "./lib.mjs";

export const USAGE = {
  usage: "node xf-relations.mjs --action <build|validate|query|impact|next-id>",
  description: "构建、校验、查询关系索引，或只读分配历史安全的 FR/DS 编号。",
  required: { "--action <value>": "操作类型" },
  optional: {
    "--key <module/object-id>": "query / impact 的对象稳定 Key",
    "--depth <positive integer>": "impact 扩散深度，默认 1",
    "--node <nodeId>": "build 的生命周期节点；仅 design/task/implement/archive 执行",
    "--summary": "build 仅输出节点与边数量摘要",
    "--module <name>": "next-id 的模块名",
    "--type <fr|ds>": "next-id 的 Relationship identity 类型",
    "--flow <flowId>": "Group 模式指定 Flow（由 resolveFlowId 消费）",
  },
  values: { "--action": "build | validate | query | impact | next-id" },
  examples: [
    "node xf-relations.mjs --action build",
    "node xf-relations.mjs --action validate",
    "node xf-relations.mjs --action query --key todo-core/DS-001",
    "node xf-relations.mjs --action impact --key todo-core/FR-001 --depth 2",
    "node xf-relations.mjs --action next-id --module todo-core --type ds",
  ],
};

export const ALLOWED_ARGS = ["help", "action", "key", "depth", "node", "summary", "module", "type", "flow"];

const RELATION_BUILD_NODES = new Set(["xf-design", "xf-task", "xf-implement", "xf-archive"]);

export async function runRelationsCli(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  handleHelpFlag(args, USAGE);
  assertAllowedArgs(args, ALLOWED_ARGS, USAGE);
  const action = args.action;
  if (!action || !["build", "validate", "query", "impact", "next-id"].includes(action)) {
    printUsageAndExit(USAGE, "--action 必须为 build、validate、query、impact 或 next-id");
  }
  if ((action === "query" || action === "impact") && !args.key) {
    printUsageAndExit(USAGE, `${action} 操作必须提供 --key`);
  }
  if (action === "next-id" && (!args.module || !args.type)) {
    printUsageAndExit(USAGE, "next-id 操作必须提供 --module 与 --type");
  }
  if (action === "build" && args.node && !RELATION_BUILD_NODES.has(args.node)) return 0;

  const resolveFlowIdFn = deps.resolveFlowId || resolveFlowId;
  const resolveSpecRootFn = deps.resolveSpecRoot || resolveSpecRoot;
  const modulesDirFn = deps.modulesDir || modulesDir;
  const changesDirFn = deps.changesDir || changesDir;
  const archiveDirFn = deps.archiveDir || archiveDir;
  const buildFn = deps.buildRelationshipIndex || buildRelationshipIndex;
  const validateFn = deps.validateRelationshipIndex || validateRelationshipIndex;
  const queryFn = deps.queryRelationshipIndex || queryRelationshipIndex;
  const impactFn = deps.impactRelationshipIndex || impactRelationshipIndex;
  const nextIdFn = deps.nextRelationshipId || nextRelationshipId;

  try {
    const flowId = resolveFlowIdFn();
    const indexPath = action === "next-id" ? null : join(resolveSpecRootFn(flowId), "relationship-index.json");
    let result;
    if (action === "next-id") {
      result = await nextIdFn({
        modulesDir: modulesDirFn(flowId),
        changesDir: changesDirFn(flowId),
        archiveDir: archiveDirFn(flowId),
        module: args.module,
        type: args.type,
      });
    } else if (action === "build") {
      result = await buildFn({ modulesDir: modulesDirFn(flowId), changesDir: changesDirFn(flowId), flowId, outputPath: indexPath, node: args.node });
    } else if (action === "validate") {
      result = await validateFn({ indexPath });
    } else if (action === "query") {
      result = await queryFn({ indexPath, key: args.key });
    } else {
      result = await impactFn({ indexPath, key: args.key, depth: args.depth ? Number(args.depth) : 1 });
    }
    const output = action === "build" && (args.node || args.summary)
      ? { ok: true, nodes: Object.keys(result.nodes).length, edges: result.edges.length }
      : result;
    console.log(JSON.stringify(output));
    return action === "validate" && (result.errors.length > 0 || result.requires_rebuild === true) ? 1 : 0;
  } catch (error) {
    if (error instanceof RelationError) {
      console.error(`[xflow] Error: ${error.code}: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRelationsCli().then((code) => { if (code !== 0) process.exitCode = code; }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
