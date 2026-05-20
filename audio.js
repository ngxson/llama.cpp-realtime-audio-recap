/* ==========================================================================
   audio.js — Continuous PCM capture + WAV encode

   We DO NOT use MediaRecorder for chunking, because rotating recorders
   (stop → start) drops audio in the gap. Instead we keep one AudioContext
   open for the whole recording, capture raw PCM via an AudioWorkletNode,
   and slice the sample stream at *exact* chunk boundaries. No frame is
   ever lost — when the user pauses, any partial chunk in the buffer is
   flushed as a final shorter chunk.

   The AudioContext is opened at 16 kHz so the browser does the
   resampling for us, and the resulting Float32 samples can be written
   straight into a WAV file.

   API:
     const cap = new ContinuousCapture({
       sampleRate: 16000,
       chunkSeconds: 10,
       onChunk: (pcmFloat32, sampleRate, durationMs) => {…},  // full chunk
       onLevel: (level0to1) => {…},                            // VU
       onError: (err) => {…},
     });
     await cap.start();         // requests mic, opens audio graph
     await cap.stop();          // flushes any partial final chunk
     cap.setChunkSeconds(15);   // hot-update the chunk size while running
   ========================================================================== */

class ContinuousCapture {
  constructor({ sampleRate = 16000, chunkSeconds = 10, overlapMs = 0, onChunk, onLevel, onError } = {}) {
    this.sampleRate = sampleRate;
    this._chunkSeconds = Math.max(1, chunkSeconds);
    this._overlapMs = Math.max(0, overlapMs);
    this.onChunk = onChunk || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onError = onError || ((e) => console.warn('capture error', e));
    this._buffer = [];        // Float32Array[]: accumulated audio not yet emitted
    this._bufferLen = 0;      // total samples in _buffer
    this._stream = null;
    this._ctx = null;
    this._node = null;
    this._src = null;
    this._mute = null;
    this._workletUrl = null;
  }

  setChunkSeconds(seconds) {
    this._chunkSeconds = Math.max(1, Number(seconds) || 10);
  }
  setOverlapMs(ms) {
    this._overlapMs = Math.max(0, Number(ms) || 0);
  }

  async start() {
    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    // AudioContext at the target sample rate — Chrome/Firefox resample for us.
    let ctx;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: this.sampleRate });
    } catch (e) {
      // Some browsers reject custom sampleRate; fall back to default and we'd
      // need to resample manually. For now, just rethrow with a helpful msg.
      throw new Error(
        `Couldn't open AudioContext at ${this.sampleRate} Hz (${e.message}). ` +
        `Try a different browser; resampling fallback isn't implemented yet.`
      );
    }
    this._ctx = ctx;

    // Inline AudioWorklet — posts every 128-sample render quantum back to main thread.
    const workletSource = `
      class RecProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const input = inputs[0];
          if (input && input[0] && input[0].length) {
            // Copy because the underlying buffer is reused across process() calls.
            this.port.postMessage(input[0].slice());
          }
          return true;
        }
      }
      registerProcessor('rec-processor', RecProcessor);
    `;
    const blob = new Blob([workletSource], { type: 'application/javascript' });
    this._workletUrl = URL.createObjectURL(blob);
    await this._ctx.audioWorklet.addModule(this._workletUrl);

    this._src = this._ctx.createMediaStreamSource(this._stream);
    this._node = new AudioWorkletNode(this._ctx, 'rec-processor');
    this._node.port.onmessage = (e) => this._onSamples(e.data);

    // We must connect somewhere or the graph won't pull samples through.
    // Use a muted gain → destination so we don't echo the mic back.
    this._mute = this._ctx.createGain();
    this._mute.gain.value = 0;
    this._src.connect(this._node);
    this._node.connect(this._mute);
    this._mute.connect(this._ctx.destination);
  }

  _onSamples(samples) {
    // VU meter (RMS, gently scaled)
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    this.onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 3));

    this._buffer.push(samples);
    this._bufferLen += samples.length;

    const chunkSamples = this.sampleRate * this._chunkSeconds;
    // Overlap can't equal or exceed the chunk size (would loop forever).
    const overlapSamples = Math.min(
      Math.max(0, Math.floor((this._overlapMs / 1000) * this.sampleRate)),
      chunkSamples - 1
    );
    const stride = chunkSamples - overlapSamples;

    while (this._bufferLen >= chunkSamples) {
      // Copy the first chunkSamples out of the buffer without removing them.
      const out = new Float32Array(chunkSamples);
      let off = 0, segIdx = 0, segStart = 0;
      while (off < chunkSamples) {
        const seg = this._buffer[segIdx];
        const segAvail = seg.length - segStart;
        const need = chunkSamples - off;
        if (segAvail <= need) {
          out.set(seg.subarray(segStart), off);
          off += segAvail;
          segIdx++;
          segStart = 0;
        } else {
          out.set(seg.subarray(segStart, segStart + need), off);
          segStart += need;
          off += need;
        }
      }

      // Consume `stride` samples (chunkSamples - overlap). The tail of length
      // `overlap` stays in the buffer to become the head of the next chunk.
      let toConsume = stride;
      while (toConsume > 0 && this._buffer.length) {
        const head = this._buffer[0];
        if (head.length <= toConsume) {
          toConsume -= head.length;
          this._buffer.shift();
        } else {
          this._buffer[0] = head.subarray(toConsume);
          toConsume = 0;
        }
      }
      this._bufferLen -= stride;

      try { this.onChunk(out, this.sampleRate, (chunkSamples / this.sampleRate) * 1000); }
      catch (e) { this.onError(e); }
    }
  }

  /** Flush any partial chunk in the buffer (called automatically on stop()). */
  _flushPartial() {
    if (this._bufferLen === 0) return;
    const out = new Float32Array(this._bufferLen);
    let off = 0;
    for (const seg of this._buffer) { out.set(seg, off); off += seg.length; }
    const ms = (this._bufferLen / this.sampleRate) * 1000;
    this._buffer = [];
    this._bufferLen = 0;
    try { this.onChunk(out, this.sampleRate, ms); }
    catch (e) { this.onError(e); }
  }

  async stop({ flush = true } = {}) {
    if (flush) this._flushPartial();
    try { if (this._node) this._node.disconnect(); } catch {}
    try { if (this._src) this._src.disconnect(); } catch {}
    try { if (this._mute) this._mute.disconnect(); } catch {}
    if (this._stream) { try { this._stream.getTracks().forEach(t => t.stop()); } catch {} }
    if (this._ctx) { try { await this._ctx.close(); } catch {} }
    if (this._workletUrl) { try { URL.revokeObjectURL(this._workletUrl); } catch {} }
    this._stream = this._ctx = this._node = this._src = this._mute = null;
    this._workletUrl = null;
    this.onLevel(0);
  }
}

// ----------------------------------------------------------- WAV utilities

/** Encode mono Float32 PCM → 16-bit PCM WAV ArrayBuffer. */
function encodeWAV(samples, sampleRate) {
  const numCh = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numCh * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const ws = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  ws(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ws(8, 'WAVE');
  ws(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);             // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ws(36, 'data');
  view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}

/** Read a WAV blob produced by encodeWAV() → Int16Array of PCM samples. */
async function wavBlobToInt16(blob) {
  const ab = await blob.arrayBuffer();
  // Header is 44 bytes for the PCM WAVs we write. Be a little defensive.
  let dataOffset = 44;
  try {
    const view = new DataView(ab);
    // Look for "data" marker, just in case (some encoders write extra fmt fields).
    for (let i = 12; i < Math.min(ab.byteLength - 8, 200); i++) {
      if (view.getUint8(i) === 0x64 /*d*/ &&
          view.getUint8(i + 1) === 0x61 /*a*/ &&
          view.getUint8(i + 2) === 0x74 /*t*/ &&
          view.getUint8(i + 3) === 0x61 /*a*/) {
        dataOffset = i + 8;
        break;
      }
    }
  } catch {}
  return new Int16Array(ab.slice(dataOffset));
}

/** Concatenate many PCM-WAV blobs (same sampleRate) into one big WAV blob. */
async function concatWavBlobs(blobs, sampleRate) {
  const parts = [];
  let total = 0;
  for (const b of blobs) {
    if (!b) continue;
    const i16 = await wavBlobToInt16(b);
    parts.push(i16);
    total += i16.length;
  }
  if (!total) return null;
  const all = new Float32Array(total);
  let off = 0;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) all[off + i] = Math.max(-1, p[i] / 0x8000);
    off += p.length;
  }
  return new Blob([encodeWAV(all, sampleRate)], { type: 'audio/wav' });
}

/** ArrayBuffer → base64 (chunked to avoid stack overflow). */
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(s);
}

window.AudioUtils = {
  ContinuousCapture,
  encodeWAV,
  wavBlobToInt16,
  concatWavBlobs,
  arrayBufferToBase64,
};
