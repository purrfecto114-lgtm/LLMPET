'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { RENDER_STATE_WORDS } = require('../shared/states');

const CATALOG_PATH = path.join(__dirname, '..', 'assets', 'memes', 'catalog.json');
const MEME_ROOT = path.dirname(CATALOG_PATH);
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const MEDIA_RE = /^[a-z0-9][a-z0-9._/-]{1,180}$/i;
const MAX_PROMPT_CHARS = 12000;
const MAX_GIF_BYTES = 30 * 1024 * 1024;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const REACTION_STATES = new Set(RENDER_STATE_WORDS);
const LICENSE_STATUSES = new Set(['cleared', 'public-domain', 'unverified']);
// A submitted prompt can briefly disappear from the session watcher while the
// desktop client resumes it. `idle` / `sleeping` bridge that observation gap
// visually without changing the semantic state. Human-action states such as
// waiting/needsinput/error/done remain excluded so they can interrupt at once.
const WORK_REACTION_STATES = new Set([
  'idle', 'sleeping', 'thinking', 'working', 'juggling', 'sweeping', 'loafing',
]);
// Locales an item may carry overrides for. The base fields stay Chinese so an
// item without `i18n` still works — and so the zh build is never a lookup.
const TRANSLATED_LANGS = ['en', 'ja'];

function safeMediaPath(value, memeRoot = MEME_ROOT) {
  if (typeof value !== 'string' || !MEDIA_RE.test(value) || value.includes('..')) return null;
  const full = path.resolve(memeRoot, value);
  return full.startsWith(memeRoot + path.sep) ? full : null;
}

function validateMediaFile(id, file, kind) {
  const st = fs.statSync(file);
  const cap = kind === 'gif' ? MAX_GIF_BYTES : MAX_AUDIO_BYTES;
  if (!st.isFile() || st.size <= 0 || st.size > cap) {
    throw new Error(`${id}: ${kind} 文件为空或超过 ${Math.round(cap / 1024 / 1024)}MB`);
  }
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(10);
  try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
  if (kind === 'gif' && !/^GIF8[79]a$/.test(head.subarray(0, 6).toString('ascii'))) {
    throw new Error(`${id}: visual.gif 不是有效 GIF`);
  }
  const looksMp3 = head.subarray(0, 3).toString('ascii') === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
  if (kind === 'audio' && !looksMp3) throw new Error(`${id}: voice.mp3 不是有效 MP3`);
}

function validateProvenance(id, raw) {
  if (!raw || typeof raw !== 'object') throw new Error(`${id}: 缺少 provenance 素材来源信息`);
  const license = String(raw.license || '');
  if (!LICENSE_STATUSES.has(license)) throw new Error(`${id}: provenance.license 不合法`);
  const sourceUrl = raw.sourceUrl == null ? null : String(raw.sourceUrl).slice(0, 500);
  if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) throw new Error(`${id}: provenance.sourceUrl 必须是 http(s) URL`);
  return Object.freeze({
    origin: String(raw.origin || 'unknown').slice(0, 80),
    creator: String(raw.creator || 'unknown').slice(0, 120),
    sourceUrl,
    license,
    commercialUse: raw.commercialUse === true,
    notes: String(raw.notes || '').slice(0, 500),
  });
}

// Per-locale overrides. Every field is optional and falls back to the Chinese
// base, so a partially translated item is still a valid item — but a present
// prompt override gets the same length ceiling as the base prompt.
function validateI18n(id, raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return Object.freeze(out);
  for (const lang of TRANSLATED_LANGS) {
    const entry = raw[lang];
    if (!entry || typeof entry !== 'object') continue;
    if (entry.promptText !== undefined
      && (typeof entry.promptText !== 'string' || !entry.promptText.trim() || entry.promptText.length > MAX_PROMPT_CHARS)) {
      throw new Error(`${id}: i18n.${lang}.promptText 为空或过长`);
    }
    out[lang] = Object.freeze({
      label: entry.label === undefined ? null : String(entry.label).slice(0, 80),
      description: entry.description === undefined ? null : String(entry.description).slice(0, 180),
      reactionLabel: entry.reactionLabel === undefined ? null : String(entry.reactionLabel).slice(0, 80),
      promptText: entry.promptText === undefined ? null : entry.promptText.trim(),
    });
  }
  return Object.freeze(out);
}

function validateWorkReaction(id, raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || !REACTION_STATES.has(raw.visualState)) {
    throw new Error(`${id}: reaction.work.visualState 不合法`);
  }
  const activeStates = Array.isArray(raw.activeStates) ? raw.activeStates : [...WORK_REACTION_STATES];
  if (!activeStates.length || activeStates.some((state) => !WORK_REACTION_STATES.has(state))) {
    throw new Error(`${id}: reaction.work.activeStates 包含不可覆盖状态`);
  }
  return Object.freeze({
    durationMs: Math.max(1000, Math.min(120000, Number(raw.durationMs) || 30000)),
    visualState: raw.visualState,
    activeStates: Object.freeze([...new Set(activeStates)]),
  });
}

function validateItem(raw, memeRoot = MEME_ROOT) {
  if (!raw || typeof raw !== 'object' || !ID_RE.test(raw.id || '')) {
    throw new Error('表情包 id 不合法');
  }
  const itemDir = `${raw.id}/`;
  if (!raw.media || typeof raw.media.gif !== 'string' || typeof raw.media.audio !== 'string'
    || !raw.media.gif.startsWith(itemDir) || !raw.media.audio.startsWith(itemDir)) {
    throw new Error(`${raw.id}: 媒体文件必须放在 assets/memes/${raw.id}/ 独立目录`);
  }
  const gif = safeMediaPath(raw.media && raw.media.gif, memeRoot);
  const audio = safeMediaPath(raw.media && raw.media.audio, memeRoot);
  const prompt = raw.prompt && raw.prompt.text;
  if (!gif || !audio) throw new Error(`${raw.id}: 媒体路径不合法`);
  if (!fs.existsSync(gif) || !fs.existsSync(audio)) throw new Error(`${raw.id}: 媒体文件不存在`);
  validateMediaFile(raw.id, gif, 'gif');
  validateMediaFile(raw.id, audio, 'audio');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`${raw.id}: prompt 为空或过长`);
  }
  const reaction = raw.reaction;
  if (!reaction || typeof reaction !== 'object' || !REACTION_STATES.has(reaction.state)) {
    throw new Error(`${raw.id}: reaction.state 不合法`);
  }
  return Object.freeze({
    id: raw.id,
    label: String(raw.label || raw.id).slice(0, 80),
    description: String(raw.description || '').slice(0, 180),
    i18n: validateI18n(raw.id, raw.i18n),
    category: String(raw.category || 'general').slice(0, 64),
    tags: Object.freeze((Array.isArray(raw.tags) ? raw.tags : []).slice(0, 12).map((v) => String(v).slice(0, 32))),
    provenance: validateProvenance(raw.id, raw.provenance),
    media: Object.freeze({
      gif: raw.media.gif,
      audio: raw.media.audio,
      durationMs: Math.max(800, Math.min(30000, Number(raw.media.durationMs) || 3000)),
      placement: raw.media.placement === 'pet-left' ? 'pet-left' : 'pet-right',
    }),
    prompt: Object.freeze({
      version: Math.max(1, Math.floor(Number(raw.prompt.version) || 1)),
      text: prompt.trim(),
    }),
    reaction: Object.freeze({
      state: reaction.state,
      durationMs: Math.max(800, Math.min(30000, Number(reaction.durationMs) || 3000)),
      label: String(reaction.label || '').slice(0, 80),
      work: validateWorkReaction(raw.id, reaction.work),
    }),
  });
}

function loadCatalog(catalogPath = CATALOG_PATH) {
  const raw = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  if (!raw || raw.schemaVersion !== 2 || !Array.isArray(raw.items)) {
    throw new Error('表情包目录 schemaVersion 必须为 2');
  }
  const seen = new Set();
  const memeRoot = path.dirname(catalogPath);
  const items = raw.items.map((item) => validateItem(item, memeRoot));
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`表情包 id 重复: ${item.id}`);
    seen.add(item.id);
  }
  return Object.freeze({ schemaVersion: 2, items: Object.freeze(items) });
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function statStamp(file) {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${Math.trunc(st.mtimeMs)}:${Math.trunc(st.ctimeMs)}`;
  } catch {
    return 'missing';
  }
}

// Include every file below assets/memes so adding a new item directory is also
// noticed. This is metadata-only (no GIF/MP3 bytes are read) and the catalog is
// tiny, so polling is cheap and works on macOS, Windows and older Node/Linux
// versions where recursive fs.watch support differs.
function resourceStamp(memeRoot) {
  const rows = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      rows.push(`${path.relative(memeRoot, dir)}:missing`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(memeRoot, full);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) rows.push(`${rel}:${statStamp(full)}`);
    }
  };
  visit(memeRoot);
  return rows.join('|');
}

const mediaDigestCache = new Map();
function fileDigest(file) {
  const stamp = statStamp(file);
  const hit = mediaDigestCache.get(file);
  if (hit && hit.stamp === stamp) return hit.digest;
  const value = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
  mediaDigestCache.set(file, { stamp, digest: value });
  return value;
}

function mediaVersion(item, memeRoot) {
  const gif = safeMediaPath(item.media.gif, memeRoot);
  const audio = safeMediaPath(item.media.audio, memeRoot);
  return digest(`${item.media.gif}:${fileDigest(gif)}|${item.media.audio}:${fileDigest(audio)}`);
}

function createCatalogStore(options = {}) {
  const catalogPath = options.catalogPath || CATALOG_PATH;
  const memeRoot = path.dirname(catalogPath);
  const defaultPollMs = Math.max(100, Number(options.pollMs) || 750);
  let catalog = loadCatalog(catalogPath);
  let observedStamp = resourceStamp(memeRoot);
  let revision = digest(observedStamp);

  // Reload on demand as well as from the watcher. Opening the meme page after a
  // resource edit therefore sees the change even if the polling tick has not
  // fired yet. A half-written/invalid catalog keeps the last known-good copy.
  function refresh() {
    const nextStamp = resourceStamp(memeRoot);
    if (nextStamp === observedStamp) return { catalog, revision, changed: false, error: null };
    observedStamp = nextStamp;
    try {
      catalog = loadCatalog(catalogPath);
      revision = digest(nextStamp);
      return { catalog, revision, changed: true, error: null };
    } catch (error) {
      return { catalog, revision, changed: false, error };
    }
  }

  function localizedCatalog(lang = 'zh') {
    refresh();
    return {
      schemaVersion: catalog.schemaVersion,
      revision,
      items: catalog.items.map((raw) => {
        const item = localize(raw, lang);
        return {
          id: item.id,
          label: item.label,
          description: item.description,
          category: item.category,
          tags: [...item.tags],
          media: { ...item.media, version: mediaVersion(item, memeRoot) },
          reaction: { ...item.reaction },
          promptVersion: item.prompt.version,
        };
      }),
    };
  }

  function memeById(id, lang = 'zh') {
    refresh();
    const item = catalog.items.find((entry) => entry.id === id);
    return item ? localize(item, lang) : null;
  }

  function watch(watchOptions = {}) {
    const pollMs = Math.max(100, Number(watchOptions.pollMs) || defaultPollMs);
    let lastErrorStamp = '';
    const timer = setInterval(() => {
      const result = refresh();
      if (result.changed) {
        lastErrorStamp = '';
        if (typeof watchOptions.onChange === 'function') watchOptions.onChange(localizedCatalog());
      } else if (result.error) {
        const key = `${observedStamp}:${result.error.message}`;
        if (key !== lastErrorStamp && typeof watchOptions.onError === 'function') {
          lastErrorStamp = key;
          watchOptions.onError(result.error);
        }
      }
    }, pollMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }

  return Object.freeze({
    refresh,
    publicCatalog: localizedCatalog,
    getMeme: memeById,
    watch,
  });
}

// Resolve one item's user-visible copy for `lang`, falling back field by field
// to the Chinese base so a missing translation degrades to zh, never to blank.
function localize(item, lang) {
  const tr = (item.i18n && item.i18n[lang]) || null;
  if (!tr) return item;
  return {
    ...item,
    label: tr.label || item.label,
    description: tr.description || item.description,
    reaction: { ...item.reaction, label: tr.reactionLabel || item.reaction.label },
    prompt: { ...item.prompt, text: tr.promptText || item.prompt.text },
  };
}

const defaultStore = createCatalogStore();

const publicCatalog = (lang = 'zh') => defaultStore.publicCatalog(lang);
const getMeme = (id, lang = 'zh') => defaultStore.getMeme(id, lang);
const watchCatalog = (options = {}) => defaultStore.watch(options);

module.exports = {
  CATALOG_PATH,
  MAX_PROMPT_CHARS,
  loadCatalog,
  createCatalogStore,
  publicCatalog,
  getMeme,
  watchCatalog,
};
