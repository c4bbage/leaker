#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ID_PATTERN = /^CHG-\d{8}-001-[0-9A-F]{4}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function assertText(name, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (name !== "projectId" && /\s/.test(value)) {
    throw new TypeError(`${name} must not contain whitespace`);
  }
}

function assertTimestamp(timestamp) {
  if (typeof timestamp !== "string" || !ISO_TIMESTAMP_PATTERN.test(timestamp)) {
    throw new TypeError("timestamp must be an ISO timestamp with millisecond precision");
  }
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new TypeError("timestamp must be a valid ISO timestamp");
  }
}

function normalizeRandom(random) {
  if (random === undefined) return randomBytes(32);
  if (!Buffer.isBuffer(random) || random.length === 0) {
    throw new TypeError("random must be a non-empty Buffer");
  }
  return random;
}

/**
 * Generate a collision-resistant change ID without writing project files.
 * @param {{ projectId: string, timestamp: string, flow: string, random?: Buffer }} input
 * @returns {string}
 */
export function generateChangeId({ projectId, timestamp, flow, random } = {}) {
  assertText("projectId", projectId);
  assertTimestamp(timestamp);
  assertText("flow", flow);

  const entropy = normalizeRandom(random);
  const hashInput = [projectId, timestamp, flow, entropy.toString("hex")].join("\n");
  const hash = createHash("sha256").update(hashInput, "utf8").digest("hex").slice(0, 4).toUpperCase();
  const date = timestamp.slice(0, 10).replaceAll("-", "");
  const id = `CHG-${date}-001-${hash}`;

  if (!ID_PATTERN.test(id)) {
    throw new Error("generated change ID has an invalid format");
  }
  return id;
}

function parseFlowArg(argv) {
  const index = argv.indexOf("--flow");
  if (index === -1 || !argv[index + 1] || argv[index + 1].startsWith("--")) {
    throw new TypeError("--flow is required");
  }
  if (argv.length !== index + 2) {
    throw new TypeError("unexpected arguments");
  }
  return argv[index + 1];
}

function runCli(argv = process.argv.slice(2), cwd = process.cwd()) {
  const flow = parseFlowArg(argv);
  return {
    ok: true,
    id: generateChangeId({
      projectId: resolve(cwd),
      timestamp: new Date().toISOString(),
      flow,
    }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.stdout.write(`${JSON.stringify(runCli())}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}
