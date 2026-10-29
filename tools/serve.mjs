#!/usr/bin/env node
/**
 * Starts Next.js (`dev` or `start`) on the host and port set in .env.
 *
 *   OSIRIS_HOST  interface to listen on. Default 127.0.0.1: this machine only.
 *                Set 0.0.0.0 to open it to your network (see the warning below).
 *   OSIRIS_PORT  port. Default 3000.
 *
 * Next reads .env for the app itself, but not for its own CLI flags, so the two
 * values are read here. Order: the shell's environment, then .env.local, then .env.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const mode = process.argv[2];
if (mode !== 'dev' && mode !== 'start') {
  console.error('Usage: node tools/serve.mjs <dev|start> [extra next args]');
  process.exit(2);
}

/** KEY=value lines; comments, blanks and `export` prefixes ignored, surrounding quotes removed. */
function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

function readEnvFile(name) {
  try { return parseEnv(readFileSync(join(process.cwd(), name), 'utf8')); } catch { return {}; }
}

const fileEnv = { ...readEnvFile('.env'), ...readEnvFile('.env.local') };
const pick = (k, fallback) => (process.env[k] || fileEnv[k] || fallback).trim();

const host = pick('OSIRIS_HOST', '127.0.0.1');
const port = pick('OSIRIS_PORT', '3000');
if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  console.error(`OSIRIS_PORT must be a port number (1–65535), got "${port}".`);
  process.exit(2);
}

const open = host === '0.0.0.0' || host === '::';
console.log(`\n  OSIRIS → http://${open ? 'localhost' : host.includes(':') ? `[${host}]` : host}:${port}`);
if (open) {
  console.warn('  ⚠  OSIRIS_HOST is open to your whole network. Anyone who can reach this machine');
  console.warn('     can use the OI engine — including your local model, if OSIRIS_LOCAL_LLM_URL is set.\n');
} else {
  console.log('     Listening on this machine only (OSIRIS_HOST to change).\n');
}

const next = createRequire(import.meta.url).resolve('next/dist/bin/next');
const child = spawn(process.execPath, [next, mode, '-H', host, '-p', port, ...process.argv.slice(3)], { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
