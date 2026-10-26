// Speech-to-text with whisper.cpp (optional). Android's recognizer runs one language at a time;
// Whisper understands French and English mixed in one sentence and takes a vocabulary prompt
// (Jarvis, Stormbreaker...). The phone keeps using Android's recognizer to hear the wake word,
// then sends the recorded audio here and uses this text for the question.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

function cliAvailable() {
  return Boolean(config.whisperBin && config.whisperModel && fs.existsSync(config.whisperBin) && fs.existsSync(config.whisperModel));
}

export function whisperAvailable() {
  return Boolean(config.whisperUrl) || cliAvailable();
}

/** Parse a PCM WAV file: { sampleRate, channels, bits, dataStart, dataLength }. */
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a wav file');
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === 'data') {
      // A file still being written can report 0 or a too-big size: use what is really there.
      if (!size || body + size > buf.length) size = buf.length - body;
      if (!fmt) throw new Error('wav without fmt chunk');
      return { ...fmt, dataStart: body, dataLength: size };
    }
    pos = body + size + (size % 2);
  }
  throw new Error('wav without data chunk');
}

/** A new WAV holding only the last `lastMs` of audio (all of it if lastMs is 0 or too big). */
export function lastPartOfWav(buf, lastMs) {
  const w = parseWav(buf);
  const frame = w.channels * (w.bits / 8);
  let length = w.dataLength - (w.dataLength % frame);
  let start = w.dataStart;
  if (lastMs > 0) {
    const want = Math.floor((lastMs / 1000) * w.sampleRate) * frame;
    if (want < length) { start += length - want; length = want; }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(w.channels, 22);
  header.writeUInt32LE(w.sampleRate, 24);
  header.writeUInt32LE(w.sampleRate * frame, 28);
  header.writeUInt16LE(frame, 32);
  header.writeUInt16LE(w.bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(length, 40);
  return { wav: Buffer.concat([header, buf.subarray(start, start + length)]), seconds: length / frame / w.sampleRate };
}

/**
 * Whisper's prompt reads as the text said just before, so a bare word list makes it answer in the
 * same style ("Travis, Ciscuit Stormbreaker,"). Give it a short sentence that uses the vocabulary.
 */
function promptSentence(prompt, lang) {
  const words = String(prompt || '').split(',').map((w) => w.trim()).filter(Boolean);
  const unique = [...new Set(words)].slice(0, 30).join(', ');
  if (!unique) return '';
  const lead = lang === 'en' ? 'Tony talks to Jarvis about' : 'Tony parle à Jarvis, en français avec des mots anglais, de';
  return `${lead} ${unique}.`.slice(0, 500);
}

function cleanText(out) {
  return String(out)
    .split('\n')
    .map((l) => l.replace(/^\s*\[[^\]]*\]\s*/, '').trim()) // timestamps, if any slipped through
    .filter((l) => l && !/^\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]$/i.test(l) && !/^\((music|silence|bruit)\)$/i.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** whisper-server (whisper.cpp) running natively in Termux, model kept in memory: much faster than proot. */
async function viaServer(wav, lang, prompt, signal) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'question.wav');
  form.append('response_format', 'json');
  form.append('language', lang);
  form.append('temperature', '0');
  form.append('no_timestamps', 'true');
  if (prompt) form.append('prompt', prompt);
  const timeout = AbortSignal.timeout(config.whisperTimeoutMs);
  const r = await fetch(config.whisperUrl, { method: 'POST', body: form, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!r.ok) throw new Error(`whisper-server HTTP ${r.status}`);
  const body = await r.json();
  if (body.error) throw new Error(`whisper-server: ${body.error}`);
  return cleanText(body.text || '');
}

async function viaCli(wav, lang, prompt, signal) {
  const file = path.join(os.tmpdir(), `jarvis-${process.pid}-${Date.now()}.wav`);
  fs.writeFileSync(file, wav);
  // Greedy decoding (the default beam search of 5 is several times slower), no temperature retries.
  const args = ['-m', config.whisperModel, '-f', file, '-l', lang, '-t', String(config.whisperThreads || 4), '-nt', '-np', '-bs', '1', '-bo', '1', '-nf'];
  if (prompt) args.push('--prompt', prompt);
  try {
    const out = await new Promise((resolve, reject) => {
      // The phone stops waiting after 9 s: never keep the CPU busy longer than that (Claude needs it).
      execFile(config.whisperBin, args, { timeout: config.whisperTimeoutMs, maxBuffer: 1024 * 1024, signal }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    return cleanText(out);
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}

/**
 * Transcribe a WAV buffer. lang: 'fr', 'en' or 'auto'. prompt: comma-separated vocabulary to favour.
 * Resolves with the text; rejects on failure or timeout.
 */
export async function transcribe(buf, { lastMs = 0, lang = config.whisperLang || 'auto', prompt = '', signal } = {}) {
  const { wav, seconds } = lastPartOfWav(buf, lastMs);
  if (seconds < 0.3) return '';
  const sentence = promptSentence(prompt, lang);
  // whisper-cli in Debian is far too slow (8-20 s) to be worth a fallback once whisper-server is set up.
  if (config.whisperUrl) {
    try {
      return await viaServer(wav, lang, sentence, signal);
    } catch (e) {
      const why = e?.cause?.code || (e?.name === 'TimeoutError' ? 'timeout' : e?.message || String(e));
      throw new Error(`whisper-server (${config.whisperUrl}): ${why}`);
    }
  }
  return viaCli(wav, lang, sentence, signal);
}
