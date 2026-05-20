/* ==========================================================================
   db.js — IndexedDB wrapper for Live Recap
   
   Schema is designed to support multiple "projects" in the future (e.g.
   conferences, classes, meetings), each with its own settings and a list
   of recording sessions. For now there is one implicit project ('default').

   Stores:
     projects { id, name, createdAt, updatedAt, color?, icon? }
     sessions { id, projectId, name?, contextPrompt, startedAt, endedAt, model? }
       indexes:  by-project (projectId)
                 by-started (startedAt)
                 by-project-started ([projectId, startedAt])
     chunks   { id, sessionId, projectId, idx, time, transcript, bullets,
                audioMime, audioBlob?, createdAt }
       indexes:  by-session (sessionId)
                 by-session-idx ([sessionId, idx])

   Audio blobs are stored per-chunk so that, in the future, a session can
   be replayed or re-summarized with a different model.
   ========================================================================== */

const DB_NAME = 'liveRecap';
const DB_VERSION = 1;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('projects')) {
        const s = db.createObjectStore('projects', { keyPath: 'id' });
        s.createIndex('by-updated', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('by-project', 'projectId');
        s.createIndex('by-started', 'startedAt');
        s.createIndex('by-project-started', ['projectId', 'startedAt']);
      }
      if (!db.objectStoreNames.contains('chunks')) {
        const s = db.createObjectStore('chunks', { keyPath: 'id' });
        s.createIndex('by-session', 'sessionId');
        s.createIndex('by-session-idx', ['sessionId', 'idx']);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function _store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

function uuid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---------------------------------------------------------------- Projects
async function ensureDefaultProject() {
  const s = await _store('projects', 'readwrite');
  let p = await promisify(s.get('default'));
  if (!p) {
    p = {
      id: 'default',
      name: 'Default',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await promisify(s.put(p));
  }
  return p;
}

async function getProject(id) {
  const s = await _store('projects');
  return promisify(s.get(id));
}

async function createProject(name) {
  const p = {
    id: uuid(),
    name: (name || 'Untitled').trim() || 'Untitled',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const s = await _store('projects', 'readwrite');
  await promisify(s.put(p));
  return p;
}

async function listProjects() {
  const s = await _store('projects');
  const all = await promisify(s.getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function updateProject(p) {
  p.updatedAt = Date.now();
  const s = await _store('projects', 'readwrite');
  await promisify(s.put(p));
  return p;
}

async function deleteProject(projectId) {
  // Delete project + all its sessions + chunks.
  const sessions = await listSessions(projectId);
  for (const s of sessions) await deleteSession(s.id);
  const ps = await _store('projects', 'readwrite');
  await promisify(ps.delete(projectId));
}

// ---------------------------------------------------------------- Sessions
async function createSession(projectId, init = {}) {
  const s = {
    id: uuid(),
    projectId,
    name: init.name || null,
    contextPrompt: init.contextPrompt || '',
    model: init.model || null,
    startedAt: Date.now(),
    endedAt: null,
  };
  const store = await _store('sessions', 'readwrite');
  await promisify(store.put(s));
  return s;
}

async function updateSession(session) {
  const store = await _store('sessions', 'readwrite');
  await promisify(store.put(session));
  return session;
}

async function endSession(sessionId) {
  const store = await _store('sessions', 'readwrite');
  const s = await promisify(store.get(sessionId));
  if (!s) return null;
  s.endedAt = Date.now();
  await promisify(store.put(s));
  return s;
}

async function listSessions(projectId) {
  const store = await _store('sessions');
  const idx = store.index('by-project');
  const all = await promisify(idx.getAll(projectId));
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

async function getLatestSession(projectId) {
  const all = await listSessions(projectId);
  return all[0] || null;
}

async function deleteSession(sessionId) {
  // Delete session + all its chunks.
  const db = await openDB();
  const t = db.transaction(['sessions', 'chunks'], 'readwrite');
  const ss = t.objectStore('sessions');
  const cs = t.objectStore('chunks');
  ss.delete(sessionId);
  const cIdx = cs.index('by-session');
  const reqAll = cIdx.getAllKeys(sessionId);
  await new Promise((resolve, reject) => {
    reqAll.onsuccess = () => {
      for (const k of reqAll.result) cs.delete(k);
      resolve();
    };
    reqAll.onerror = () => reject(reqAll.error);
  });
  await new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// ------------------------------------------------------------------ Chunks
async function putChunk(c) {
  const s = await _store('chunks', 'readwrite');
  await promisify(s.put(c));
  return c;
}

async function getChunks(sessionId) {
  const s = await _store('chunks');
  const idx = s.index('by-session');
  const all = await promisify(idx.getAll(sessionId));
  return all.sort((a, b) => a.idx - b.idx);
}

async function deleteChunksForSession(sessionId) {
  const s = await _store('chunks', 'readwrite');
  const idx = s.index('by-session');
  const keys = await promisify(idx.getAllKeys(sessionId));
  for (const k of keys) await promisify(s.delete(k));
}

// ------------------------------------------------------------------ Public
window.DB = {
  uuid,
  ensureDefaultProject,
  getProject,
  createProject,
  listProjects,
  updateProject,
  deleteProject,
  createSession,
  updateSession,
  endSession,
  listSessions,
  getLatestSession,
  deleteSession,
  putChunk,
  getChunks,
  deleteChunksForSession,
};
