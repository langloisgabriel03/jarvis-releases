// The Jarvis HTTP server as a reusable module: used by server.js (npm start) and by the
// Windows tray app (desktop/), which runs it in-process.
import fs from 'node:fs';
import express from 'express';
import { config, SERVER_VERSION } from './config.js';
import { languageNote, timeNote } from './persona.js';
import { transcribe, whisperAvailable } from './whisper.js';
import { askClaude, checkApiKeyEnv, createSentenceStream, prewarm, checkAuth, cleanForSpeech, closeAll, resetConversation } from './claude.js';

export { config, SERVER_VERSION, checkAuth };

/**
 * Start the server with the current `config`. Resolves once it is listening.
 * @param {{ onLog?: (entry: object) => void, quiet?: boolean }} opts
 * @returns {Promise<{ close: () => Promise<void>, status: () => { authenticated: boolean, lastAsk: object | null } }>}
 */
export async function startServer({ onLog, quiet = false } = {}) {
  checkApiKeyEnv();
  if (!config.token || config.token === 'change-me-long-random') {
    throw Object.assign(new Error('JARVIS_TOKEN is missing'), { code: 'no-token' });
  }

  // ---------- logging ----------
  const logStream = fs.createWriteStream(config.logFile, { flags: 'a' });
  function log(fields) {
    const entry = { ts: new Date().toISOString(), ...fields };
    const line = JSON.stringify(entry);
    if (!quiet) console.log(line);
    logStream.write(line + '\n');
    try { onLog?.(entry); } catch {}
  }

  // ---------- conversation memory ----------
  // The live Claude session (and its id for `resume`) lives in claude.js, in memory only.
  let hasHistory = false;
  let lastActivity = 0;
  function resetSession(reason) {
    log({ event: 'reset', reason });
    hasHistory = false;
    resetConversation();
  }
  const idleTimer = setInterval(() => {
    if (hasHistory && Date.now() - lastActivity > config.idleResetMs) serialized(async () => resetSession('idle'));
  }, 30 * 1000);
  idleTimer.unref();

  // ---------- serialize requests ----------
  let chain = Promise.resolve();
  function serialized(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  // ---------- auth health (cached) ----------
  let authCache = { value: false, at: 0 };
  let authInflight = null;
  // /health must answer fast (the phone waits 1.5 s): `claude auth status` can take several
  // seconds (much more under proot on a phone). So once a result is known, answer with it at
  // once and refresh it in the background; only the very first check is awaited.
  async function isAuthenticated() {
    const fresh = Date.now() - authCache.at < config.healthCacheMs;
    if (!fresh && !authInflight) {
      authInflight = checkAuth()
        .then((value) => { authCache = { value, at: Date.now() }; return value; })
        .finally(() => { authInflight = null; });
    }
    if (authCache.at) return authCache.value;
    return authInflight;
  }

  // ---------- app ----------
  const app = express();
  // Small JSON everywhere, except /transcribe which receives raw audio.
  const jsonBody = express.json({ limit: '16kb' });
  app.use((req, res, next) => (req.path === '/transcribe' ? next() : jsonBody(req, res, next)));

  function requireToken(req, res, next) {
    if (req.get('x-token') !== config.token) return res.status(401).json({ error: 'unauthorized' });
    next();
  }

  app.get('/health', async (_req, res) => {
    const authenticated = await isAuthenticated();
    res.json({ ok: true, authenticated, computer: config.name, version: SERVER_VERSION, actions: config.actions, whisper: whisperAvailable() });
  });

  const FILLERS = {
    search: {
      en: ['One moment, sir. Consulting the network.', 'Checking the feeds, sir.', 'Accessing the network, sir. One moment.'],
      fr: ['Un instant, Tony. Je consulte le réseau.', 'Je vérifie les données, Tony.'],
    },
    act: {
      en: ['Right away, sir.', 'On it, sir.', 'Working on it, sir.'],
      fr: ['Tout de suite, Tony.', 'Je m\'en occupe, Tony.'],
    },
    think: {
      en: ['One moment, sir.', 'Calculating, sir.', 'Let me think, sir.', 'Running the numbers, sir.'],
      fr: ['Un instant, Tony.', 'Je calcule, Tony.', 'Laissez-moi réfléchir, Tony.'],
    },
  };
  function filler(kind, lang) {
    const set = FILLERS[kind];
    const list = String(lang).toLowerCase().startsWith('fr') ? set.fr : set.en;
    return list[Math.floor(Math.random() * list.length)];
  }
  // If Claude has said nothing after this long (thinking, searching), say a short filler line.
  const FILLER_AFTER_MS = 3000;

  // Why the phone sent this question (send word, silence, tap...) and what it heard: logged so a
  // send word that fires by mistake can be spotted in jarvis.log.
  function askTrigger(body, text) {
    const t = body?.trigger;
    if (!t || typeof t !== 'object') return {};
    const cut = (v) => String(v ?? '').slice(0, 300);
    return { sentBy: cut(t.why), ...(t.phrase ? { sendWord: cut(t.phrase) } : {}), heard: cut(t.heard), question: cut(text), ...(t.whisper ? { whisper: cut(t.whisper) } : {}) };
  }

  // The phone's trace of how the sentence was heard (live words, voice level, why it ended):
  // one extra log line, to understand sentences cut too early.
  function logHeardTrace(body) {
    const trace = body?.trigger?.trace;
    if (typeof trace === 'string' && trace) log({ event: 'heard', trace: trace.slice(0, 6000) });
  }

  // POST /transcribe  body: the WAV recorded by the phone (raw bytes).
  //   headers: x-last-ms (only transcribe the last N ms), x-lang (auto|fr|en), x-prompt (vocabulary,
  //   URI-encoded). -> {text, ms} or {error}
  app.post('/transcribe', requireToken, express.raw({ type: () => true, limit: '40mb' }), async (req, res) => {
    if (!whisperAvailable()) return res.status(501).json({ error: 'whisper not installed' });
    const started = Date.now();
    try {
      let prompt = '';
      try { prompt = decodeURIComponent(String(req.get('x-prompt') || '')); } catch {}
      const langHeader = String(req.get('x-lang') || '').toLowerCase();
      const text = await transcribe(req.body, {
        lastMs: Number(req.get('x-last-ms')) || 0,
        lang: ['fr', 'en', 'auto'].includes(langHeader) ? langHeader : config.whisperLang,
        prompt,
      });
      const ms = Date.now() - started;
      log({ event: 'transcribe', ok: true, ms, bytes: req.body?.length || 0, ...(config.logText ? { text } : { len: text.length }) });
      res.json({ text, ms });
    } catch (e) {
      log({ event: 'transcribe', ok: false, ms: Date.now() - started, error: String(e?.message || e).slice(0, 200) });
      res.status(500).json({ error: 'transcribe failed' });
    }
  });

  // POST /ask {text, lang, stream?}
  //   stream:false (default) -> {reply}
  //   stream:true            -> NDJSON lines: {"s":"sentence"} as each sentence is ready, then
  //                             {"done":true,"reply":"..."} or {"error":"timeout"}. The app starts
  //                             speaking on the first sentence instead of waiting for the whole answer.
  app.post('/ask', requireToken, async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'text required' });
    if (text.length > 2000) return res.status(413).json({ error: 'text too long' });
    logHeardTrace(req.body);
    const lang = typeof req.body?.lang === 'string' ? req.body.lang : '';
    const streaming = req.body?.stream === true;
    const wantTrace = req.body?.trace === true;

    const started = Date.now();
    let firstSentenceMs;
    let saidFiller = false;
    let searched = false;
    let acted = false;
    const line = (obj) => res.write(JSON.stringify(obj) + '\n');
    if (streaming) {
      res.status(200);
      res.set({ 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      res.flushHeaders();
    }
    try {
      const reply = await serialized(async () => {
        // Don't count time spent waiting in the queue against this request's budget too harshly.
        const budget = Math.max(1500, config.timeoutMs - (Date.now() - started));
        lastActivity = Date.now();
        const sentences = createSentenceStream({
          maxSentences: 3,
          maxWords: 50,
          onSentence: (s) => {
            if (firstSentenceMs === undefined) firstSentenceMs = Date.now() - started;
            if (streaming) line({ s });
          },
        });
        const sayFiller = (kind) => {
          // Spoken only, not part of the answer or the conversation memory.
          if (!streaming || saidFiller || firstSentenceMs !== undefined) return;
          saidFiller = true;
          line({ s: filler(kind, lang || config.language) });
        };
        const fillerTimer = setTimeout(() => sayFiller('think'), FILLER_AFTER_MS);
        let out;
        try {
          out = await askClaude(timeNote(req.body?.localTime, config.location) + languageNote(lang, config.language) + text, budget, {
            onDelta: (d) => sentences.push(d),
            onTool: (name) => {
              if (name === 'thinking') return;
              if (name === 'WebSearch') {
                searched = true;
                sayFiller('search');
              } else {
                acted = true; // a PC action (actions: 'auto')
                sayFiller('act');
              }
            },
            // Tool calls, denials and tool errors: always logged; streamed too when the caller
            // asks for it (the tray app's test chat sends trace: true; the phone does not).
            onTrace: (t) => {
              log({ event: 'tool', ...t });
              if (streaming && wantTrace) line({ t });
            },
          });
        } finally {
          clearTimeout(fillerTimer);
        }
        hasHistory = true;
        lastActivity = Date.now();
        return sentences.end(out);
      });
      if (!reply) throw Object.assign(new Error('empty reply'), { code: 'empty' });
      log({ event: 'ask', from: wantTrace ? 'chat' : 'phone', ...askTrigger(req.body, text), ok: true, ms: Date.now() - started, firstMs: firstSentenceMs, search: searched || undefined, action: acted || undefined, stream: streaming || undefined, len: text.length, lang: lang || undefined, replyLen: reply.length, ...(config.logText ? { text, reply } : {}) });
      if (streaming) {
        line({ done: true, reply });
        res.end();
      } else {
        res.json({ reply });
      }
    } catch (e) {
      const code = e.code || 'error';
      log({ event: 'ask', ok: false, ...askTrigger(req.body, text), ms: Date.now() - started, len: text.length, error: code, detail: String(e.message).slice(0, 200), ...(config.logText ? { text } : {}) });
      if (code === 'auth') authCache = { value: false, at: Date.now() };
      if (streaming) {
        line({ error: code });
        return res.end();
      }
      if (code === 'timeout') return res.status(504).json({ error: 'timeout' });
      if (code === 'auth') return res.status(503).json({ error: 'auth' });
      res.status(502).json({ error: code });
    }
  });

  app.post('/reset', requireToken, (_req, res) => {
    serialized(async () => resetSession('manual'));
    res.json({ ok: true });
  });

  const httpServer = await new Promise((resolve, reject) => {
    const srv = app.listen(config.port, config.bind || '0.0.0.0', () => resolve(srv));
    srv.once('error', reject); // e.g. EADDRINUSE: port already used by an old Jarvis window
  });
  log({ event: 'boot', version: SERVER_VERSION, port: config.port, computer: config.name, model: config.model || '(cli default)', language: config.language });
  warmUp();

  // Warm start: one throwaway call so the first real question is quick, then forget it.
  async function warmUp() {
    const started = Date.now();
    try {
      await serialized(async () => {
        prewarm(); // spawns and primes the first Claude process
        await askClaude('[Systems check. Reply with exactly: Ready.]', 60000);
      });
      log({ event: 'warmup', ok: true, ms: Date.now() - started });
    } catch (e) {
      log({ event: 'warmup', ok: false, ms: Date.now() - started, detail: String(e.message).slice(0, 200) });
    }
    isAuthenticated();
  }

  return {
    async close() {
      clearInterval(idleTimer);
      closeAll();
      await new Promise((r) => httpServer.close(() => r()));
      log({ event: 'shutdown' });
      logStream.end();
    },
    status: () => ({ authenticated: authCache.value, checkedAt: authCache.at }),
    resetSession: () => serialized(async () => resetSession('manual')),
  };
}
