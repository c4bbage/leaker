#!/usr/bin/env node

/**
 * xf-deps — 任务依赖关系查询工具
 *
 * 解析 task.md 中的 depends 标注，构建依赖图，支持三种查询模式。
 * 严格限定在 xspec/ 目录内扫描，绝不触碰源代码或其他目录。
 *
 * Usage:
 *   node .xflow/scripts/xf-deps.mjs --task T020                 # 查某个任务的上下游
 *   node .xflow/scripts/xf-deps.mjs --task T020 --module user-auth  # 指定模块中的任务
 *   node .xflow/scripts/xf-deps.mjs --feature "用户认证"           # 查某功能组的依赖
 *   node .xflow/scripts/xf-deps.mjs --module user-auth           # 查模块的跨模块依赖
 *   node .xflow/scripts/xf-deps.mjs --archived                   # 从 modules/ 而非 changes/ 扫描
 */

import { readFile } from "fs/promises";
import { join, resolve, dirname } from "path";
import {
  resolveFlowId,
  resolveSpecRoot,
  changesDir,
  modulesDir,
  listDirs,
  exists,
  parseArgs,
  fatal,
  printUsageAndExit,
  handleHelpFlag,
  assertAllowedArgs,
} from "./lib.mjs";

const ALLOWED_ARGS = ["help", "task", "feature", "module", "archived"];

const USAGE = {
  usage:
    "node .xflow/scripts/xf-deps.mjs (--task <id> [--module <name>] | --feature <q> | --module <name>) [--archived]",
  description:
    "解析 task.md 里的 depends 标注，构建依赖图。三种查询模式互斥（必须三选一）。\n" +
    "扫描严格限定在 xspec/ 目录内，不会触碰源代码。",
  required: {
    "--task <id>": "[模式 1] 查某个任务的上下游（如 T020），可配 --module 消歧",
    "--feature <q>": "[模式 2] 按功能组名查依赖（子串匹配，跨模块）",
    "--module <name>": "[模式 3] 查模块的全部跨模块依赖（出站 + 入站）",
  },
  optional: {
    "--module <name>": "（模式 1 配套）当任务 ID 在多个模块都存在时用于消歧",
    "--archived": "从 xspec/modules/ 而非 xspec/changes/ 扫描（查归档后的依赖）",
    "--help, -h": "打印本帮助并退出",
  },
  examples: [
    "node .xflow/scripts/xf-deps.mjs --module user-auth",
    "node .xflow/scripts/xf-deps.mjs --task T020 --module user-auth",
    'node .xflow/scripts/xf-deps.mjs --feature "用户认证"',
    "node .xflow/scripts/xf-deps.mjs --module user-auth --archived",
  ],
  notes: [
    "三种模式互斥：--task / --feature / --module 必须且只能选一",
    "未传任何查询参数时直接报错并打印本帮助",
  ],
};

// ---------------------------------------------------------------------------
// Global safety: force exit after 10s to prevent any possibility of hanging
// Only active when running as CLI (not when imported for testing)
// ---------------------------------------------------------------------------

export const TIMEOUT_MS = 10_000;
export const MAX_LINES_PER_FILE = 5000;

const _isCLI =
  process.argv[1] &&
  (process.argv[1].endsWith("xf-deps.mjs") ||
    process.argv[1].endsWith("xf-deps"));

let _safetyTimer = null;
if (_isCLI) {
  _safetyTimer = setTimeout(() => {
    console.error("[xf-deps] 超时退出（10s），可能存在异常");
    process.exit(1);
  }, TIMEOUT_MS);
  _safetyTimer.unref();
}

// ---------------------------------------------------------------------------
// Path safety: ensure we never scan outside xspec/
// ---------------------------------------------------------------------------

function assertInsideSpec(p, flowId) {
  const resolved = resolve(p);
  if (!resolved.startsWith(resolve(resolveSpecRoot(flowId)))) {
    fatal(`路径安全检查失败：${p} 不在 xspec/ 目录内`);
  }
}

// ---------------------------------------------------------------------------
// Parse a single task.md file into structured data
// ---------------------------------------------------------------------------

export const TASK_RE = /^- \[[ x]\] (T\d{3})\s+(.*)$/;
export const DEPENDS_RE = /^\s{2}depends:\s*(.+)$/;

export function parseTaskFile(content, moduleName) {
  const tasks = [];
  let currentFeature = null;
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  if (lines.length > MAX_LINES_PER_FILE) {
    console.warn(
      `⚠️  ${moduleName}/task.md 超过 ${MAX_LINES_PER_FILE} 行，截断处理`,
    );
    lines.length = MAX_LINES_PER_FILE;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const featureMatch = line.match(/^###\s+(.+)/);
    if (featureMatch) {
      currentFeature = featureMatch[1].trim();
      continue;
    }

    const taskMatch = line.match(TASK_RE);
    if (taskMatch) {
      const [, id, rest] = taskMatch;
      const done = line.includes("[x]");
      let depends = [];

      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        const depMatch = nextLine.match(DEPENDS_RE);
        if (depMatch) {
          depends = depMatch[1]
            .split(",")
            .map((d) => d.trim())
            .filter(Boolean);
        }
      }

      tasks.push({
        id,
        module: moduleName,
        description: rest.replace(/\[P\]\s*/, "").trim(),
        done,
        feature: currentFeature,
        depends,
      });
    }
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Scan all task.md files from either changes/ or modules/
// ---------------------------------------------------------------------------

async function loadAllTasks(useArchived) {
  const flowId = resolveFlowId();
  const baseDir = useArchived ? modulesDir(flowId) : changesDir(flowId);
  assertInsideSpec(baseDir, flowId);

  if (!exists(baseDir)) {
    fatal(`目录不存在：${baseDir}`);
  }

  const moduleDirs = await listDirs(baseDir);
  const allTasks = [];

  for (const mod of moduleDirs) {
    const taskPath = join(baseDir, mod, "task.md");
    assertInsideSpec(taskPath, flowId);
    if (!exists(taskPath)) continue;

    try {
      const content = await readFile(taskPath, "utf-8");
      const tasks = parseTaskFile(content, mod);
      allTasks.push(...tasks);
    } catch (err) {
      console.warn(`⚠️  解析 ${mod}/task.md 失败：${err.message}`);
    }
  }

  if (allTasks.length === 0) {
    fatal("未找到任何任务。请确认 task.md 文件已生成。");
  }

  return allTasks;
}

// ---------------------------------------------------------------------------
// Build dependency graph
// ---------------------------------------------------------------------------

export function buildGraph(allTasks) {
  const taskMap = new Map();
  for (const t of allTasks) {
    const key = `${t.id}@${t.module}`;
    taskMap.set(key, t);
  }

  const forward = new Map();
  const reverse = new Map();

  for (const t of allTasks) {
    const selfKey = `${t.id}@${t.module}`;

    for (const dep of t.depends) {
      let depKey;
      if (dep.includes("@")) {
        depKey = dep;
      } else {
        depKey = `${dep}@${t.module}`;
      }

      if (!forward.has(selfKey)) forward.set(selfKey, []);
      forward.get(selfKey).push(depKey);

      if (!reverse.has(depKey)) reverse.set(depKey, []);
      reverse.get(depKey).push(selfKey);
    }
  }

  return { taskMap, forward, reverse };
}

// ---------------------------------------------------------------------------
// Resolve a dep reference like "T020" or "T020@user-auth"
// ---------------------------------------------------------------------------

export function resolveRef(ref, defaultModule) {
  if (ref.includes("@")) return ref;
  return `${ref}@${defaultModule}`;
}

// ---------------------------------------------------------------------------
// Query: --task T020 [--module xxx]
// ---------------------------------------------------------------------------

function queryTask(taskId, moduleName, graph) {
  const { taskMap, forward, reverse } = graph;

  let key;
  if (moduleName) {
    key = `${taskId}@${moduleName}`;
  } else {
    const candidates = [...taskMap.keys()].filter((k) =>
      k.startsWith(`${taskId}@`),
    );
    if (candidates.length === 0) fatal(`任务 ${taskId} 未找到`);
    if (candidates.length > 1) {
      console.log(`⚠️  ${taskId} 存在于多个模块中：`);
      candidates.forEach((c) => console.log(`   ${c}`));
      fatal("请通过 --module 指定模块");
    }
    key = candidates[0];
  }

  const task = taskMap.get(key);
  if (!task) fatal(`任务 ${key} 未找到`);

  const deps = forward.get(key) || [];
  const dependedBy = reverse.get(key) || [];

  console.log(`\n📌 ${key}`);
  console.log(`   ${task.description}`);
  if (task.feature) console.log(`   功能组：${task.feature}`);
  console.log(`   状态：${task.done ? "✅ 已完成" : "⬜ 未完成"}`);

  if (deps.length > 0) {
    console.log(`\n   → 依赖（我需要等）：`);
    for (const d of deps) {
      const dt = taskMap.get(d);
      const desc = dt ? dt.description : "⚠️ 目标任务不存在";
      const cross = d.split("@")[1] !== task.module ? " [跨模块]" : "";
      console.log(`     ${d}${cross} — ${desc}`);
    }
  }

  if (dependedBy.length > 0) {
    console.log(`\n   ← 被依赖（等我完成）：`);
    for (const d of dependedBy) {
      const dt = taskMap.get(d);
      const desc = dt ? dt.description : "?";
      const cross = d.split("@")[1] !== task.module ? " [跨模块]" : "";
      console.log(`     ${d}${cross} — ${desc}`);
    }
  }

  if (deps.length === 0 && dependedBy.length === 0) {
    console.log(`\n   无依赖关系`);
  }

  console.log();
}

// ---------------------------------------------------------------------------
// Query: --feature "用户认证"
// ---------------------------------------------------------------------------

function queryFeature(featureQuery, graph) {
  const { taskMap, forward, reverse } = graph;

  const matchingTasks = [...taskMap.values()].filter(
    (t) => t.feature && t.feature.includes(featureQuery),
  );

  if (matchingTasks.length === 0) {
    fatal(`未找到包含「${featureQuery}」的功能组`);
  }

  const features = [...new Set(matchingTasks.map((t) => t.feature))];
  const internalKeys = new Set(matchingTasks.map((t) => `${t.id}@${t.module}`));

  console.log(`\n🔍 功能组查询：「${featureQuery}」`);
  console.log(`   匹配：${features.join("、")}`);
  console.log(`   包含 ${matchingTasks.length} 个任务\n`);

  for (const t of matchingTasks) {
    const key = `${t.id}@${t.module}`;
    const status = t.done ? "✅" : "⬜";
    console.log(`   ${status} ${key} — ${t.description}`);

    const deps = forward.get(key) || [];
    for (const d of deps) {
      const isExternal = !internalKeys.has(d);
      const dt = taskMap.get(d);
      const desc = dt ? dt.description : "⚠️ 目标不存在";
      if (isExternal) {
        console.log(`      → ${d} [外部依赖] — ${desc}`);
      } else {
        console.log(`      → ${d} — ${desc}`);
      }
    }

    const dependedBy = reverse.get(key) || [];
    for (const d of dependedBy) {
      const isExternal = !internalKeys.has(d);
      if (isExternal) {
        const dt = taskMap.get(d);
        const desc = dt ? dt.description : "?";
        console.log(`      ← ${d} [被外部依赖] — ${desc}`);
      }
    }
  }

  console.log();
}

// ---------------------------------------------------------------------------
// Query: --module user-auth (cross-module deps only)
// ---------------------------------------------------------------------------

function queryModule(moduleName, graph) {
  const { taskMap, forward, reverse } = graph;

  const moduleTasks = [...taskMap.values()].filter(
    (t) => t.module === moduleName,
  );

  if (moduleTasks.length === 0) {
    fatal(`模块 ${moduleName} 中没有任务`);
  }

  const outgoing = [];
  const incoming = [];

  for (const t of moduleTasks) {
    const key = `${t.id}@${t.module}`;

    const deps = forward.get(key) || [];
    for (const d of deps) {
      if (d.split("@")[1] !== moduleName) {
        outgoing.push({ from: key, to: d, fromDesc: t.description });
      }
    }

    const dependedBy = reverse.get(key) || [];
    for (const d of dependedBy) {
      if (d.split("@")[1] !== moduleName) {
        incoming.push({ from: d, to: key, toDesc: t.description });
      }
    }
  }

  console.log(`\n📦 模块：${moduleName}（${moduleTasks.length} 个任务）`);

  if (outgoing.length > 0) {
    console.log(`\n   → 出站依赖（本模块依赖其他模块）：`);
    for (const o of outgoing) {
      const dt = taskMap.get(o.to);
      const desc = dt ? dt.description : "⚠️ 目标不存在";
      console.log(`     ${o.from} → ${o.to} — ${desc}`);
    }
  }

  if (incoming.length > 0) {
    console.log(`\n   ← 入站依赖（其他模块依赖本模块）：`);
    for (const i of incoming) {
      const dt = taskMap.get(i.from);
      const desc = dt ? dt.description : "?";
      console.log(`     ${i.from} → ${i.to} — ${desc}`);
    }
  }

  if (outgoing.length === 0 && incoming.length === 0) {
    console.log(`\n   无跨模块依赖`);
  }

  console.log(`\n   合计：${outgoing.length} 出站 / ${incoming.length} 入站\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  handleHelpFlag(args, USAGE);
  assertAllowedArgs(args, ALLOWED_ARGS, USAGE);

  const useArchived = Boolean(args.archived);

  // 模式互斥校验：--task / --feature / --module 三选一（前两者非空才算激活）
  // 注意：--task 配 --module 是合法组合（用于消歧），所以单独看 --task 是否提供
  const modeFlags = [
    args.task ? "--task" : null,
    args.feature ? "--feature" : null,
    // --module 单独使用时是模式 3；与 --task 同用时是消歧参数；这里只在没有 --task 时才计入模式判定
    !args.task && args.module ? "--module" : null,
  ].filter(Boolean);

  if (modeFlags.length === 0) {
    printUsageAndExit(USAGE, "缺少查询参数：必须提供 --task / --feature / --module 之一");
  }
  if (modeFlags.length > 1) {
    printUsageAndExit(
      USAGE,
      `查询模式互斥，但同时检测到：${modeFlags.join(" + ")}。请只保留其中一个`,
    );
  }

  const allTasks = await loadAllTasks(useArchived);
  const graph = buildGraph(allTasks);

  if (args.task) {
    queryTask(args.task, args.module || null, graph);
  } else if (args.feature) {
    queryFeature(args.feature, graph);
  } else if (args.module) {
    queryModule(args.module, graph);
  }

  if (_safetyTimer) clearTimeout(_safetyTimer);
}

if (_isCLI) {
  main().catch((err) => fatal(err.message));
}
