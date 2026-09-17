#!/usr/bin/env node

/**
 * xf-profile.mjs — 读取项目级 project_profile
 *
 * 用途：
 *   所有 xflow 命令与脚本统一通过此脚本获取当前项目的 project_profile，
 *   避免各命令自行解析 constitution.md 导致格式漂移。
 *
 * 用法：
 *   node .xflow/scripts/xf-profile.mjs
 *   node .xflow/scripts/xf-profile.mjs --value-only   # 仅输出 profile 值（便于 shell 消费）
 *
 * 解析规则：
 *   从 xspec/constitution.md 扫描第一行匹配 `project_profile` 的条目：
 *     - `- project_profile: xxx`
 *     - `- **project_profile**: xxx`
 *     - `project_profile: xxx`
 *     - `| project_profile | xxx |` （表格格式）
 *   值支持可选引号；大小写敏感；空白自动 trim。
 *
 * 回退规则（按优先级）：
 *   1. xspec/constitution.md 存在且含 project_profile → 以宪章为准（SSOT）
 *   2. constitution 不存在或字段缺失 → 读 `.xflow/init.json` 的 `profiles.active`
 *   3. 以上均不可用 → general
 *
 * 已知 profile 白名单（仅用于提示，脚本不强制限制）：
 *   - general
 *   - xuanwu-activity
 *
 * 输出 JSON（默认）：
 *   { "profile": "general", "source": "default" }
 *   { "profile": "xuanwu-activity", "source": "xspec/constitution.md" }
 *   { "profile": "retail-checkout", "source": ".xflow/init.json" }
 *
 * 退出码:
 *   0 = 成功返回 profile（即使是 general 兜底）
 *   1 = 解析异常
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import {
  resolveFlowId,
  resolveSpecRoot,
  flowFrameworkRoot,
  output,
  fatal,
  parseArgs,
  printUsageAndExit,
  handleHelpFlag,
  assertAllowedArgs,
} from "./lib.mjs";

const DEFAULT_PROFILE = "general";
const KNOWN_PROFILES = new Set(["general", "xuanwu-activity"]);

const USAGE = {
  usage: "node .xflow/scripts/xf-profile.mjs [--value-only]",
  description:
    "读取当前项目的 project_profile。优先 xspec/constitution.md；宪章未就绪时\n" +
    "回退 .xflow/init.json 的 profiles.active。所有 xflow 命令统一通过此脚本获取 profile。",
  required: {},
  optional: {
    "--value-only": "仅输出 profile 值（便于 shell 内消费，例如 $(node ... --value-only)）",
    "--help, -h": "打印本帮助并退出",
  },
  examples: [
    "node .xflow/scripts/xf-profile.mjs",
    "node .xflow/scripts/xf-profile.mjs --value-only",
  ],
  notes: [
    "constitution.md 存在且含 project_profile 时以宪章为准（SSOT）",
    "constitution 不存在 / 字段缺失 / 值为空时回退 .xflow/init.json 的 profiles.active",
    "以上均不可用时回退 general",
    `已知 profile 白名单：${[...KNOWN_PROFILES].join(", ")}（不在白名单的值会按 general 流程执行）`,
  ],
};

const ALLOWED_ARGS = ["help", "value-only"];

/**
 * 从 constitution.md 内容中提取 project_profile 字段。
 * 返回匹配到的值，未匹配返回 null。
 */
export function extractProfile(content) {
  if (!content) return null;

  const patterns = [
    /^\s*-\s*\*\*project_profile\*\*\s*[:：]\s*["']?([A-Za-z0-9_-]+)["']?/m,
    /^\s*-\s*`?project_profile`?\s*[:：]\s*["']?([A-Za-z0-9_-]+)["']?/m,
    /^\s*project_profile\s*[:：]\s*["']?([A-Za-z0-9_-]+)["']?/m,
    /^\s*\|\s*`?project_profile`?\s*\|\s*["']?([A-Za-z0-9_-]+)["']?\s*\|/m,
  ];

  for (const re of patterns) {
    const match = content.match(re);
    if (match && match[1]) {
      const val = match[1].trim();
      if (val.length > 0) return val;
    }
  }
  return null;
}

/**
 * 从 init.json 内容中提取 profiles.active。
 * 返回匹配到的值，未匹配返回 null。
 */
export function extractProfileFromInitJson(content) {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    const active = parsed?.profiles?.active;
    if (typeof active === "string") {
      const val = active.trim();
      if (val.length > 0) return val;
    }
  } catch {
    // 非法 JSON 视为无 profile
  }
  return null;
}

export async function readInitJsonProfile() {
  const flowId = resolveFlowId();
  const initJsonPath = join(flowFrameworkRoot(flowId), "init.json");
  if (!existsSync(initJsonPath)) return null;
  try {
    const raw = await readFile(initJsonPath, "utf-8");
    return extractProfileFromInitJson(raw);
  } catch {
    return null;
  }
}

function attachUnknownWarning(result) {
  if (!KNOWN_PROFILES.has(result.profile)) {
    result.warning = `未知 profile "${result.profile}"；已知列表：${[...KNOWN_PROFILES].join(", ")}。命令会按 general 流程执行，但 .xflow/profiles/${result.profile}/ 目录若存在仍会被加载。`;
  }
  return result;
}

export async function resolveProfile() {
  const flowId = resolveFlowId();
  const constitutionPath = join(resolveSpecRoot(flowId), "constitution.md");
  const initJsonPath = join(flowFrameworkRoot(flowId), "init.json");

  if (existsSync(constitutionPath)) {
    let content;
    try {
      content = await readFile(constitutionPath, "utf-8");
    } catch (err) {
      const fromInit = await readInitJsonProfile();
      if (fromInit) {
        return attachUnknownWarning({ profile: fromInit, source: ".xflow/init.json" });
      }
      return { profile: DEFAULT_PROFILE, source: "default", reason: `读取失败: ${err.message}` };
    }

    const value = extractProfile(content);
    if (value) {
      return attachUnknownWarning({ profile: value, source: "xspec/constitution.md" });
    }
    // 宪章存在但字段缺失 → 回退 init.json
  }

  const fromInit = await readInitJsonProfile();
  if (fromInit) {
    return attachUnknownWarning({ profile: fromInit, source: ".xflow/init.json" });
  }

  if (!existsSync(constitutionPath)) {
    return { profile: DEFAULT_PROFILE, source: "default", reason: "constitution.md 不存在" };
  }
  return { profile: DEFAULT_PROFILE, source: "default", reason: "project_profile 字段缺失" };
}

async function main() {
  const args = parseArgs();
  handleHelpFlag(args, USAGE);
  assertAllowedArgs(args, ALLOWED_ARGS, USAGE);

  let result;
  try {
    result = await resolveProfile();
  } catch (err) {
    fatal(`解析 project_profile 失败: ${err.message}`);
  }

  if (args["value-only"]) {
    console.log(result.profile);
    return;
  }
  output(result);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => fatal(err.message));
}
