import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '.env'), quiet: true });

const env = process.env;

// Bump when the server changes; shown on /health so you can tell which PCs are up to date.
export const SERVER_VERSION = '2026-10-25a';

export const config = {
  port: Number(env.PORT) || 8787,
  // Address to listen on. PCs: 0.0.0.0 (reached through tailscale serve). Phone (Termux): 127.0.0.1,
  // so only apps on the phone itself can reach it.
  bind: env.JARVIS_BIND || '0.0.0.0',
  name: env.JARVIS_NAME || os.hostname(),
  token: env.JARVIS_TOKEN || '',
  // Empty = let the CLI pick its default. Recommended: "haiku" (fastest) or "sonnet".
  model: env.JARVIS_MODEL || 'haiku',
  // Minimum 6 s: older .env files say 5000, which proved too tight for role-play answers.
  timeoutMs: Math.max(Number(env.JARVIS_TIMEOUT_MS) || 7000, 6000),
  language: (env.JARVIS_LANGUAGE || 'en').toLowerCase(),
  logText: env.JARVIS_LOG_TEXT === '1',
  // Web search for live info (weather, scores, news). Runs on Anthropic's side; it cannot touch this PC.
  webSearch: env.JARVIS_WEB_SEARCH !== '0',
  // Optional: your city, so "what's the weather" knows where you are. e.g. "Montreal, Quebec, Canada"
  location: (env.JARVIS_LOCATION || '').trim(),
  // PC actions: let Jarvis really use this computer (open apps, websites, files).
  //   off  = chat only (plus web search)
  //   auto = Claude Code tools in auto mode: a safety classifier approves or blocks each action,
  //          and anything it can't approve is refused (nobody is at the PC to click "allow").
  actions: env.JARVIS_ACTIONS === 'auto' ? 'auto' : 'off',
  idleResetMs: 10 * 60 * 1000,
  healthCacheMs: 30 * 1000,
  logFile: path.join(here, 'jarvis.log'),
  // Empty, isolated working dir so no CLAUDE.md / project settings get picked up.
  sandboxDir: path.join(here, '.sandbox'),
  // Path to claude.exe / claude. Empty = the SDK's own copy, or "claude" on PATH for auth checks.
  claudePath: env.JARVIS_CLAUDE_PATH || '',
};

/** Override settings at runtime (the tray app passes its saved settings here before starting). */
export function applyConfig(values) {
  for (const [k, v] of Object.entries(values || {})) if (v !== undefined) config[k] = v;
  config.actions = config.actions === 'auto' ? 'auto' : 'off';
  config.timeoutMs = Math.max(Number(config.timeoutMs) || 7000, 6000);
}
