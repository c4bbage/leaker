/**
 * lib-lock.mjs — 文件锁 + 原子写（移植自 oh-my-openagent team-core/locks.ts）
 *
 * 用于归档串行化：xspec/modules/.archive.lock
 * 设计：wx 创建锁文件 → 写入 owner/pid/timestamp → 超时与死进程检测后 reap。
 */

import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, unlink, access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const LOCK_RETRY_MS = 50;
const LOCK_WAIT_TIMEOUT_MS = 15_000;
const LOCK_RELEASE_RETRY_ATTEMPTS = 3;
const LOCK_RELEASE_RETRY_MS = 25;
const DEFAULT_STALE_AFTER_MS = 300_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildOwnerContent(ownerTag) {
  return `${ownerTag}\n${process.pid}\n${Date.now()}\n`;
}

function parseOwnerContent(content) {
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length !== 3) return null;
  const ownerPid = Number.parseInt(lines[1] ?? "", 10);
  const acquiredAtEpochMs = Number.parseInt(lines[2] ?? "", 10);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return null;
  if (!Number.isInteger(acquiredAtEpochMs) || acquiredAtEpochMs <= 0) return null;
  return { ownerPid, acquiredAtEpochMs };
}

function errorCode(error) {
  if (!(error instanceof Error) || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function isPathAbsenceError(error) {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function isRetryableLockReleaseError(error) {
  const code = errorCode(error);
  return code === "EPERM" || code === "EBUSY";
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

async function pathMayExist(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return !isPathAbsenceError(error);
  }
}

async function assertRetryableLockOpenError(lockPath, error) {
  const code = errorCode(error);
  if (code === "EEXIST") return;
  if (code === "EPERM") {
    if (await pathMayExist(lockPath)) return;
    if (process.platform === "win32" && (await pathMayExist(dirname(lockPath)))) return;
  }
  throw error;
}

export async function detectStaleLock(lockPath, staleAfterMs) {
  try {
    const content = await readFile(lockPath, "utf8");
    const parsed = parseOwnerContent(content);
    if (parsed === null) return false;
    if (isPidAlive(parsed.ownerPid)) return false;
    return Date.now() - parsed.acquiredAtEpochMs > staleAfterMs;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

export async function reapStaleLock(lockPath) {
  for (let attempt = 1; attempt <= LOCK_RELEASE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await unlink(lockPath);
      return;
    } catch (error) {
      if (!(error instanceof Error)) return;
      if (isPathAbsenceError(error)) return;
      if (!isRetryableLockReleaseError(error) || attempt === LOCK_RELEASE_RETRY_ATTEMPTS) return;
      await delay(LOCK_RELEASE_RETRY_MS);
    }
  }
}

async function acquireLock(lockPath, ownerTag, staleAfterMs) {
  await mkdir(dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > LOCK_WAIT_TIMEOUT_MS) {
      throw new Error(`Timed out acquiring lock: ${lockPath}`);
    }
    try {
      const fileHandle = await open(lockPath, "wx");
      try {
        await fileHandle.writeFile(buildOwnerContent(ownerTag));
      } finally {
        await fileHandle.close();
      }
      return;
    } catch (error) {
      await assertRetryableLockOpenError(lockPath, error);
      if (await detectStaleLock(lockPath, staleAfterMs)) {
        await reapStaleLock(lockPath);
        continue;
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

/**
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>} fn
 * @param {{ staleAfterMs?: number, ownerTag?: string }} [opts]
 * @returns {Promise<T>}
 */
export async function withLock(lockPath, fn, opts = {}) {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const ownerTag = opts.ownerTag ?? "xflow";
  await acquireLock(lockPath, ownerTag, staleAfterMs);
  try {
    return await fn();
  } finally {
    await reapStaleLock(lockPath);
  }
}

/**
 * 原子写：tmp → rename
 * @param {string} filePath
 * @param {string|Buffer} content
 */
export async function atomicWrite(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${randomUUID()}`;
  try {
    const fileHandle = await open(tmpPath, "wx");
    try {
      await fileHandle.writeFile(content);
    } finally {
      await fileHandle.close();
    }
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}
