// Speech-to-text with whisper.cpp (optional). Android's recognizer runs one language at a time;
// Whisper understands French and English mixed in one sentence and takes a vocabulary prompt
// (Jarvis, Stormbreaker...). The phone keeps using Android's recognizer to hear the wake word,
// then sends the recorded audio here and uses this text for the question.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

export function whisperAvailable() {
  return Boolean(config.whisperBin && config.whisperModel && fs.existsSync(config.whisperBin) && fs.existsSync(config.whisperModel));
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
 * Transcribe a WAV buffer. lang: 'auto' (default, handles mixed French/English best), 'fr', 'en'.
 * prompt: vocabulary to favour. Resolves with the text; rejects on failure or timeout.
 */
export async function transcribe(buf, { lastMs = 0, lang = config.whisperLang || 'auto', prompt = '', signal } = {}) {
  const { wav, seconds } = lastPartOfWav(buf, lastMs);
  if (seconds < 0.3) return '';
  const file = path.join(os.tmpdir(), `jarvis-${process.pid}-${Date.now()}.wav`);
  fs.writeFileSync(file, wav);
  // Speed on a phone: greedy decoding (the default beam search of 5 is several times slower), no
  // temperature retries, and an encoder window sized to the clip instead of always 30 s (50 per s).
  const audioCtx = Math.min(1500, Math.max(256, Math.ceil((seconds + 1) * 50)));
  const args = ['-m', config.whisperModel, '-f', file, '-l', lang, '-t', String(config.whisperThreads || 4), '-nt', '-np',
    '-bs', '1', '-bo', '1', '-nf', '-ac', String(audioCtx)];
  if (prompt) args.push('--prompt', prompt.slice(0, 600));
  try {
    const out = await new Promise((resolve, reject) => {
      // The phone stops waiting after 9 s: never keep the CPU busy longer than that (Claude needs it).
      execFile(config.whisperBin, args, { timeout: config.whisperTimeoutMs, maxBuffer: 1024 * 1024, signal }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    return String(out)
      .split('\n')
      .map((l) => l.replace(/^\s*\[[^\]]*\]\s*/, '').trim()) // timestamps, if any slipped through
      .filter((l) => l && !/^\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]$/i.test(l) && !/^\((music|silence|bruit)\)$/i.test(l))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}
