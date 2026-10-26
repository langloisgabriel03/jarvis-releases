// Thin wrapper around the Claude Agent SDK: chat (+ web search, + optional PC actions), subscription auth.
//
// Latency: spawning the Claude Code process costs ~1-2 s per call, so we keep ONE
// long-lived streaming session alive (pre-spawned, warm) and feed questions into it.
// We also remember its session id; if the process has to be killed (timeout, crash)
// the next question starts a new process with `resume: <sessionId>` so memory survives.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { buildPersona } from './persona.js';

// `tools: []` already removes every built-in tool. This deny list is belt-and-braces
// in case a future SDK version changes that default.
const ALL_TOOLS = [
  'Agent', 'Task', 'Bash', 'BashOutput', 'KillShell', 'Edit', 'MultiEdit', 'Write', 'Read',
  'NotebookEdit', 'NotebookRead', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite',
  'ExitPlanMode', 'EnterPlanMode', 'Skill', 'SlashCommand', 'ListMcpResourcesTool',
  'ReadMcpResourceTool', 'AskUserQuestion', 'Monitor', 'ToolSearch',
];

// The SDK child process must never see an API key, or it would bill API usage
// instead of the Claude subscription.
function childEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  // If the server was started from inside a Claude Code terminal, don't inherit that session.
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_REMOTE_SESSION_ID']) delete env[k];
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'jarvis-costume/1.0';
  return env;
}

export function checkApiKeyEnv() {
  if (process.env.ANTHROPIC_API_KEY) {
    const bar = '!'.repeat(72);
    console.warn(`\n${bar}\n!!  WARNING: ANTHROPIC_API_KEY is set in this environment.\n!!  Jarvis ignores it and strips it from the Claude call so you are billed\n!!  through your Claude subscription, not API credits.\n!!  Remove it from your user/system environment variables to be safe.\n${bar}\n`);
    delete process.env.ANTHROPIC_API_KEY;
  }
}

// ---------- verify before opening a guessed address ----------
// The model may "remember" a deep URL that points to the wrong thing (asked for the Avengers on
// Rotten Tomatoes, it opened a 1950 film). Code, not instructions, enforces the rule: a command
// that opens a specific page (a URL with a path or query) is refused unless Claude looked it up
// with WebSearch or WebFetch during this question. Home pages (https://youtube.com) and apps open
// directly.
const turn = { checkedWeb: false };

function guessedDeepLink(command) {
  for (const m of String(command || '').matchAll(/https?:\/\/[^\s"'`)]+/gi)) {
    try {
      const u = new URL(m[0]);
      if ((u.pathname && u.pathname !== '/') || u.search) return m[0];
    } catch {}
  }
  return null;
}

async function verifyBeforeOpening(input) {
  if (input?.hook_event_name !== 'PreToolUse' || turn.checkedWeb) return {};
  const url = guessedDeepLink(input.tool_input?.command);
  if (!url) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Not opened: ${url} is a guessed address. First use WebSearch (or WebFetch) to find the exact page sir means (right title, year, person, edition), then open the URL from the results. If several pages could match, pick the most likely one and mention it in one short sentence.`,
    },
  };
}

// Most turns one PC action may take (tool call, result, next call...). Keeps a confused run short.
const ACTION_MAX_TURNS = 10;

// Default (actions 'off'): the ONLY tool Jarvis may ever use is WebSearch (Anthropic-side search;
// it cannot read files, run commands or reach this PC's network). Everything else stays removed
// and denied. With actions 'auto', see actionOptions().
function sdkOptions(resume) {
  if (config.actions === 'auto') return actionOptions(resume);
  const ALLOWED_TOOLS = config.webSearch ? ['WebSearch'] : [];
  fs.mkdirSync(config.sandboxDir, { recursive: true });
  const opts = {
    systemPrompt: buildPersona({ actions: 'off', webSearch: config.webSearch }),
    tools: ALLOWED_TOOLS,         // no other built-in tools at all
    disallowedTools: ALL_TOOLS.filter((t) => !ALLOWED_TOOLS.includes(t)), // and deny them by name too
    allowedTools: ALLOWED_TOOLS,
    permissionMode: 'dontAsk',    // anything not pre-approved is denied, never prompted
    mcpServers: {},
    strictMcpConfig: true,        // ignore any MCP servers configured on this machine
    settingSources: [],           // no user/project/local settings, no CLAUDE.md
    cwd: config.sandboxDir,       // empty folder, nothing to read even in theory
    env: childEnv(),
    includePartialMessages: true, // stream words as they are written, so speech can start early
  };
  if (config.model) opts.model = config.model;
  // Less silent "thinking" before answering (it can take 5-15 s on odd questions).
  opts.effort = config.effort || 'low';
  if (config.claudePath) opts.pathToClaudeCodeExecutable = config.claudePath; // user's installed claude.exe
  if (resume) opts.resume = resume;
  return opts;
}

// PC actions: Claude Code tools in AUTO permission mode. Claude Code's safety classifier approves
// or blocks every tool call; a call it can't decide would normally ask the user, and since nobody
// is at the PC to click "allow", canUseTool refuses it.
function actionOptions(resume) {
  const opts = {
    systemPrompt: buildPersona({ actions: 'auto', webSearch: true }),
    tools: { type: 'preset', preset: 'claude_code' },
    disallowedTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'NotebookEdit', 'TodoWrite'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],           // no user/project settings or CLAUDE.md: same behaviour on every PC
    cwd: os.homedir(),
    env: childEnv(),
    includePartialMessages: true,
    maxTurns: ACTION_MAX_TURNS,
    hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [verifyBeforeOpening] }] },
  };
  if (config.model) opts.model = config.model;
  opts.effort = config.effort || 'low';
  if (config.claudePath) opts.pathToClaudeCodeExecutable = config.claudePath;
  if (resume) opts.resume = resume;
  return opts;
}


/** Short one-line text of a tool input / result, for traces and the log. */
function brief(v, max = 300) {
  let t = typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x?.text || '')).join(' ') : JSON.stringify(v ?? '');
  t = String(t).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function trace(p, event) {
  try { p.onTrace?.(event); } catch {}
}

function makeError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

/** One live Claude Code process fed through an async-iterable prompt. */
class LiveSession {
  constructor(resume) {
    this.sessionId = resume || null;
    this.inbox = [];          // user messages waiting to be read by the SDK
    this.waiting = null;      // resolver when the input generator is parked
    this.pending = null;      // { resolve, reject, text } for the in-flight question
    this.dead = false;
    const self = this;
    async function* input() {
      while (!self.dead) {
        if (!self.inbox.length) await new Promise((r) => { self.waiting = r; });
        self.waiting = null;
        if (self.dead) return;
        const msg = self.inbox.shift();
        if (msg) yield msg;
      }
    }
    this.q = query({ prompt: input(), options: sdkOptions(resume) });
    this.pump();
  }

  async pump() {
    try {
      for await (const msg of this.q) {
        if (msg.session_id) this.sessionId = msg.session_id;
        const p = this.pending;
        if (!p) continue;
        if (msg.type === 'stream_event') {
          const ev = msg.event;
          if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
            try { p.onTool?.(ev.content_block.name); } catch {}
          }
          if (ev?.type === 'content_block_start' && ev.content_block?.type === 'thinking') {
            try { p.onTool?.('thinking'); } catch {} // working, not stuck: not a timeout
          }
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            p.streamed = true;
            try { p.onDelta?.(ev.delta.text); } catch {}
          }
        } else if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
          const t = msg.message.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
          if (t.trim()) p.text = t;
          for (const b of msg.message.content) {
            if (b.type === 'tool_use') {
              if (b.name === 'WebSearch' || b.name === 'WebFetch') turn.checkedWeb = true;
              trace(p, { tool: b.name, input: brief(b.input) });
            }
          }
        } else if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
          // Tool results: report failures (e.g. a command that could not start an app).
          for (const b of msg.message.content) {
            if (b.type === 'tool_result' && b.is_error) trace(p, { toolError: brief(b.content) });
          }
        } else if (msg.type === 'system' && msg.subtype === 'permission_denied') {
          trace(p, { denied: msg.tool_name, reason: brief(msg.reason || msg.message || '') });
        } else if (msg.type === 'result') {
          if (msg.permission_denials?.length) {
            trace(p, { deniedTotal: msg.permission_denials.map((d) => `${d.tool_name}: ${brief(d.tool_input)}`) });
          }
          this.pending = null;
          if (msg.subtype === 'success' && !msg.is_error) p.resolve(msg.result || p.text);
          else if (p.text) p.resolve(p.text);
          else {
            const status = msg.api_error_status;
            p.reject(makeError(status === 401 || status === 403 ? 'auth' : 'claude', `claude result: ${msg.subtype} ${status || ''} ${msg.result || ''}`.trim()));
          }
        }
      }
      this.fail(makeError('claude', 'claude process ended'));
    } catch (e) {
      this.fail(e);
    }
  }

  fail(err) {
    this.dead = true;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.reject(err);
    }
  }

  ask(text, onDelta, onTool, onTrace) {
    if (this.dead) return Promise.reject(makeError('claude', 'session is closed'));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, text: '', onDelta, onTool, onTrace, streamed: false };
      this.inbox.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: this.sessionId || '',
      });
      this.waiting?.();
    });
  }

  close() {
    this.dead = true;
    try { this.waiting?.(); } catch {}
    try { this.q.close(); } catch {}
  }
}

let live = null;        // current LiveSession
let rememberedId = null; // session id to resume if `live` had to be killed

// A brand-new Claude Code process answers its FIRST message 1-3 s slower than later ones
// (lazy start-up work). So every new process gets one tiny throwaway exchange right away.
// It stays in the conversation history, which is harmless.
const PRIME_TEXT = '[Systems check before the party starts. Reply with exactly: Ready.]';

/** Spawn a fresh process now and prime it, so the next question doesn't pay the startup cost. */
export function prewarm() {
  if (!live || live.dead) {
    const session = new LiveSession(rememberedId);
    session.priming = session.ask(PRIME_TEXT).catch(() => {}).finally(() => { session.priming = null; });
    live = session;
  }
}

/** Forget the conversation and start a clean warm process. */
export function resetConversation() {
  live?.close();
  live = null;
  rememberedId = null;
  prewarm();
}

// Once words (or a web search) are flowing, allow this long in total. PC actions can chain a few
// commands, so they get longer.
const maxAnswerMs = () => (config.actions === 'auto' ? 60000 : 30000);

/**
 * Ask Claude one question. Rejects with .code 'timeout' | 'auth' | 'claude'.
 * timeoutMs is the deadline for the FIRST word; onDelta(text) receives words as they stream.
 */
export async function askClaude(text, timeoutMs, { onDelta, onTool, onTrace } = {}) {
  turn.checkedWeb = false; // each question must look its own pages up
  prewarm();
  const session = live;
  if (session.priming) await session.priming; // usually long done; otherwise nearly done
  let timer;
  let fail;
  let gotFirst = false;
  const deadline = new Promise((_, reject) => {
    fail = reject;
    timer = setTimeout(() => reject(makeError('timeout')), timeoutMs);
  });
  const activity = () => {
    if (gotFirst) return;
    gotFirst = true;
    clearTimeout(timer);
    timer = setTimeout(() => fail(makeError('timeout')), maxAnswerMs());
  };
  const handleDelta = (d) => {
    activity();
    onDelta?.(d);
  };
  const handleTool = (name) => {
    activity(); // a web search or a PC action takes several seconds: not a timeout
    onTool?.(name);
  };
  try {
    const reply = await Promise.race([session.ask(text, handleDelta, handleTool, onTrace), deadline]);
    rememberedId = session.sessionId;
    return reply;
  } catch (e) {
    // Kill the process (it may still be generating) but keep the id so memory survives.
    rememberedId = session.sessionId || rememberedId;
    session.close();
    if (live === session) live = null;
    setTimeout(prewarm, 200);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function closeAll() {
  live?.close();
  live = null;
}

/** Cheap auth check via `claude auth status --json`. False on any error. */
export function checkAuth() {
  return new Promise((resolve) => {
    const exe = config.claudePath || 'claude';
    execFile(exe, ['auth', 'status', '--json'], {
      env: childEnv(),
      timeout: 10000,
      shell: !config.claudePath && process.platform === 'win32', // bare "claude" may be a .cmd shim
      windowsHide: true,
    }, (_err, stdout) => {
      try {
        const data = JSON.parse(stdout);
        resolve(Boolean(data.loggedIn));
      } catch {
        resolve(false);
      }
    });
  });
}

/** Make the reply safe to read aloud: no markdown, no emoji, single spaced. */
export function cleanForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\(https?:[^)]*\)/g, ' ')  // source links from web search: never read out
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\[\d+\]/g, '')
    .replace(/\(\s*[;,.\s]*\)/g, ' ')            // "( ; )" left behind by removed links
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, '$2')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/[*_#~|<>]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim();
}

// Dots that do not end a sentence: J.A.R.V.I.S. -> JARVIS, Mr. -> Mr (TTS reads both fine).
function protectDots(text) {
  // No \b on the acronym: when it arrives in pieces, "JARVI" + "S." must still merge.
  return text
    .replace(/(?:[A-Za-z]\.){2,}/g, (m) => m.replace(/\./g, ''))
    .replace(/\b(Mr|Mrs|Ms|Dr|St|Jr|Sr|Mt|vs|etc|M|Mme|Mlle)\./g, '$1');
}

const SENTENCE_END = /^[\s\S]*?(?:[.!?…]+["'”»)\]]*\s+|\n\s*\n)/;

/**
 * Turns streamed words into spoken sentences as soon as each one is complete, applying the
 * same cleanup and length cap as capLength. onSentence(s) fires per finished sentence.
 */
export function createSentenceStream({ maxSentences = 3, maxWords = 50, onSentence } = {}) {
  let buf = '';
  let got = false;
  let words = 0;
  let closed = false;
  const out = [];

  function emit(raw) {
    if (closed) return;
    let s = cleanForSpeech(raw);
    if (!s) return;
    let w = s.split(' ');
    if (words + w.length > maxWords) {
      w = w.slice(0, Math.max(1, maxWords - words));
      s = w.join(' ').replace(/[,;:]$/, '');
      if (!/[.!?…]$/.test(s)) s += '.';
      closed = true;
    }
    words += w.length;
    out.push(s);
    if (out.length >= maxSentences) closed = true;
    try { onSentence?.(s); } catch {}
  }

  return {
    push(delta) {
      got = true;
      buf = protectDots(buf + delta);
      let m;
      while (!closed && (m = buf.match(SENTENCE_END))) {
        emit(m[0]);
        buf = buf.slice(m[0].length);
      }
    },
    /** Flush the rest. finalText is used if no words were streamed. Returns the full reply. */
    end(finalText = '') {
      if (!got && finalText) this.push(finalText);
      if (buf.trim()) emit(buf);
      buf = '';
      closed = true;
      return out.join(' ');
    },
  };
}

/** Hard cap so a chatty model never monologues at a party: at most 2 sentences / ~45 words. */
export function capLength(text, maxSentences = 2, maxWords = 45) {
  // Dots that do not end a sentence: J.A.R.V.I.S. -> JARVIS, Mr. -> Mr (TTS reads both fine).
  text = text
    .replace(/\b(?:[A-Za-z]\.){2,}/g, (m) => m.replace(/\./g, ''))
    .replace(/\b(Mr|Mrs|Ms|Dr|St|Jr|Sr|Mt|vs|etc|M|Mme|Mlle)\./g, '$1');
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [text];
  let out = sentences.slice(0, maxSentences).join(' ').replace(/\s+/g, ' ').trim();
  const words = out.split(' ');
  if (words.length > maxWords) out = words.slice(0, maxWords).join(' ').replace(/[,;:]$/, '') + '.';
  return out;
}
