/* ==========================================================================
   Live Recap — Vue 3 app (v3)
   ----------------------------------------------------------------------------
   Pipeline (per audio chunk):
     mic → AudioWorklet (continuous PCM at 16 kHz) → sliced into chunkSeconds
         → 16-bit PCM WAV blob (stored) + base64 (for the API)
         → POST /v1/chat/completions (streaming)
             messages = [
               system,
               (for each prior chunk in window: user[audio], assistant[transcript]),
               user[ "Transcribe this latest segment, then === RECAP === …" + input_audio(latest) ]
             ]
         → stream parser splits on "=== RECAP ===" into transcript + bullets

   No audio is dropped: capture is continuous, with samples accumulated and
   sliced at *exact* chunk boundaries. Pausing flushes the partial chunk.

   Multiple projects: schema is { projects → sessions → chunks }. The header
   picker lets the user create, rename, and switch projects. Each project
   keeps its own session history.
   ========================================================================== */

const { createApp, ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } = Vue;

const STORAGE_KEY = 'liveRecap.settings.v2';
const CURRENT_PROJECT_KEY = 'liveRecap.currentProjectId';
const RECAP_MARKER = '=== RECAP ===';
const SAMPLE_RATE = 16000;

const DEFAULT_SETTINGS = {
  llmUrl: 'http://localhost:8080/v1/chat/completions',
  llmModel: 'local',
  apiKey: '',
  echoCancellation: true,
  chunkSeconds: 10,
  chunkOverlapMs: 1000,
  windowChunks: 2,           // audio window: chunks sent as audio in each call
  textChunks: 3,             // text context: prior transcripts sent as plain text before the audio window
  recapWindow: 3,            // recap snapshots: older chunks included as compact bullet context
  maxRecapBullets: 5,        // hard cap on the recap's bullet count — prompt asks the model to compress when exceeded
  recapLanguage: 'English',
  systemPrompt:
    "You maintain a running recap of a live talk for someone following a foreign-language speaker.\n\n" +
    "Transcribe ONLY the last audio clip (attached to this message). Earlier clips already have transcripts.\n\n" +
    "Audio chunks are fixed-length slices of a live stream, so the first/last word of any clip may be chopped. Earlier transcripts may be incomplete at their boundaries — that is expected.\n\n" +
    "Output format:\n" +
    "<verbatim transcript in the source language; [silence] if non-speech>\n" +
    RECAP_MARKER + "\n" +
    "<updated recap in {{LANG}}, ≤ {{MAX_BULLETS}} bullets, '- '-prefixed>\n\n" +
    "Recap rules:\n" +
    "• Max {{MAX_BULLETS}} bullets. Aim for 2–3. Only use more if the content truly warrants it. Aggressively drop minor, redundant, or superseded bullets.\n" +
    "• If the latest audio ends mid-sentence or is unclear, still transcribe what you hear, but you may leave the recap unchanged rather than adding speculative bullets.\n" +
    "• No meta-commentary. State content directly. Preserve numbers, names, quotes.\n" +
    "• Use **bold** only for truly important information.\n" +
    "• Every turn MUST change at least 1 bullet — never output the identical recap as before. If nothing new happened, compress or merge existing bullets.",
  temperature: 0.2,
  topK: 20,
  mockMode: false,
};

// Fake French talk for mock mode (no network).
const MOCK_TRANSCRIPT_CHUNKS = [
  "Bonjour à tous, merci d'être venus. Aujourd'hui je vais parler de quantification des grands modèles de langage.",
  "On commence par un rappel — un modèle de sept milliards de paramètres en seize bits, ça représente environ quatorze gigaoctets.",
  "L'objectif de la quantification c'est de réduire la précision des poids, donc passer de seize bits à quatre bits par exemple.",
  "La méthode la plus simple c'est la quantification post-entraînement, ou PTQ.",
  "Le problème c'est que pour certaines couches, naïvement quantifier en quatre bits dégrade beaucoup la qualité.",
  "C'est pourquoi des méthodes comme GPTQ et AWQ identifient les poids importants et les protègent.",
  "AWQ — activation-aware weight quantization — se base sur la magnitude des activations pour décider quels canaux protéger.",
  "Sur Llama trois huit milliards, en passant de seize bits à quatre bits avec AWQ, on perd moins d'un point de perplexité.",
  "Côté hardware, on peut faire tourner ces modèles sur une carte grand public avec huit gigaoctets de VRAM.",
  "Et l'inférence devient aussi plus rapide, parce qu'on est limité par la bande passante mémoire, pas par le calcul.",
  "Une autre approche c'est la quantification consciente de l'entraînement, ou QAT.",
  "Le coût est plus élevé mais on peut descendre jusqu'à deux bits avec des résultats étonnants.",
  "Pour conclure — la quantification c'est devenu un outil essentiel pour déployer les LLMs en local. Merci.",
];
const MOCK_RECAP_BULLETS = [
  ["Opening: today's talk is about quantization of large language models."],
  ["A 7B-parameter model in fp16 weighs about 14 GB."],
  ["Quantization reduces the precision of weights — e.g. 16-bit to 4-bit."],
  ["Post-training quantization (PTQ) is the simplest approach."],
  ["Naive 4-bit PTQ degrades quality on some layers."],
  ["GPTQ and AWQ identify the 'important' weights and protect them."],
  ["AWQ uses activation magnitudes to pick which channels to keep at higher precision."],
  ["On Llama-3 8B, 4-bit AWQ loses less than 1 perplexity point vs fp16."],
  ["Consumer GPUs (8 GB VRAM) can now run these models locally."],
  ["Inference is also faster — memory bandwidth, not compute, is the bottleneck."],
  ["Quantization-aware training (QAT) simulates quantization during fine-tuning."],
  ["QAT can push down to 2-bit weights with good results."],
  ["Closing: quantization is essential for local LLM deployment."],
];

createApp({
  setup() {
    // ---------- Settings ----------
    const settings = reactive(loadSettings());
    function loadSettings() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      } catch {}
      return { ...DEFAULT_SETTINGS };
    }
    function saveSettings() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch {}
    }
    watch(settings, saveSettings, { deep: true });
    function resetSettings() { Object.assign(settings, DEFAULT_SETTINGS); }
    function resetSystemPrompt() {
      settings.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
      flashToast('Prompt reset to default');
    }

    // Hot-update the live capture's chunk size + overlap when settings change
    watch(() => settings.chunkSeconds, (v) => { if (capture) capture.setChunkSeconds(v); });
    watch(() => settings.chunkOverlapMs, (v) => { if (capture) capture.setOverlapMs(v); });

    // ---------- UI state ----------
    const showSettings = ref(false);
    const promptCollapsed = ref(false);
    const contextPrompt = ref('');
    const recording = ref(false);
    const sessionStart = ref(0);
    const sessionElapsed = ref(0);
    const error = ref('');
    const toast = ref('');
    const audioLevel = ref(0);
    const sourceLangGuess = ref('');
    const dbReady = ref(false);

    // ---------- Project state ----------
    const projects = reactive([]);                  // [{id, name, createdAt, updatedAt}]
    const currentProjectId = ref(null);
    const currentProject = computed(() => projects.find(p => p.id === currentProjectId.value) || null);
    const sidebarCollapsed = ref(false);
    const newProjectInputVisible = ref(false);
    const newProjectDraft = ref('');
    const renamingProjectId = ref(null);
    const projectNameDraft = ref('');

    // ---------- Session state ----------
    const currentSession = ref(null);
    const chunks = reactive([]);                    // full history of current session
    const audioCache = new Map();                   // chunkId → base64 wav (sliding window)

    // ---------- Runtime ----------
    let capture = null;                             // ContinuousCapture instance
    let timerInterval = null;
    let mockTimer = null;
    let mockIndex = 0;
    let _llmChain = Promise.resolve();              // serialises LLM calls — prevents concurrent pile-up

    // ---------- Time helpers ----------
    function formatTime(ms) {
      const s = Math.max(0, Math.floor(ms / 1000));
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      return `${mm}:${ss}`;
    }
    function formatWallTime(ms) {
      if (!ms) return '';
      try {
        return new Date(ms).toLocaleString(undefined, {
          year: 'numeric', month: 'short', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
      } catch { return new Date(ms).toString(); }
    }
    const elapsedDisplay = computed(() => formatTime(sessionElapsed.value));

    // ---------- DB init ----------
    onMounted(async () => {
      try {
        await DB.ensureDefaultProject();
        await refreshProjects();
        const storedId = localStorage.getItem(CURRENT_PROJECT_KEY);
        const target = (storedId && projects.find(p => p.id === storedId)) || projects[0];
        await switchProject(target.id, { skipStop: true });
        dbReady.value = true;
      } catch (e) {
        error.value = `Storage failed: ${e.message}`;
        dbReady.value = true;
      }
      window.addEventListener('keydown', onKey);
    });
    onBeforeUnmount(() => {
      window.removeEventListener('keydown', onKey);
    });

    async function refreshProjects() {
      const list = await DB.listProjects();
      projects.splice(0, projects.length, ...list);
    }

    // Persist context prompt onto the current session as user edits it
    watch(contextPrompt, async (v) => {
      if (currentSession.value && currentSession.value.contextPrompt !== v) {
        currentSession.value.contextPrompt = v;
        try { await DB.updateSession({ ...currentSession.value }); } catch {}
      }
    });

    // ---------- Project actions ----------
    async function switchProject(projectId, { skipStop } = {}) {
      if (!skipStop && recording.value) await stopRecording();
      currentProjectId.value = projectId;
      try { localStorage.setItem(CURRENT_PROJECT_KEY, projectId); } catch {}
      // Reset session state for the new project
      chunks.splice(0, chunks.length);
      audioCache.clear();
      sessionStart.value = 0;
      sessionElapsed.value = 0;
      sourceLangGuess.value = '';

      const latest = await DB.getLatestSession(projectId);
      if (latest) {
        currentSession.value = latest;
        contextPrompt.value = latest.contextPrompt || '';
        const loaded = await DB.getChunks(latest.id);
        chunks.push(...loaded.map(c => ({
          ...c,
          llmDurationMs: c.llmDurationMs ?? null,
          status: c.status === 'streaming' || c.status === 'pending' ? 'done' : (c.status || 'done'),
          bullets: Array.isArray(c.bullets) ? c.bullets : [],
        })));
      } else {
        currentSession.value = await DB.createSession(projectId, { contextPrompt: '' });
        contextPrompt.value = '';
      }
      renamingProjectId.value = null;
    }

    async function createProjectAction() {
      const name = (newProjectDraft.value || '').trim();
      if (!name) { newProjectInputVisible.value = false; return; }
      const p = await DB.createProject(name);
      newProjectDraft.value = '';
      newProjectInputVisible.value = false;
      await refreshProjects();
      await switchProject(p.id);
      flashToast(`Project “${p.name}” created`);
    }

    function beginRenameProject(projectId) {
      const p = projects.find(x => x.id === projectId);
      if (!p) return;
      projectNameDraft.value = p.name;
      renamingProjectId.value = projectId;
    }

    async function commitRenameProject() {
      const id = renamingProjectId.value;
      const p = projects.find(x => x.id === id);
      if (!p) { renamingProjectId.value = null; return; }
      const name = (projectNameDraft.value || '').trim();
      if (name && name !== p.name) {
        const updated = { ...p, name };
        await DB.updateProject(updated);
        await refreshProjects();
        flashToast('Project renamed');
      }
      renamingProjectId.value = null;
    }

    function cancelRenameProject() {
      renamingProjectId.value = null;
    }

    async function deleteProject(projectId) {
      const p = projects.find(x => x.id === projectId);
      if (!p) return;
      if (projects.length <= 1) { flashToast("Can't delete the last project"); return; }
      if (!confirm(`Delete project “${p.name}” and all its sessions? This cannot be undone.`)) return;
      await DB.deleteProject(projectId);
      await refreshProjects();
      if (currentProjectId.value === projectId) {
        await switchProject(projects[0].id);
      }
      flashToast('Project deleted');
    }

    // ---------- Start / Pause ----------
    async function toggleRecording() {
      if (recording.value) await stopRecording();
      else await startRecording();
    }

    async function startRecording() {
      error.value = '';
      try {
        if (!currentSession.value) {
          currentSession.value = await DB.createSession(currentProjectId.value, { contextPrompt: contextPrompt.value });
        }
        if (settings.mockMode) startMock();
        else await startRealCapture();
        recording.value = true;
        const last = chunks[chunks.length - 1];
        const cumulative = last ? (last.time + (last.durationMs || settings.chunkSeconds * 1000)) : 0;
        sessionStart.value = Date.now() - cumulative;
        timerInterval = setInterval(() => {
          sessionElapsed.value = Date.now() - sessionStart.value;
        }, 250);
      } catch (e) {
        error.value = e.message || 'Failed to start recording';
        await stopRecording();
      }
    }

    async function stopRecording() {
      recording.value = false;
      clearInterval(timerInterval); timerInterval = null;
      stopMock();
      if (capture) {
        try { await capture.stop({ flush: true }); } catch {}
        capture = null;
      }
      audioLevel.value = 0;
      _llmChain = Promise.resolve();
    }

    // ---------- Continuous audio capture ----------
    async function startRealCapture() {
      capture = new AudioUtils.ContinuousCapture({
        sampleRate: SAMPLE_RATE,
        chunkSeconds: Math.max(1, Number(settings.chunkSeconds) || 10),
        overlapMs: Math.max(0, Number(settings.chunkOverlapMs) || 0),
        echoCancellation: !!settings.echoCancellation,
        onChunk: (pcm, sampleRate, durationMs) => {
          // Don't await: capture keeps accumulating regardless of API speed.
          processPcmChunk(pcm, sampleRate, durationMs);
        },
        onLevel: (lvl) => { audioLevel.value = lvl; },
        onError: (e) => { error.value = `Audio: ${e.message}`; },
      });
      await capture.start();
    }

    // ---------- New session button (archive + start blank) ----------
    async function newSession() {
      const hasContent = chunks.length > 0;
      if (hasContent) {
        const msg = recording.value
          ? 'Pause this session and start a new one?\n\nThe current session will be archived (still accessible via project history) but cleared from view.'
          : 'Archive this session and start a new one?\n\nThe current session will stay in your project history but be cleared from view.';
        if (!confirm(msg)) return;
      }
      if (recording.value) await stopRecording();
      if (currentSession.value) {
        try { await DB.endSession(currentSession.value.id); } catch {}
      }
      currentSession.value = await DB.createSession(currentProjectId.value, { contextPrompt: contextPrompt.value });
      chunks.splice(0, chunks.length);
      audioCache.clear();
      sessionStart.value = 0;
      sessionElapsed.value = 0;
      sourceLangGuess.value = '';
      flashToast('New session');
    }

    // ---------- Process one chunk ----------
    async function processPcmChunk(pcm, sampleRate, durationMs) {
      if (!currentSession.value) return;

      const wavBuf = AudioUtils.encodeWAV(pcm, sampleRate);
      const wavBlob = new Blob([wavBuf], { type: 'audio/wav' });
      const b64 = AudioUtils.arrayBufferToBase64(wavBuf);

      const chunk = reactive({
        id: DB.uuid(),
        sessionId: currentSession.value.id,
        projectId: currentSession.value.projectId,
        idx: chunks.length,
        time: Date.now() - sessionStart.value,
        transcript: '',
        bullets: [],
        status: 'streaming',
        audioMime: 'audio/wav',
        audioBlob: wavBlob,
        durationMs,
        llmDurationMs: null,
        createdAt: Date.now(),
      });
      chunks.push(chunk);
      audioCache.set(chunk.id, b64);
      trimAudioCache();

      // Persist immediately so the audio survives even if the API fails
      try { await DB.putChunk(toPlain(chunk)); } catch (e) { console.warn('putChunk', e); }

      // Serialize onto the chain: prevents concurrent LLM pile-up that causes
      // progressive delay when the backend is slower than the chunk interval.
      _llmChain = _llmChain.then(() => runLLM(chunk));
    }

    async function runLLM(chunk) {
      const t0 = Date.now();
      try {
        await callLLM(chunk);
        chunk.status = 'done';
      } catch (e) {
        chunk.status = 'error';
        if (!chunk.transcript) chunk.transcript = `[error: ${e.message}]`;
        error.value = `Recap failed: ${e.message}`;
      } finally {
        chunk.llmDurationMs = Date.now() - t0;
        chunk.bullets = (chunk.bullets || []).map(b => (b || '').trim()).filter(Boolean);
        try { await DB.putChunk(toPlain(chunk)); } catch (e) { console.warn('putChunk', e); }
      }
    }

    function toPlain(chunk) {
      return {
        id: chunk.id, sessionId: chunk.sessionId, projectId: chunk.projectId,
        idx: chunk.idx, time: chunk.time,
        transcript: chunk.transcript,
        bullets: [...chunk.bullets],
        status: chunk.status,
        audioMime: chunk.audioMime, audioBlob: chunk.audioBlob,
        durationMs: chunk.durationMs, llmDurationMs: chunk.llmDurationMs,
        createdAt: chunk.createdAt,
      };
    }

    function trimAudioCache() {
      const keep = Math.max(1, (Number(settings.windowChunks) || 3) + 1);
      const wanted = new Set(chunks.slice(-keep).map(c => c.id));
      for (const k of audioCache.keys()) if (!wanted.has(k)) audioCache.delete(k);
    }

    // ---------- LLM call (rewrite mode) ----------
    // Each call ships:
    //   • the previous audio chunks in the audio window as user(audio) →
    //     assistant(transcript) pairs (no bullets in the assistant turns —
    //     the canonical recap lives in the final user turn instead),
    //   • the running recap as plain text (the bullets of the most recent
    //     non-streaming chunk — i.e. the recap-as-of-now),
    //   • older prior transcripts (textChunks) as plain text grounding,
    //   • even older recap bullet snapshots (recapWindow) as compact context,
    //   • the latest audio chunk.
    // The model returns the *complete updated recap*.
    async function callLLM(latestChunk) {
      const N = Math.max(1, Number(settings.windowChunks) || 2);
      const T = Math.max(0, Number(settings.textChunks) || 3);
      const R = Math.max(0, Number(settings.recapWindow) || 3);
      const auStart = Math.max(0, chunks.length - N);
      const txStart = Math.max(0, auStart - T);
      const rcStart = Math.max(0, txStart - R);
      const auWindow = chunks.slice(auStart);
      const priorAudio = auWindow.slice(0, -1);
      const textOnlyPrior = chunks.slice(txStart, auStart);
      const recapOnlyPrior = chunks.slice(rcStart, txStart);

      // Running recap = bullets of the most recent prior chunk that has any.
      let priorRecap = [];
      for (let i = chunks.length - 2; i >= 0; i--) {
        if (chunks[i].bullets && chunks[i].bullets.length) { priorRecap = chunks[i].bullets; break; }
      }

      const sys = settings.systemPrompt
        .replace(/\{\{LANG\}\}/g, settings.recapLanguage)
        .replace(/\{\{MAX_BULLETS\}\}/g, String(settings.maxRecapBullets || 10));

      const content = [];
      content.push({ type: 'text', text: sys + '\n\n' });

      if (contextPrompt.value) {
        content.push({ type: 'text', text: `Talk context (user-provided): ${contextPrompt.value}\n\n` });
      }

      if (recapOnlyPrior.length) {
        let t = `Earlier recap snapshots (oldest → newest, compact context):\n`;
        for (const c of recapOnlyPrior) {
          if (c.bullets && c.bullets.length) {
            t += `[${formatTime(c.time)}] ${c.bullets.map(b => `- ${b}`).join(' | ')}\n`;
          }
        }
        content.push({ type: 'text', text: t + '\n' });
      }

      if (textOnlyPrior.length) {
        let t = `Earlier transcripts (text only — no audio for these):\n`;
        for (const c of textOnlyPrior) {
          t += `[${formatTime(c.time)}] ${(c.transcript || '[silence]').replace(/\s+/g, ' ').trim()}\n`;
        }
        content.push({ type: 'text', text: t + '\n' });
      }

      for (const c of priorAudio) {
        const b64 = audioCache.get(c.id);
        content.push({ type: 'text', text: `Past audio segment (already transcribed): transcript = "${c.transcript || '[silence]'}"` });
        if (b64) content.push({ type: 'input_audio', input_audio: { data: b64, format: 'wav' } });
        content.push({ type: 'text', text: '\n' });
      }

      if (priorAudio.length > 0) {
        content.push({ type: 'text', text: 'Above are past audio segments. Below is the NEW audio with a small overlap:\n\n' });
      }

      const maxBullets = Math.max(3, Number(settings.maxRecapBullets) || 10);

      // Filter out bullets that have appeared unchanged in more than 5 consecutive chunks
      const filteredRecap = priorRecap.filter(b => {
        const norm = b.trim().toLowerCase();
        let streak = 0;
        for (let i = chunks.length - 2; i >= 0; i--) {
          if ((chunks[i].bullets || []).some(x => x.trim().toLowerCase() === norm)) streak++;
          else break;
        }
        return streak <= 5;
      });
      const dropped = priorRecap.length - filteredRecap.length;

      const priorCount = filteredRecap.length;
      const recapHeader = priorCount
        ? `Current recap (${priorCount}/${maxBullets} bullets${dropped ? ` — ${dropped} stale bullet(s) removed, do not re-add them` : ''}):`
        : 'Current recap: (none yet)';
      const recapText = priorCount
        ? `${recapHeader}\n${filteredRecap.map(b => `- ${b}`).join('\n')}\n\n`
        : `${recapHeader}\n\n`;
      content.push({ type: 'text', text: recapText });

      content.push({ type: 'text', text: `Transcribe ONLY the audio below (it is the NEW segment, not yet transcribed). Then output ${RECAP_MARKER} on its own line, then the updated recap in ${settings.recapLanguage}. Hard limit: ≤ ${maxBullets} bullets. DROP non-bold bullets aggressively before adding new ones. Never drop **bold** bullets.\n` });

      const latestB64 = audioCache.get(latestChunk.id);
      if (latestB64) content.push({ type: 'input_audio', input_audio: { data: latestB64, format: 'wav' } });

      const abortCtrl = new AbortController();
      await streamChat({ messages: [{ role: 'user', content }], stream: true }, makeStreamHandler(latestChunk, () => abortCtrl.abort()), abortCtrl.signal);
    }

    async function streamChat(payload, onDelta, signal) {
      const headers = { 'Content-Type': 'application/json' };
      if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;
      const body = JSON.stringify({
        model: settings.llmModel || 'local',
        temperature: Number(settings.temperature) ?? 0.2,
        top_k: Number(settings.topK) || 20,
        max_tokens: 500,
        ...payload,
      });
      let res;
      try {
        res = await fetch(settings.llmUrl, { method: 'POST', headers, body, signal });
      } catch (e) {
        if (e.name === 'AbortError') return;
        throw e;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const raw of lines) {
            const line = raw.trim();
            if (!line || !line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') return;
            try {
              const j = JSON.parse(data);
              const delta = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? '';
              if (delta) onDelta(delta);
            } catch { /* ignore */ }
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') throw e;
      }
    }

    // ---------- Stream parser ----------
    function makeStreamHandler(chunk, abortFn = () => {}) {
      let phase = 'transcript';
      let transcriptBuf = '';
      let recapBuf = '';
      let fullText = '';
      const M = RECAP_MARKER;
      return function onDelta(delta) {
        // Repetition guard: abort if the same word repeats > 10 times in a row
        fullText += delta;
        const words = fullText.split(/\s+/).filter(Boolean);
        if (words.length > 10) {
          const last = words[words.length - 1].toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
          let streak = 0;
          for (let i = words.length - 1; i >= 0; i--) {
            if (words[i].toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') === last) streak++;
            else break;
          }
          if (streak > 10) { abortFn(); return; }
        }

        if (phase === 'transcript') {
          transcriptBuf += delta;
          const ix = transcriptBuf.indexOf(M);
          if (ix >= 0) {
            chunk.transcript = transcriptBuf.slice(0, ix).trim();
            recapBuf = transcriptBuf.slice(ix + M.length);
            transcriptBuf = '';
            phase = 'recap';
            updateBullets(chunk, recapBuf);
          } else {
            const safe = Math.max(0, transcriptBuf.length - (M.length - 1));
            chunk.transcript = transcriptBuf.slice(0, safe).trim();
          }
        } else {
          recapBuf += delta;
          updateBullets(chunk, recapBuf);
        }
      };
    }

    function updateBullets(chunk, recapText) {
      const lines = recapText.split(/\r?\n/);
      const bullets = lines.map(l => l.replace(/^\s*[-•*]\s?/, ''));
      while (bullets.length > 1 && bullets[0].trim() === '') bullets.shift();
      while (bullets.length > 1 &&
             bullets[bullets.length - 1].trim() === '' &&
             bullets[bullets.length - 2].trim() === '') bullets.pop();
      chunk.bullets = bullets;
    }

    // ---------- Mock pipeline ----------
    function startMock() {
      mockIndex = chunks.length % MOCK_TRANSCRIPT_CHUNKS.length;
      sourceLangGuess.value = 'fr';
      scheduleMockTick();
    }
    function stopMock() {
      if (mockTimer) { clearTimeout(mockTimer); mockTimer = null; }
      audioLevel.value = 0;
    }
    function scheduleMockTick() {
      const interval = Math.max(2, Number(settings.chunkSeconds) || 10) * 1000;
      animateMockVU(interval);
      mockTimer = setTimeout(async () => {
        const text = MOCK_TRANSCRIPT_CHUNKS[mockIndex % MOCK_TRANSCRIPT_CHUNKS.length];
        const bullets = MOCK_RECAP_BULLETS[mockIndex % MOCK_RECAP_BULLETS.length];
        mockIndex++;
        await deliverMockChunk(text, bullets);
        if (recording.value) scheduleMockTick();
      }, interval);
    }
    function animateMockVU(durationMs) {
      const start = performance.now();
      const tick = () => {
        if (!recording.value || !settings.mockMode) { audioLevel.value = 0; return; }
        const t = (performance.now() - start) / durationMs;
        if (t > 1) return;
        const env = 0.4 + 0.45 * Math.abs(Math.sin(t * 11)) * (0.6 + 0.4 * Math.sin(t * 23));
        audioLevel.value = Math.max(0.05, Math.min(1, env + (Math.random() - 0.5) * 0.15));
        requestAnimationFrame(tick);
      };
      tick();
    }

    async function deliverMockChunk(text, bulletList) {
      const chunk = reactive({
        id: DB.uuid(),
        sessionId: currentSession.value.id,
        projectId: currentSession.value.projectId,
        idx: chunks.length,
        time: Date.now() - sessionStart.value,
        transcript: '',
        bullets: [],
        status: 'streaming',
        audioMime: 'mock/none',
        audioBlob: null,
        durationMs: settings.chunkSeconds * 1000,
        createdAt: Date.now(),
      });
      chunks.push(chunk);

      await typeOut(text, (current) => { chunk.transcript = current; }, 14);

      const fullRecap = bulletList.map(b => `- ${b}`).join('\n');
      let buf = '';
      await typeOut(fullRecap, (_c, delta) => { buf += delta; updateBullets(chunk, buf); }, 16);

      chunk.bullets = chunk.bullets.map(b => b.trim()).filter(Boolean);
      chunk.status = 'done';
      try { await DB.putChunk(toPlain(chunk)); } catch {}
    }

    function typeOut(text, onProgress, msPerChar) {
      return new Promise((resolve) => {
        let i = 0;
        const step = () => {
          if (!recording.value) { resolve(); return; }
          const next = Math.min(text.length, i + 1 + Math.floor(Math.random() * 3));
          const delta = text.slice(i, next);
          i = next;
          onProgress(text.slice(0, i), delta);
          if (i >= text.length) resolve();
          else setTimeout(step, msPerChar + Math.random() * msPerChar);
        };
        step();
      });
    }

    // ---------- Derived ----------
    // In rewrite mode the LATEST chunk's bullets ARE the full current recap.
    // We expose:
    //   • liveRecap         — the canonical current recap (for copy/export)
    //   • recapReversed     — every chunk newest-first, for the historical UI
    //   • latestRecapChunkId — id of the most recent chunk with bullets, for the
    //     UI to flag as "current" (others fade)
    const recapReversed = computed(() => [...chunks].reverse());
    const latestRecapChunkId = computed(() => {
      for (let i = chunks.length - 1; i >= 0; i--) {
        if (chunks[i].bullets && chunks[i].bullets.length) return chunks[i].id;
      }
      return null;
    });
    const liveRecap = computed(() => {
      for (let i = chunks.length - 1; i >= 0; i--) {
        if (chunks[i].bullets && chunks[i].bullets.length) return chunks[i].bullets;
      }
      return [];
    });
    const liveRecapStreaming = computed(() => {
      const last = chunks[chunks.length - 1];
      return !!(last && last.status === 'streaming');
    });
    const liveRecapUpdatedAt = computed(() => {
      for (let i = chunks.length - 1; i >= 0; i--) {
        if (chunks[i].bullets && chunks[i].bullets.length) return chunks[i].time;
      }
      return null;
    });
    const liveRecapUpdatedWallTime = computed(() => {
      for (let i = chunks.length - 1; i >= 0; i--) {
        if (chunks[i].bullets && chunks[i].bullets.length) return chunks[i].createdAt;
      }
      return null;
    });
    const hasContent = computed(() => liveRecap.value.length > 0 || chunks.some(c => c.transcript));
    const hasAudio = computed(() => chunks.some(c => c.audioBlob));

    // ---------- Auto-scroll: transcript bottom, recap stays at top ----------
    const recapBodyRef = ref(null);
    const transcriptBodyRef = ref(null);
    watch(
      () => chunks.length + ':' + (chunks[chunks.length - 1]?.bullets?.length || 0)
        + ':' + (chunks[chunks.length - 1]?.transcript?.length || 0),
      async () => {
        await nextTick();
        if (transcriptBodyRef.value) transcriptBodyRef.value.scrollTop = transcriptBodyRef.value.scrollHeight;
        // Recap doesn't auto-scroll in rewrite mode — the user is reading
        // the same evolving list. They can scroll freely.
      }
    );

    // ---------- Copy / Save ----------
    async function copyRecap() {
      const text = liveRecap.value.map(b => `- ${b}`).join('\n');
      await copyToClipboard(text || '(empty)');
      flashToast('Recap copied');
    }
    async function copyTranscript() {
      const text = chunks
        .filter(c => c.transcript && c.transcript !== '[silence]')
        .map(c => `[${formatTime(c.time)}] ${c.transcript}`)
        .join('\n');
      await copyToClipboard(text || '(empty)');
      flashToast('Transcript copied');
    }
    async function copyToClipboard(text) {
      try { await navigator.clipboard.writeText(text); }
      catch {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch {}
        ta.remove();
      }
    }
    function saveMarkdown() {
      const md = buildMarkdown();
      const blob = new Blob([md], { type: 'text/markdown' });
      triggerDownload(blob, `recap-${stamp()}.md`);
    }
    async function saveAudio() {
      if (!chunks.length) { flashToast('No audio to download'); return; }
      // Load chunks from DB to get full audio blobs (in case we restored an old session)
      const fresh = await DB.getChunks(currentSession.value.id);
      const blobs = fresh.map(c => c.audioBlob).filter(Boolean);
      if (!blobs.length) { flashToast('No audio to download'); return; }
      const merged = await AudioUtils.concatWavBlobs(blobs, SAMPLE_RATE);
      if (!merged) { flashToast('No audio to download'); return; }
      triggerDownload(merged, `recap-${stamp()}.wav`);
      flashToast('Audio downloaded');
    }
    function triggerDownload(blob, filename) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    function stamp() {
      return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    }
    function buildMarkdown() {
      let out = `# Live recap — ${new Date().toLocaleString()}\n`;
      out += `_Project: ${currentProject.value?.name || 'Default'}_\n\n`;
      if (contextPrompt.value) out += `**Context:** ${contextPrompt.value}\n\n`;
      out += `## Recap\n\n`;
      for (const b of liveRecap.value) out += `- ${b}\n`;
      out += `\n## Transcript\n\n`;
      for (const c of chunks) {
        if (c.transcript && c.transcript !== '[silence]') {
          out += `**${formatTime(c.time)}** — ${c.transcript}\n\n`;
        }
      }
      return out;
    }

    let toastTimer = null;
    function flashToast(msg) {
      toast.value = msg;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.value = ''; }, 1800);
    }

    // ---------- Keyboard ----------
    function onKey(e) {
      const tag = (e.target && e.target.tagName) || '';
      if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'TEXTAREA' && !showSettings.value) {
        e.preventDefault();
        toggleRecording();
      }
      if (e.key === 'Escape') {
        if (showSettings.value) showSettings.value = false;
        else if (renamingProjectId.value) renamingProjectId.value = null;
        else if (newProjectInputVisible.value) { newProjectInputVisible.value = false; newProjectDraft.value = ''; }
      }
    }

    // ---------- Status pill ----------
    const statusLabel = computed(() => {
      if (settings.mockMode) return recording.value ? 'Mock · streaming' : 'Mock mode';
      if (recording.value) return 'Listening';
      return chunks.length ? 'Paused' : 'Idle';
    });
    const statusClass = computed(() => {
      if (settings.mockMode) return 'mock';
      if (recording.value) return 'connected';
      return '';
    });

    // ---------- VU ----------
    function vuBarStyle(i) {
      const phase = (Math.sin((i + 1) * 1.7) + 1) / 2;
      const scaled = Math.max(0.08, Math.min(1, audioLevel.value * (0.55 + phase * 0.85)));
      return { transform: `scaleY(${scaled.toFixed(3)})` };
    }

    // ---------- Audio file upload (debug) ----------
    function triggerAudioUpload() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*';
      input.onchange = handleAudioUpload;
      input.click();
    }

    async function handleAudioUpload(event) {
      const file = event.target.files[0];
      if (!file) return;
      error.value = '';
      try {
        if (!currentSession.value) {
          currentSession.value = await DB.createSession(currentProjectId.value, { contextPrompt: contextPrompt.value });
        }

        // Decode to PCM at target sample rate (browser resamples for us)
        const arrayBuffer = await file.arrayBuffer();
        const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
        let audioBuffer;
        try { audioBuffer = await audioCtx.decodeAudioData(arrayBuffer); }
        finally { await audioCtx.close(); }

        // Downmix to mono
        const pcm = new Float32Array(audioBuffer.length);
        for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
          const channelData = audioBuffer.getChannelData(ch);
          for (let i = 0; i < pcm.length; i++) pcm[i] += channelData[i] / audioBuffer.numberOfChannels;
        }

        // Set session timer from last chunk so timestamps continue correctly
        const last = chunks[chunks.length - 1];
        const cumulative = last ? (last.time + (last.durationMs || settings.chunkSeconds * 1000)) : 0;
        sessionStart.value = Date.now() - cumulative;

        // Slice into chunks and process strictly one at a time (await each LLM call)
        const chunkSamples = SAMPLE_RATE * Math.max(1, settings.chunkSeconds);
        const overlapSamples = Math.min(
          Math.max(0, Math.floor((settings.chunkOverlapMs / 1000) * SAMPLE_RATE)),
          chunkSamples - 1
        );
        const stride = chunkSamples - overlapSamples;
        let offset = 0;
        let count = 0;
        while (offset < pcm.length) {
          const slice = pcm.slice(offset, offset + chunkSamples);
          if (slice.length < SAMPLE_RATE * 0.5) break; // skip < 0.5 s trailing sliver
          const durationMs = (slice.length / SAMPLE_RATE) * 1000;

          // Build and persist the chunk (same as processPcmChunk, but awaited fully)
          const wavBuf = AudioUtils.encodeWAV(slice, SAMPLE_RATE);
          const wavBlob = new Blob([wavBuf], { type: 'audio/wav' });
          const b64 = AudioUtils.arrayBufferToBase64(wavBuf);
          const chunk = reactive({
            id: DB.uuid(), sessionId: currentSession.value.id,
            projectId: currentSession.value.projectId,
            idx: chunks.length, time: Date.now() - sessionStart.value,
            transcript: '', bullets: [], status: 'streaming',
            audioMime: 'audio/wav', audioBlob: wavBlob,
            durationMs, llmDurationMs: null, createdAt: Date.now(),
          });
          chunks.push(chunk);
          audioCache.set(chunk.id, b64);
          trimAudioCache();
          try { await DB.putChunk(toPlain(chunk)); } catch (e) { console.warn('putChunk', e); }

          // Run LLM synchronously — wait for it to finish before next chunk
          await runLLM(chunk);

          offset += stride;
          count++;
        }
        flashToast(`Processed ${count} chunk${count !== 1 ? 's' : ''} from ${file.name}`);
      } catch (e) {
        error.value = `Upload failed: ${e.message}`;
      }
    }

    // ---------- Custom tooltip ----------
    const tooltip = reactive({ visible: false, text: '', x: 0, y: 0 });
    function showTooltip(e, text) {
      tooltip.text = text;
      tooltip.x = e.clientX + 14;
      tooltip.y = e.clientY + 18;
      tooltip.visible = true;
    }
    function moveTooltip(e) {
      if (!tooltip.visible) return;
      tooltip.x = e.clientX + 14;
      tooltip.y = e.clientY + 18;
    }
    function hideTooltip() { tooltip.visible = false; }
    function chunkTooltipText(chunk) {
      let text = formatWallTime(chunk.createdAt);
      if (chunk.llmDurationMs != null) text += `\nLLM: ${(chunk.llmDurationMs / 1000).toFixed(1)}s`;
      return text;
    }

    // ---------- Mini-markdown for bullets ----------
    // Supports **bold** only. Returns an array of segments for the template
    // to render as either <strong> or plain text (no v-html, so no XSS risk).
    function renderBullet(text) {
      const out = [];
      const re = /\*\*([^*\n]+?)\*\*/g;
      let last = 0, m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push({ b: false, t: text.slice(last, m.index) });
        out.push({ b: true, t: m[1] });
        last = m.index + m[0].length;
      }
      if (last < text.length) out.push({ b: false, t: text.slice(last) });
      return out.length ? out : [{ b: false, t: text }];
    }

    return {
      // projects
      projects, currentProject, currentProjectId,
      sidebarCollapsed, newProjectInputVisible, newProjectDraft,
      renamingProjectId, projectNameDraft,
      switchProject, createProjectAction, beginRenameProject, commitRenameProject,
      cancelRenameProject, deleteProject,
      // session data
      currentSession, chunks, recapReversed, latestRecapChunkId,
      liveRecap, liveRecapStreaming, liveRecapUpdatedAt, liveRecapUpdatedWallTime,
      hasContent, hasAudio,
      // ui
      settings, showSettings, promptCollapsed, contextPrompt,
      recording, error, toast, audioLevel, sourceLangGuess,
      elapsedDisplay, statusLabel, statusClass,
      recapBodyRef, transcriptBodyRef,
      // actions
      toggleRecording, newSession, copyRecap, copyTranscript, saveMarkdown, saveAudio,
      resetSettings, resetSystemPrompt, flashToast, triggerAudioUpload,
      // helpers
      formatTime, formatWallTime, vuBarStyle, renderBullet,
      tooltip, showTooltip, moveTooltip, hideTooltip, chunkTooltipText,
    };
  },
  template: '#app-template',
})
  .directive('focus', {
    mounted(el) { el.focus(); if (el.select) el.select(); },
  })
  .mount('#app');
