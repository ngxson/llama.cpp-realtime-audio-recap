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
  chunkSeconds: 10,
  chunkOverlapMs: 1000,
  windowChunks: 2,           // audio window: chunks sent as audio in each call
  recapWindow: 8,            // recap window: prior chunks whose bullets/transcripts are sent as text context
  maxRecapBullets: 5,        // hard cap on the recap's bullet count — prompt asks the model to compress when exceeded
  recapLanguage: 'English',
  systemPrompt:
    "⚠ HARD LIMIT: the recap must contain AT MOST {{MAX_BULLETS}} bullets at all " +
    "times. Exceeding this is a FAILURE. The count INCLUDES bold bullets. " +
    "Re-check the count before you emit each output.\n\n" +
    "You maintain a concise running recap of a live talk for someone following " +
    "a foreign-language speaker. Each turn you receive the latest ~10 s of " +
    "audio (may overlap the previous chunk by a few hundred ms) and the prior " +
    "recap as text.\n\n" +
    "Output format:\n" +
    "<verbatim transcript of the new audio in the source language; " +
    "[silence] if non-speech>\n" +
    RECAP_MARKER + "\n" +
    "<the updated recap, in {{LANG}}, ≤ {{MAX_BULLETS}} bullets>\n\n" +
    "EDIT, DON'T REWRITE. You are a strict editor. Each turn you DROP, UPDATE, " +
    "and ADD — do not simply copy the prior recap.\n\n" +
    "• DROP — aggressively. When the prior recap is at or near the cap, you " +
    "MUST keep AT MOST HALF of the prior NON-BOLD bullets. Drop bullets that " +
    "are no longer the most relevant, that have been superseded by later " +
    "information, or that are minor details. **Bold** bullets are PINNED: " +
    "never drop them, only shorten their wording if needed.\n" +
    "• UPDATE — refine bullets when the new audio adds detail, nuance, or " +
    "correction. Merge any pair of related bullets into one denser bullet. " +
    "Deduplicate.\n" +
    "• ADD — include 0–3 new bullets from the latest audio. If adding would " +
    "exceed the cap, drop existing non-bold bullets to make room.\n\n" +
    "Bullet quality:\n" +
    "• Each bullet is one substantive, self-contained idea.\n" +
    "• Preserve concrete numbers, names, definitions, terms, quotes.\n" +
    "• NO meta-commentary (\"the speaker mentions…\", \"the speaker also discusses…\", " +
    "\"the speaker references…\"). State the content directly.\n" +
    "• For the 1–2 most important takeaways, wrap the bullet (or its key " +
    "phrase) in **double-asterisks**. Sparingly.\n" +
    "• Bullets in {{LANG}}, '- '-prefixed, one per line.\n\n" +
    "GOOD bullet (merged, substantive):\n" +
    "- **Method X cuts inference latency 3.2× vs baseline; 1.4-pt accuracy drop recoverable in ~200 fine-tuning steps.**\n\n" +
    "BAD (NEVER — fragmented, meta, vague):\n" +
    "- The speaker mentions method X.\n" +
    "- This method is faster.\n" +
    "- The speaker also discusses accuracy.\n\n" +
    "⚠ FINAL CHECK before you finish: count your bullets. If > {{MAX_BULLETS}}, " +
    "go back and DROP non-bold bullets until you are at or under the cap. " +
    "Hard limit: {{MAX_BULLETS}}.",
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
    }

    // ---------- Continuous audio capture ----------
    async function startRealCapture() {
      capture = new AudioUtils.ContinuousCapture({
        sampleRate: SAMPLE_RATE,
        chunkSeconds: Math.max(1, Number(settings.chunkSeconds) || 10),
        overlapMs: Math.max(0, Number(settings.chunkOverlapMs) || 0),
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
        createdAt: Date.now(),
      });
      chunks.push(chunk);
      audioCache.set(chunk.id, b64);
      trimAudioCache();

      // Persist immediately so the audio survives even if the API fails
      try { await DB.putChunk(toPlain(chunk)); } catch (e) { console.warn('putChunk', e); }

      try {
        await callLLM(chunk);
        chunk.status = 'done';
      } catch (e) {
        chunk.status = 'error';
        if (!chunk.transcript) chunk.transcript = `[error: ${e.message}]`;
        error.value = `Recap failed: ${e.message}`;
      } finally {
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
        durationMs: chunk.durationMs, createdAt: chunk.createdAt,
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
    //   • older prior transcripts (chunks within recap window but outside
    //     audio window) as plain text grounding,
    //   • the latest audio chunk.
    // The model returns the *complete updated recap*.
    async function callLLM(latestChunk) {
      const N = Math.max(1, Number(settings.windowChunks) || 3);
      const M = Math.max(N, Number(settings.recapWindow) || N);
      const auWindow = chunks.slice(-N);
      const priorAudio = auWindow.slice(0, -1);
      const auStart = Math.max(0, chunks.length - N);
      const txStart = Math.max(0, chunks.length - M);
      const textOnlyPrior = chunks.slice(txStart, auStart);

      // Running recap = bullets of the most recent prior chunk that has any.
      let priorRecap = [];
      for (let i = chunks.length - 2; i >= 0; i--) {
        if (chunks[i].bullets && chunks[i].bullets.length) { priorRecap = chunks[i].bullets; break; }
      }

      const sys = settings.systemPrompt
        .replace(/\{\{LANG\}\}/g, settings.recapLanguage)
        .replace(/\{\{MAX_BULLETS\}\}/g, String(settings.maxRecapBullets || 10));
      const messages = [{ role: 'system', content: sys }];

      for (const c of priorAudio) {
        const b64 = audioCache.get(c.id);
        const audioPart = b64 ? [{ type: 'input_audio', input_audio: { data: b64, format: 'wav' } }] : [];
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: 'Prior audio segment.' }, ...audioPart],
        });
        // Send only the transcript in the assistant turn; the canonical recap
        // is delivered in the final user turn below so the model doesn't think
        // it has to reproduce per-chunk bullets.
        messages.push({ role: 'assistant', content: c.transcript || '[silence]' });
      }

      if (priorAudio.length > 0) {
        messages.push({
          role: 'user',
          content: 'Above are past audio segments. Below is the new audio with a small overlap:',
        });
        messages.push({ role: 'assistant', content: 'Understood.' });
      }

      let userText = '';
      if (contextPrompt.value) userText += `Talk context (user-provided): ${contextPrompt.value}\n\n`;
      if (textOnlyPrior.length) {
        userText += `Earlier transcripts (text only — no audio for these):\n`;
        for (const c of textOnlyPrior) {
          const t = (c.transcript || '[silence]').replace(/\s+/g, ' ').trim();
          userText += `[${formatTime(c.time)}] ${t}\n`;
        }
        userText += `\n`;
      }
      const maxBullets = Math.max(3, Number(settings.maxRecapBullets) || 10);
      const priorCount = priorRecap.length;
      const nearCap = priorCount >= Math.ceil(maxBullets * 0.7);
      const recapHeader = priorCount
        ? `Current recap (${priorCount}/${maxBullets} bullets${nearCap ? ' — NEAR/AT CAP, prune aggressively before adding' : ''}):`
        : 'Current recap: (none yet)';
      userText += priorCount
        ? `${recapHeader}\n${priorRecap.map(b => `- ${b}`).join('\n')}\n\n`
        : `${recapHeader}\n\n`;
      userText += `Latest audio segment follows. Output the verbatim transcript, then ${RECAP_MARKER} on its own line, then the updated recap in ${settings.recapLanguage}. Hard limit: ≤ ${maxBullets} bullets. DROP non-bold bullets aggressively before adding new ones. Never drop **bold** bullets.`;

      const latestB64 = audioCache.get(latestChunk.id);
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: userText },
          ...(latestB64 ? [{ type: 'input_audio', input_audio: { data: latestB64, format: 'wav' } }] : []),
        ],
      });

      await streamChat({ messages, stream: true }, makeStreamHandler(latestChunk));
    }

    async function streamChat(payload, onDelta) {
      const headers = { 'Content-Type': 'application/json' };
      if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;
      const body = JSON.stringify({
        model: settings.llmModel || 'local',
        temperature: 0.2,
        ...payload,
      });
      const res = await fetch(settings.llmUrl, { method: 'POST', headers, body });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
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
    }

    // ---------- Stream parser ----------
    function makeStreamHandler(chunk) {
      let phase = 'transcript';
      let transcriptBuf = '';
      let recapBuf = '';
      const M = RECAP_MARKER;
      return function onDelta(delta) {
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
      resetSettings, resetSystemPrompt, flashToast,
      // helpers
      formatTime, formatWallTime, vuBarStyle, renderBullet,
    };
  },
  template: '#app-template',
})
  .directive('focus', {
    mounted(el) { el.focus(); if (el.select) el.select(); },
  })
  .mount('#app');
