/* Sermon Library: offline sermon player with progress, notes and listening stats.
   Everything is stored on the device in IndexedDB. */
'use strict';

// ---------- Storage ----------
const DB_NAME = 'sermon-library';
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('kv');
      d.createObjectStore('audio');
      d.createObjectStore('progress');
      d.createObjectStore('notes', { keyPath: 'nid', autoIncrement: true });
      d.createObjectStore('log');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const put = (store, val, key) => tx(store, 'readwrite', s => { s.put(val, key); });
const del = (store, key) => tx(store, 'readwrite', s => { s.delete(key); });
const get = (store, key) => tx(store, 'readonly', s => req(s.get(key)));
async function getAll(store) {
  return tx(store, 'readonly', async s => {
    const [keys, vals] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
    return keys.map((k, i) => [k, vals[i]]);
  });
}

// ---------- State ----------
const S = {
  items: [], byId: new Map(),   // catalog
  overrides: {},                // id -> {preacher,title,series,topic}
  onPhone: new Set(),           // ids with audio stored
  progress: {},                 // id -> {pos,dur,done,at}
  notes: [],                    // {nid,sid,t,text,at}
  log: {},                      // "YYYY-MM-DDTHH|id" -> seconds
  want: new Set(),              // "put on phone" list
  settings: { speed: 1, autoNext: true, carBookmark: true },
  current: null,                // id playing
  tab: 'listening', prevTab: 'listening', nav: [],  // library navigation stack
  libMode: 'preachers', query: '',
  statRange: 'week', statOffset: 0,
};
const TOPICS = ['Faith', 'Healing', 'Prayer', 'Holy Spirit', 'Finances', 'Marriage & Family', 'Authority & Warfare',
  'Ministry & Leadership', 'Bible Study', 'Heaven & Eternity', 'Christian Living'];
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const audio = $('#audio');

function item(id) {
  const base = S.byId.get(id);
  if (!base) return null;
  const o = S.overrides[id];
  return o ? { ...base, ...o } : base;
}
const allItems = () => S.items.map(i => item(i.id));

// ---------- Artwork: initials on a gradient picked from the name ----------
function hashHue(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
function grad(name) {
  const h = hashHue(name), a = 18 + (h % 32), b = (h >> 8) % 360;  // warm gold-amber base, varied partner hue
  return `linear-gradient(140deg, hsl(${a} 62% 46%), hsl(${b} 38% 24%) 70%, hsl(${b} 40% 14%))`;
}
function initials(name) {
  const w = String(name || '?').replace(/\[.*?\]|\(.*?\)/g, '').replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter(x => x && !/^(and|of|the|jr|sr)$/i.test(x));
  if (!w.length) return '♪';
  return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[w.length - 1][0]).toUpperCase();
}
const tile = (name, text, cls = '') => `<span class="av ${cls}" style="--g:${grad(name)}">${esc(text ?? initials(name))}</span>`;

// ---------- Formatting ----------
function clock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function dur(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return sec ? `${sec}s` : '0m';
  const h = Math.floor(sec / 3600), m = Math.round(sec % 3600 / 60);
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hourKey = d => `${dayKey(d)}T${pad(d.getHours())}`;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, ms);
}
const icon = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z"/></svg>',
  back: '<svg viewBox="0 0 36 36"><path d="M9 11a11 11 0 1 1-2 9"/><path d="M9 4v7h7"/></svg>',
  fwd: '<svg viewBox="0 0 36 36"><path d="M27 11a11 11 0 1 0 2 9"/><path d="M27 4v7h-7"/></svg>',
};

// ---------- Load ----------
async function load() {
  db = await openDB();
  const [cat, ov, want, settings, last] = await Promise.all(['catalog', 'overrides', 'want', 'settings', 'last'].map(k => get('kv', k)));
  setCatalog(cat || { items: [] });
  S.overrides = ov || {};
  S.want = new Set(want || []);
  Object.assign(S.settings, settings || {});
  const keys = await tx('audio', 'readonly', s => req(s.getAllKeys()));
  S.onPhone = new Set(keys);
  for (const [k, v] of await getAll('progress')) S.progress[k] = v;
  S.notes = (await getAll('notes')).map(([, v]) => v);
  for (const [k, v] of await getAll('log')) S.log[k] = v;
  // Files added without a catalog entry
  const extra = await get('kv', 'extra') || [];
  for (const e of extra) if (!S.byId.has(e.id)) { S.items.push(e); S.byId.set(e.id, e); }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if (last && S.onPhone.has(last)) await loadTrack(last, false);
  if (!inProgress().length) S.tab = 'library';  // nothing to resume: open on the Library
  render();
}
function setCatalog(cat) {
  S.items = cat.items || [];
  S.byId = new Map(S.items.map(i => [i.id, i]));
}

// ---------- Navigation ----------
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  if (S.tab === b.dataset.tab && b.dataset.tab === 'library') S.nav = [];
  S.tab = b.dataset.tab; render(); $('#view').scrollTop = 0;
}));
$('#back').addEventListener('click', () => {
  if (S.tab === 'player') { S.tab = S.prevTab || 'listening'; render(); return; }
  S.nav.pop(); render();
});
function openPlayer() { if (S.tab !== 'player') S.prevTab = S.tab; S.tab = 'player'; render(); $('#view').scrollTop = 0; }
function go(entry) { S.nav.push(entry); render(); $('#view').scrollTop = 0; }

function render() {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  const v = $('#view');
  const back = $('#back');
  back.hidden = !((S.tab === 'library' && S.nav.length) || S.tab === 'player');
  ({ listening: renderListening, library: renderLibrary, player: renderPlayer, notes: renderNotes, stats: renderStats, more: renderMore })[S.tab](v);
  updateMini();
}
const setTitle = t => { $('#title').textContent = t; };

// ---------- Library ----------
function groupBy(list, key) {
  const m = new Map();
  for (const i of list) { const k = key(i) || '—'; if (!m.has(k)) m.set(k, []); m.get(k).push(i); }
  return m;
}
const sortParts = (a, b) => (a.series || '').localeCompare(b.series || '') || (a.part || 0) - (b.part || 0) || a.title.localeCompare(b.title);

function renderLibrary(v) {
  if (!S.items.length) {
    setTitle('Library');
    v.innerHTML = `<div class="empty"><b>Your library is empty</b>
      Add the catalog and your cleaned messages from the Files app.<br><br>
      <button class="btn" id="go-add">Add files</button></div>`;
    $('#go-add').onclick = pickFiles;
    return;
  }
  const top = S.nav[S.nav.length - 1];
  if (top) return renderLibNode(v, top);
  setTitle('Library');
  const modes = [['preachers', 'Preachers'], ['phone', 'On phone'], ['topics', 'Topics'], ['done', 'Finished']];
  v.innerHTML = `<input class="search" id="q" type="search" placeholder="Search ${S.items.length.toLocaleString()} messages" value="${esc(S.query)}">
    <div class="seg">${modes.map(([k, l]) => `<button data-m="${k}" class="${S.libMode === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="lib-body"></div>`;
  v.querySelectorAll('.seg button').forEach(b => b.onclick = () => { S.libMode = b.dataset.m; S.query = ''; render(); });
  const q = $('#q');
  q.oninput = () => { S.query = q.value; libBody(); };
  libBody();
}
function libBody() {
  const body = $('#lib-body');
  const all = allItems();
  const q = S.query.trim().toLowerCase();
  if (q) {
    const words = q.split(/\s+/);
    const hits = all.filter(i => { const t = `${i.title} ${i.series} ${i.preacher} ${i.topic}`.toLowerCase(); return words.every(w => t.includes(w)); });
    body.innerHTML = hits.length ? messageList(hits.slice(0, 150), true) + (hits.length > 150 ? `<p class="small">Showing 150 of ${hits.length}. Type more to narrow it down.</p>` : '')
      : `<div class="empty">No messages match “${esc(S.query)}”.</div>`;
    return bindRows(body);
  }
  if (S.libMode === 'preachers' || S.libMode === 'topics') {
    const key = S.libMode === 'preachers' ? (i => i.preacher) : (i => i.topic);
    const g = [...groupBy(all, key)].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    body.innerHTML = `<div class="list">${g.map(([name, list]) => {
      const ph = list.filter(i => S.onPhone.has(i.id)).length;
      return `<button class="row" data-node="${esc(S.libMode === 'preachers' ? 'preacher' : 'topic')}" data-name="${esc(name)}">
        ${tile(name, null, S.libMode === 'preachers' ? 'round-av' : '')}<span class="main"><span class="t">${esc(name)}</span><span class="s">${list.length} messages${ph ? ` · ${ph} on phone` : ''}</span></span><span class="chev">›</span></button>`;
    }).join('')}</div>`;
    body.querySelectorAll('[data-node]').forEach(b => b.onclick = () => go({ type: b.dataset.node, name: b.dataset.name }));
    return;
  }
  let list;
  if (S.libMode === 'continue') list = all.filter(i => S.progress[i.id] && !S.progress[i.id].done && S.progress[i.id].pos > 5).sort((a, b) => S.progress[b.id].at - S.progress[a.id].at);
  if (S.libMode === 'phone') list = all.filter(i => S.onPhone.has(i.id)).sort((a, b) => a.preacher.localeCompare(b.preacher) || sortParts(a, b));
  if (S.libMode === 'done') list = all.filter(i => S.progress[i.id]?.done).sort((a, b) => S.progress[b.id].at - S.progress[a.id].at);
  const emptyMsg = { continue: 'Messages you start will show up here so you can pick up where you left off.',
    phone: 'Nothing on this phone yet. Go to More › Add files.', done: 'Messages you finish will show up here.' }[S.libMode];
  body.innerHTML = list.length ? messageList(list, true) : `<div class="empty">${emptyMsg}</div>`;
  bindRows(body);
}
function renderLibNode(v, node) {
  const all = allItems();
  if (node.type === 'preacher') {
    const mine = all.filter(i => i.preacher === node.name);
    setTitle(node.name);
    const g = [...groupBy(mine, i => i.series || 'Single messages')].sort((a, b) => a[0].localeCompare(b[0]));
    if (g.length === 1) { v.innerHTML = messageList(mine.sort(sortParts)); return bindRows(v); }
    v.innerHTML = `<p class="muted">${mine.length} messages in ${g.length} series</p><div class="list">${g.map(([name, list]) => {
      const ph = list.filter(i => S.onPhone.has(i.id)).length, dn = list.filter(i => S.progress[i.id]?.done).length;
      return `<button class="row" data-name="${esc(name)}">${tile(node.name + name, initials(name.split(' / ').pop()))}<span class="main"><span class="t">${esc(name)}</span>
        <span class="s">${list.length} message${list.length > 1 ? 's' : ''}${ph ? ` · ${ph} on phone` : ''}${dn ? ` · ${dn} finished` : ''}</span></span><span class="chev">›</span></button>`;
    }).join('')}</div>`;
    v.querySelectorAll('[data-name]').forEach(b => b.onclick = () => go({ type: 'series', preacher: node.name, name: b.dataset.name }));
    return;
  }
  if (node.type === 'series') {
    const list = all.filter(i => i.preacher === node.preacher && (i.series || 'Single messages') === node.name).sort(sortParts);
    setTitle(node.name.split(' / ').pop());
    const missing = list.filter(i => !S.onPhone.has(i.id));
    const allWanted = missing.length && missing.every(i => S.want.has(i.id));
    v.innerHTML = `<p class="muted">${esc(node.preacher)}${node.name.includes(' / ') ? ' · ' + esc(node.name) : ''}</p>
      ${missing.length ? `<button class="btn ghost wide" id="want-all" style="margin-bottom:12px">${allWanted ? '✓ On your phone list' : `Add ${missing.length} to phone list`}</button>` : ''}
      ${messageList(list)}`;
    if (missing.length) $('#want-all').onclick = () => { missing.forEach(i => allWanted ? S.want.delete(i.id) : S.want.add(i.id)); saveWant(); render(); };
    return bindRows(v);
  }
  if (node.type === 'topic') {
    const list = all.filter(i => i.topic === node.name).sort((a, b) => a.preacher.localeCompare(b.preacher) || sortParts(a, b));
    setTitle(node.name);
    v.innerHTML = messageList(list, true);
    return bindRows(v);
  }
}
function messageList(list, showPreacher) {
  return `<div class="list">${list.map(i => {
    const p = S.progress[i.id], on = S.onPhone.has(i.id);
    const pct = p && p.dur ? Math.min(100, p.pos / p.dur * 100) : 0;
    const nc = S.notes.filter(n => n.sid === i.id).length;
    const sub = [showPreacher ? i.preacher : '', showPreacher ? (i.series || '').split(' / ').pop() : '', p?.dur ? dur(p.dur) : ''].filter(Boolean).join(' · ');
    const art = showPreacher ? tile(i.preacher, null, 'sm') : tile(i.preacher + i.series, i.part && i.part < 100 ? String(i.part) : initials(i.title), 'sm');
    return `<button class="row ${on ? '' : 'off'}" data-id="${i.id}">${art}<span class="main">
      <span class="t">${esc(i.title)}</span>
      <span class="s">${on ? '<span class="badge b-phone">On phone</span>' : S.want.has(i.id) ? '<span class="badge b-want">Phone list</span>' : ''}${p?.done ? '<span class="badge b-done">✓ Done</span>' : ''}${nc ? `<span class="badge b-phone">${nc} note${nc > 1 ? 's' : ''}</span>` : ''}${esc(sub)}</span>
      ${pct && !p.done ? `<span class="prog"><i style="width:${pct}%"></i></span>` : ''}</span>
      ${p && !p.done && p.pos > 5 ? `<span class="n">${clock(p.dur - p.pos)} left</span>` : ''}</button>`;
  }).join('')}</div>`;
}
function bindRows(root) {
  root.querySelectorAll('[data-id]').forEach(b => b.onclick = () => openItem(b.dataset.id));
}
function openItem(id) {
  if (S.onPhone.has(id)) { playItem(id); return; }
  const i = item(id), w = S.want.has(id);
  sheet(`<h3>${esc(i.title)}</h3><p class="muted">${esc(i.preacher)}${i.series ? ' · ' + esc(i.series) : ''}</p>
    <p>This message isn't on your phone yet. Add it to your phone list, export the list (More › Phone list), and the Mac script will clean it up for the phone.</p>
    <div class="btns"><button class="btn" data-a="want">${w ? 'Remove from phone list' : 'Add to phone list'}</button>
    <button class="btn ghost" data-a="edit">Edit details</button><button class="btn ghost" data-a="close">Close</button></div>`, a => {
    if (a === 'want') { w ? S.want.delete(id) : S.want.add(id); saveWant(); toast(w ? 'Removed from phone list' : 'Added to phone list'); render(); }
    if (a === 'edit') return editItem(id);
    closeSheet();
  });
}
const saveWant = () => put('kv', [...S.want], 'want');

// ---------- Player ----------
let objUrl = null, loadedId = null;
async function loadTrack(id, autoplay) {
  if (loadedId !== id) {
    const rec = await get('audio', id);
    if (!rec) { toast('That audio file is missing from this phone.'); S.onPhone.delete(id); return false; }
    if (objUrl) URL.revokeObjectURL(objUrl);
    objUrl = URL.createObjectURL(rec.blob);
    audio.src = objUrl;
    loadedId = id;
    S.current = id;
    put('kv', id, 'last');
    const p = S.progress[id];
    const start = p && !p.done ? p.pos : 0;
    await new Promise(res => {
      const on = () => { audio.removeEventListener('loadedmetadata', on); res(); };
      audio.addEventListener('loadedmetadata', on);
      audio.load();
      setTimeout(res, 4000);
    });
    try { audio.currentTime = Math.min(start, (audio.duration || start + 1) - 1); } catch (e) { /* not seekable yet */ }
    audio.playbackRate = S.settings.speed;
    setMediaSession(id);
  }
  if (autoplay) { audio.playbackRate = S.settings.speed; await audio.play().catch(() => toast('Tap play to start')); }
  return true;
}
async function playItem(id) {
  await loadTrack(id, true);
  openPlayer();
}
function togglePlay() {
  if (!S.current) return;
  unlockSound();
  if (audio.paused) { audio.playbackRate = S.settings.speed; audio.play(); } else audio.pause();
}
function seekBy(d) { if (S.current) audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + d)); }

function setMediaSession(id) {
  if (!('mediaSession' in navigator)) return;
  const i = item(id);
  navigator.mediaSession.metadata = new MediaMetadata({ title: i.title, artist: i.preacher, album: i.series || i.topic,
    artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }] });
  const ms = navigator.mediaSession;
  const h = (a, f) => { try { ms.setActionHandler(a, f); } catch (e) { /* unsupported */ } };
  h('play', () => audio.play()); h('pause', () => audio.pause());
  h('seekbackward', e => seekBy(-(e.seekOffset || 15))); h('seekforward', e => seekBy(e.seekOffset || 30));
  h('seekto', e => { audio.currentTime = e.seekTime; });
  h('nexttrack', () => {   // steering-wheel / CarPlay / headphone ⏭
    if (S.settings.carBookmark) { addBookmark(true); return; }
    const n = nextInSeries(S.current); if (n) playItem(n);
  });
  h('previoustrack', () => seekBy(-15));
}
function nextInSeries(id) {
  const i = item(id);
  const list = allItems().filter(x => x.preacher === i.preacher && x.series === i.series).sort(sortParts);
  const k = list.findIndex(x => x.id === id);
  return list.slice(k + 1).find(x => S.onPhone.has(x.id))?.id;
}

// Progress + listening time
let lastTick = 0, pendingLog = {}, lastSave = 0;
function tick() {
  const now = performance.now();
  if (!audio.paused && S.current && lastTick) {
    const d = (now - lastTick) / 1000;
    if (d > 0 && d < 5) {
      const k = `${hourKey(new Date())}|${S.current}`;
      pendingLog[k] = (pendingLog[k] || 0) + d;
      S.log[k] = (S.log[k] || 0) + d;
    }
  }
  lastTick = audio.paused ? 0 : now;
  if (now - lastSave > 5000) saveProgress();
  updateTimes();
}
async function saveProgress() {
  lastSave = performance.now();
  const id = S.current;
  if (id && audio.duration && isFinite(audio.duration)) {
    const prev = S.progress[id] || {};
    const done = prev.done || audio.currentTime / audio.duration > 0.97;
    const rec = { pos: audio.currentTime, dur: audio.duration, done, at: Date.now(), doneAt: done ? (prev.doneAt || Date.now()) : null };
    S.progress[id] = rec;
    put('progress', rec, id).catch(() => {});
  }
  const pl = pendingLog; pendingLog = {};
  const keys = Object.keys(pl);
  if (keys.length) await tx('log', 'readwrite', s => { for (const k of keys) s.put(S.log[k], k); }).catch(() => {});
}
audio.addEventListener('timeupdate', tick);
audio.addEventListener('play', () => { lastTick = performance.now(); updatePlayState(); });
audio.addEventListener('pause', () => { tick(); saveProgress(); updatePlayState(); });
audio.addEventListener('ended', async () => {
  const id = S.current;
  S.progress[id] = { ...(S.progress[id] || {}), pos: 0, dur: audio.duration, done: true, at: Date.now(), doneAt: Date.now() };
  await put('progress', S.progress[id], id);
  await saveProgress();
  if (sleepMode === 'end') { sleepMode = 0; render(); return; }
  const n = S.settings.autoNext && nextInSeries(id);
  if (n) { toast('Playing the next part'); playItem(n); } else render();
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { tick(); saveProgress(); } });
window.addEventListener('pagehide', () => { tick(); saveProgress(); });
setInterval(() => { if (!audio.paused) tick(); }, 1000);

// Sleep timer
let sleepMode = 0, sleepAt = 0;
setInterval(() => { if (sleepAt && Date.now() > sleepAt) { sleepAt = 0; sleepMode = 0; audio.pause(); if (S.tab === 'player') render(); } }, 1000);

function updatePlayState() {
  const playing = !audio.paused;
  document.querySelectorAll('[data-play]').forEach(b => { b.innerHTML = playing ? icon.pause : icon.play; b.setAttribute('aria-label', playing ? 'Pause' : 'Play'); });
  const art = $('.pl-art'); if (art) art.classList.toggle('paused', !playing);
  updateMini();
  if (S.tab === 'listening' && $('#sheet').hidden) render();  // keep the resume card's Play/Pause in sync
}
function updateTimes() {
  const sc = $('#scrub');
  if (sc && !sc.dragging) {
    sc.max = audio.duration || 0; sc.value = audio.currentTime;
    sc.style.setProperty('--p', (audio.duration ? audio.currentTime / audio.duration * 100 : 0) + '%');
    $('#t-now').textContent = clock(audio.currentTime);
    $('#t-left').textContent = '-' + clock((audio.duration || 0) - audio.currentTime);
  }
  const at = $('#note-at');
  if (at && !noteTime) at.textContent = `Note will be saved at ${clock(audio.currentTime)}`;
  const mp = $('#mini-prog');
  if (mp && audio.duration) mp.style.width = (audio.currentTime / audio.duration * 100) + '%';
}
function updateMini() {
  const show = S.current && S.tab !== 'player';
  $('#mini').hidden = !show;
  if (!show) return;
  const i = item(S.current);
  $('#mini-title').textContent = i.title;
  $('#mini-sub').textContent = i.preacher;
  const ma = $('#mini-art'); ma.style.setProperty('--g', grad(i.preacher)); ma.textContent = initials(i.preacher);
  const b = $('#mini-play');
  b.dataset.play = '1';
  b.innerHTML = audio.paused ? icon.play : icon.pause;
}
$('#mini-play').onclick = togglePlay;
$('#mini-open').onclick = openPlayer;

let noteTime = null;
function renderPlayer(v) {
  setTitle('Now Playing');
  if (!S.current) {
    v.innerHTML = `<div class="empty"><b>Nothing playing</b>Pick a message from the Library.</div>`;
    return;
  }
  const i = item(S.current), id = S.current, p = S.progress[id];
  const notes = S.notes.filter(n => n.sid === id).sort((a, b) => a.t - b.t);
  const sleepLabel = sleepMode === 'end' ? 'Sleep: end' : sleepAt ? `Sleep ${Math.ceil((sleepAt - Date.now()) / 60000)}m` : 'Sleep';
  const g = grad(i.preacher);
  v.innerHTML = `<div class="pl-head" style="--g:${g}"><div class="pl-glow"></div><div class="pl-art">${esc(initials(i.preacher))}<small>${esc(i.part ? 'Part ' + i.part : i.topic)}</small></div>
      <h2 class="pl-title">${esc(i.title)}</h2>
      <div class="pl-sub">${esc(i.preacher)}${i.series ? ' · ' + esc(i.series.split(' / ').pop()) : ''}</div>
      <div class="chips"><button class="chip on" id="topic">${esc(i.topic)} ▾</button>${p?.done ? '<span class="chip on">✓ Finished</span>' : ''}<button class="chip" id="edit">Edit</button></div></div>
    <div class="scrub"><input type="range" id="scrub" min="0" step="1" aria-label="Position"></div>
    <div class="times"><span id="t-now">0:00</span><span id="t-left">0:00</span></div>
    <div class="ctrl"><button class="skip" id="b-back" aria-label="Back 15 seconds">${icon.back}<b>15</b></button>
      <button class="round big" data-play="1" id="b-play" aria-label="Play"></button>
      <button class="skip" id="b-fwd" aria-label="Forward 30 seconds">${icon.fwd}<b>30</b></button></div>
    <div class="opts"><button id="b-speed" class="${S.settings.speed !== 1 ? 'on' : ''}">${S.settings.speed}×</button>
      <button id="b-sleep" class="${sleepMode ? 'on' : ''}">${sleepLabel}</button>
      <button id="b-done">${p?.done ? 'Mark unfinished' : 'Mark finished'}</button></div>
    <div class="quick"><button class="qbtn" id="b-mark"><svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4.5L6 21z"/></svg><b>Bookmark</b><span>this moment</span></button>
      <button class="qbtn" id="b-voice"><svg viewBox="0 0 24 24"><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><b>Voice note</b><span>say it out loud</span></button></div>
    <div class="h2">Notes</div>
    <div class="note-box"><textarea id="note-in" rows="1" placeholder="Write a note…"></textarea><button class="btn" id="note-add">Save</button></div>
    <div class="note-at" id="note-at"></div>
    ${notes.length ? `<div class="notes-list" style="margin-top:12px">${notes.map(n => noteRow(n)).join('')}</div>` : '<p class="small" style="margin:10px 2px">Notes are saved at the moment in the message where you start typing. Driving? Use Bookmark or Voice note above, or your car\'s ⏭ button. Tap a time to jump back to it.</p>'}`;
  updatePlayState(); updateTimes();
  const sc = $('#scrub');
  sc.addEventListener('input', () => { sc.dragging = true; $('#t-now').textContent = clock(sc.value); sc.style.setProperty('--p', (sc.value / (sc.max || 1) * 100) + '%'); });
  sc.addEventListener('change', () => { audio.currentTime = +sc.value; sc.dragging = false; });
  $('#b-play').onclick = togglePlay;
  $('#b-back').onclick = () => seekBy(-15);
  $('#b-fwd').onclick = () => seekBy(30);
  $('#b-speed').onclick = () => {
    const sp = [0.8, 1, 1.25, 1.5, 1.75, 2];
    S.settings.speed = sp[(sp.indexOf(S.settings.speed) + 1) % sp.length];
    audio.playbackRate = S.settings.speed; put('kv', S.settings, 'settings'); render();
  };
  $('#b-sleep').onclick = () => {
    const seq = [0, 15, 30, 60, 'end'];
    sleepMode = seq[(seq.indexOf(sleepMode) + 1) % seq.length];
    sleepAt = typeof sleepMode === 'number' && sleepMode ? Date.now() + sleepMode * 60000 : 0;
    toast(sleepMode === 'end' ? 'Stops at the end of this message' : sleepMode ? `Stops in ${sleepMode} minutes` : 'Sleep timer off');
    render();
  };
  $('#b-done').onclick = async () => {
    const cur = S.progress[id] || { pos: audio.currentTime, dur: audio.duration };
    S.progress[id] = { ...cur, done: !cur.done, at: Date.now(), doneAt: !cur.done ? Date.now() : null };
    await put('progress', S.progress[id], id); render();
  };
  $('#topic').onclick = () => pickTopic(id);
  $('#b-mark').onclick = () => addBookmark(false);
  $('#b-voice').onclick = startVoiceNote;
  $('#edit').onclick = () => editItem(id);
  const ta = $('#note-in');
  ta.addEventListener('focus', () => { if (noteTime == null) { noteTime = audio.currentTime; $('#note-at').textContent = `Note will be saved at ${clock(noteTime)}`; } });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });
  ta.addEventListener('blur', () => { if (!ta.value.trim()) setTimeout(() => { if (document.activeElement !== ta && !ta.value.trim()) { noteTime = null; updateTimes(); } }, 200); });
  $('#note-add').onclick = async () => {
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    const n = { sid: id, t: noteTime ?? audio.currentTime, text, at: Date.now() };
    n.nid = await tx('notes', 'readwrite', s => req(s.add(n)));
    S.notes.push(n); noteTime = null; render(); toast('Note saved');
  };
  bindNotes(v);
}
// ---------- Hands-free notes: bookmarks and voice notes ----------
const BOOKMARK_BACK = 10;   // seconds: you react after you hear it, so save a little earlier
let actx = null;
function unlockSound() {    // iOS only lets a page make sound after a tap; called from play/bookmark taps
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) { /* no Web Audio */ }
}
function chime(up = true) {
  if (!actx || actx.state !== 'running') return;
  const t = actx.currentTime;
  [[up ? 660 : 880, 0], [up ? 990 : 660, 0.11]].forEach(([f, d]) => {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.22, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.18);
    o.connect(g).connect(actx.destination); o.start(t + d); o.stop(t + d + 0.2);
  });
}
async function saveNote(n) {
  n.nid = await tx('notes', 'readwrite', s => req(s.add(n)));
  S.notes.push(n);
  return n;
}
async function addBookmark(fromCar) {
  if (!S.current) return;
  if (!fromCar) unlockSound();
  const t = Math.max(0, audio.currentTime - BOOKMARK_BACK);
  await saveNote({ sid: S.current, t, text: '', kind: 'bookmark', at: Date.now() });
  chime(true);
  toast(`Bookmark saved at ${clock(t)}`);
  if (S.tab === 'player' || S.tab === 'notes') render();
}

let rec = null;
async function startVoiceNote() {
  if (!S.current) return;
  unlockSound();
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast("This phone can't record here. Use a bookmark instead."); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { toast('Microphone access was blocked. Allow it in Settings › Safari › Microphone.'); return; }
  const wasPlaying = !audio.paused, t = audio.currentTime, sid = S.current;
  audio.pause();
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(m => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
  let mr;
  try { mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined); mr.start(); }
  catch (e) {   // couldn't start: give the mic back, tell the user, keep the sermon going
    stream.getTracks().forEach(tr => tr.stop());
    toast("Couldn't start recording. Try again, or use a bookmark.");
    if (wasPlaying) audio.play();
    return;
  }
  const chunks = [];
  mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  rec = { mr, stream, t, sid, wasPlaying, started: Date.now(), cancelled: false };
  mr.onstop = async () => {
    stream.getTracks().forEach(tr => tr.stop());
    const r = rec; rec = null; clearInterval(recTimer);
    closeSheet();
    if (!r.cancelled && chunks.length) {
      const blob = new Blob(chunks, { type: mr.mimeType || type || 'audio/mp4' });
      const secs = (Date.now() - r.started) / 1000;
      await saveNote({ sid: r.sid, t: r.t, text: '', kind: 'voice', audio: blob, len: secs, at: Date.now() });
      chime(true);
      toast(`Voice note saved at ${clock(r.t)}`);
    }
    if (r.wasPlaying && S.current === r.sid) { audio.currentTime = Math.max(0, r.t - 2); audio.play(); }
    render();
  };
  chime(false);
  sheet(`<div class="rec"><div class="rec-dot"></div><h3>Recording…</h3><p class="rec-time" id="rec-time">0:00</p>
    <p class="muted">Saved at ${clock(t)} in the message. The sermon picks up again when you stop.</p>
    <button class="rec-stop" data-a="stop" aria-label="Stop and save"><span></span>Tap to save</button>
    <button class="btn ghost wide" data-a="cancel">Cancel</button></div>`, a => {
    if (!rec) return;
    if (a === 'cancel') rec.cancelled = true;
    rec.mr.stop();
  });
  $('#sheet').onclick = null;   // don't close by tapping outside while recording
  recTimer = setInterval(() => {
    if (!rec) return;
    const s = (Date.now() - rec.started) / 1000, el = $('#rec-time');
    if (el) el.textContent = clock(s);
    if (s > 180) rec.mr.stop();    // stop by itself after 3 minutes
  }, 250);
}
let recTimer = 0;
let clip = null;
function playClip(n, btn) {
  if (clip) { clip.pause(); clip = null; document.querySelectorAll('.vplay.on').forEach(b => b.classList.remove('on')); return; }
  const wasPlaying = !audio.paused;
  audio.pause();
  clip = new Audio(URL.createObjectURL(n.audio));
  btn.classList.add('on');
  clip.onended = () => { btn.classList.remove('on'); URL.revokeObjectURL(clip.src); clip = null; if (wasPlaying) audio.play(); };
  clip.play();
}
function editNote(nid) {
  const n = S.notes.find(x => x.nid === nid);
  sheet(`<h3>${n.kind === 'bookmark' ? 'Add to bookmark' : n.kind === 'voice' ? 'Add to voice note' : 'Edit note'}</h3>
    <p class="muted">At ${clock(n.t)}</p>
    <textarea id="edit-tx" class="edit-tx" rows="4" placeholder="What stood out?">${esc(n.text)}</textarea>
    <div class="btns"><button class="btn" data-a="save">Save</button><button class="btn ghost" data-a="close">Cancel</button></div>`, async a => {
    if (a === 'save') { n.text = $('#edit-tx').value.trim(); await put('notes', n); toast('Saved'); }
    closeSheet(); render();
  });
  setTimeout(() => $('#edit-tx')?.focus(), 250);
}

function noteRow(n, showSource) {
  const i = item(n.sid);
  const label = n.kind === 'bookmark' ? '<span class="kind">🔖 Bookmark</span>' : n.kind === 'voice' ? `<button class="vplay" data-clip="${n.nid}" aria-label="Play voice note"><i></i>Voice note · ${clock(n.len)}</button>` : '';
  const body = n.text ? esc(n.text) : n.kind ? '<span class="add">Tap to add words</span>' : '';
  return `<div class="note ${n.kind || ''}"><button class="ts" data-seek="${n.nid}">${clock(n.t)}</button>
    <div class="tx">${label}<div class="txt" data-edit="${n.nid}" role="button" tabindex="0">${body}</div>${showSource && i ? `<span class="src">${esc(i.title)} · ${esc(i.preacher)}</span>` : ''}</div>
    <button class="del" data-del="${n.nid}" aria-label="Delete note">×</button></div>`;
}
function bindNotes(root) {
  root.querySelectorAll('[data-seek]').forEach(b => b.onclick = async () => {
    const n = S.notes.find(x => x.nid === +b.dataset.seek);
    if (!S.onPhone.has(n.sid)) { toast("That message's audio isn't on this phone."); return; }
    await loadTrack(n.sid, false);
    audio.currentTime = Math.max(0, n.t - (n.kind ? 0 : 3)); audio.play();
    openPlayer();
  });
  root.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editNote(+b.dataset.edit));
  root.querySelectorAll('[data-clip]').forEach(b => b.onclick = () => playClip(S.notes.find(x => x.nid === +b.dataset.clip), b));
  root.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this note?')) return;
    const nid = +b.dataset.del;
    await del('notes', nid);
    S.notes = S.notes.filter(n => n.nid !== nid); render();
  });
}
function pickTopic(id) {
  const cur = item(id).topic;
  sheet(`<h3>Message type</h3><p class="muted">Used for your listening stats.</p><div class="list">${TOPICS.map(t =>
    `<button class="row" data-a="${esc(t)}"><span class="main"><span class="t">${esc(t)}</span></span>${t === cur ? '<span class="n">✓</span>' : ''}</button>`).join('')}</div>`,
  async t => { await setOverride(id, { topic: t }); closeSheet(); render(); });
}
function editItem(id) {
  const i = item(id);
  const preachers = [...new Set(allItems().map(x => x.preacher))].sort();
  sheet(`<h3>Edit details</h3>
    <label>Title</label><input type="text" id="e-title" value="${esc(i.title)}">
    <label>Preacher</label><input type="text" id="e-preacher" value="${esc(i.preacher)}" list="e-pl"><datalist id="e-pl">${preachers.map(p => `<option value="${esc(p)}">`).join('')}</datalist>
    <label>Series</label><input type="text" id="e-series" value="${esc(i.series)}">
    <label>Type</label><select id="e-topic">${TOPICS.map(t => `<option ${t === i.topic ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
    <div class="btns"><button class="btn" data-a="save">Save</button>
    ${S.onPhone.has(id) ? '<button class="btn danger" data-a="remove">Remove audio from phone (keeps notes and progress)</button>' : ''}
    <button class="btn ghost" data-a="close">Cancel</button></div>`, async a => {
    if (a === 'save') {
      await setOverride(id, { title: $('#e-title').value.trim() || i.title, preacher: $('#e-preacher').value.trim() || i.preacher,
        series: $('#e-series').value.trim(), topic: $('#e-topic').value });
      toast('Saved');
    }
    if (a === 'remove') {
      if (!confirm('Remove this audio file from your phone? Your notes and progress stay.')) return;
      if (S.current === id) { audio.pause(); audio.removeAttribute('src'); S.current = null; loadedId = null; }
      await del('audio', id); S.onPhone.delete(id); toast('Removed from phone');
    }
    closeSheet(); render();
  });
}
async function setOverride(id, o) {
  S.overrides[id] = { ...(S.overrides[id] || {}), ...o };
  await put('kv', S.overrides, 'overrides');
  if (S.current === id) setMediaSession(id);
}

// ---------- Notes tab ----------
// ---------- Listening (pick up where you left off) ----------
function inProgress() {
  return allItems().filter(i => { const p = S.progress[i.id]; return p && !p.done && p.pos > 5; })
    .sort((a, b) => (b.id === S.current) - (a.id === S.current) || S.progress[b.id].at - S.progress[a.id].at);
}
function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : d < 7 ? `${d} days ago` : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function renderListening(v) {
  setTitle('Listening');
  const list = inProgress();
  if (!list.length) {
    v.innerHTML = `<div class="empty"><b>Nothing in progress</b>Start a message from the Library and it'll wait for you here, right where you stopped.<br><br>
      <button class="btn" id="go-lib">Browse the Library</button></div>`;
    $('#go-lib').onclick = () => { S.tab = 'library'; render(); };
    return;
  }
  const [top, ...rest] = list;
  const p = S.progress[top.id], on = S.onPhone.has(top.id), pct = Math.min(100, p.pos / p.dur * 100);
  const playingNow = top.id === S.current && !audio.paused;
  v.innerHTML = `<div class="resume" style="--g:${grad(top.preacher)}"><div class="resume-glow"></div>
      <div class="resume-top">${tile(top.preacher, null, 'lg')}<div class="resume-meta"><span class="eyebrow">${playingNow ? 'Playing now' : 'Continue listening'}</span>
        <b>${esc(top.title)}</b><span>${esc(top.preacher)}${top.series ? ' · ' + esc(top.series.split(' / ').pop()) : ''}</span></div></div>
      <div class="resume-bar"><i style="width:${pct}%"></i></div>
      <div class="resume-times"><span>${clock(p.pos)} of ${clock(p.dur)}</span><span>${clock(p.dur - p.pos)} left</span></div>
      <button class="btn wide resume-btn" id="resume-top" ${on ? '' : 'disabled'}>${on ? (playingNow ? `${icon.pause} Pause` : `${icon.play} Resume at ${clock(p.pos)}`) : 'Not on this phone'}</button>
      <div class="resume-foot"><span>Last listened ${ago(p.at)}</span><button class="link-btn" data-menu="${top.id}">Options</button></div></div>
    ${rest.length ? `<div class="h2">Also in progress · ${rest.length}</div><div class="list">${rest.map(i => {
      const q = S.progress[i.id], ok = S.onPhone.has(i.id);
      return `<div class="row lrow ${ok ? '' : 'off'}" data-id="${i.id}" role="button" tabindex="0">${tile(i.preacher, null, 'sm')}<span class="main">
        <span class="t">${esc(i.title)}</span><span class="s">${esc(i.preacher)} · ${ago(q.at)}</span>
        <span class="prow"><span class="prog"><i style="width:${Math.min(100, q.pos / q.dur * 100)}%"></i></span><em>${dur(q.dur - q.pos)} left</em></span></span>
        <button class="more-btn" data-menu="${i.id}" aria-label="Options">⋯</button>
        <button class="play-mini" data-resume="${i.id}" aria-label="Resume" ${ok ? '' : 'disabled'}>${icon.play}</button></div>`;
    }).join('')}</div>` : ''}`;
  $('#resume-top').onclick = () => {
    if (top.id === S.current) { togglePlay(); return; }
    resume(top.id);
  };
  v.querySelectorAll('[data-resume]').forEach(b => b.onclick = e => { e.stopPropagation(); resume(b.dataset.resume); });
  v.querySelectorAll('.lrow').forEach(r => r.onclick = () => {
    if (S.onPhone.has(r.dataset.id)) loadTrack(r.dataset.id, false).then(openPlayer); else openItem(r.dataset.id);
  });
  v.querySelectorAll('[data-menu]').forEach(b => b.onclick = e => { e.stopPropagation(); progressMenu(b.dataset.menu); });
}
async function resume(id) {
  if (!S.onPhone.has(id)) { openItem(id); return; }
  await loadTrack(id, true);
  render();
}
function progressMenu(id) {
  const i = item(id);
  sheet(`<h3>${esc(i.title)}</h3><p class="muted">${esc(i.preacher)}</p><div class="btns">
    <button class="btn ghost" data-a="open">Open player</button>
    <button class="btn ghost" data-a="done">Mark finished</button>
    <button class="btn ghost" data-a="restart">Start over from the beginning</button>
    <button class="btn danger" data-a="clear">Remove from Listening</button>
    <button class="btn ghost" data-a="close">Cancel</button></div>`, async a => {
    const p = S.progress[id];
    if (a === 'open') { closeSheet(); if (S.onPhone.has(id)) { await loadTrack(id, false); openPlayer(); } else openItem(id); return; }
    if (a === 'done') S.progress[id] = { ...p, done: true, at: Date.now(), doneAt: Date.now() };
    if (a === 'restart' || a === 'clear') { S.progress[id] = { ...p, pos: 0, at: Date.now() }; if (S.current === id) audio.currentTime = 0; }
    if (a !== 'close') { await put('progress', S.progress[id], id); toast({ done: 'Marked finished', restart: 'Will start from the beginning', clear: 'Removed from Listening' }[a]); }
    closeSheet(); render();
  });
}

function renderNotes(v) {
  setTitle('Notes');
  if (!S.notes.length) { v.innerHTML = `<div class="empty"><b>No notes yet</b>While a message plays, write notes under the player. They're saved at that moment in the message.</div>`; return; }
  v.innerHTML = `<input class="search" id="nq" type="search" placeholder="Search your notes">
    <div id="notes-body"></div>`;
  const draw = () => {
    const q = $('#nq').value.trim().toLowerCase();
    const list = S.notes.filter(n => !q || n.text.toLowerCase().includes(q) || (item(n.sid)?.title || '').toLowerCase().includes(q));
    const g = [...groupBy(list, n => n.sid)].sort((a, b) => Math.max(...b[1].map(n => n.at)) - Math.max(...a[1].map(n => n.at)));
    $('#notes-body').innerHTML = g.map(([sid, ns]) => {
      const i = item(sid);
      return `<div class="notes-head">${tile(i ? i.preacher : '?', null, 'sm')}<div><b>${esc(i ? i.title : 'Unknown message')}</b><span>${i ? esc(i.preacher) : ''} · ${ns.length} note${ns.length > 1 ? 's' : ''}</span></div></div>
        <div class="notes-list">${ns.sort((a, b) => a.t - b.t).map(n => noteRow(n)).join('')}</div>`;
    }).join('') || `<div class="empty">No notes match.</div>`;
    bindNotes($('#notes-body'));
  };
  $('#nq').oninput = draw;
  draw();
}

// ---------- Stats ----------
function periodBounds(range, off) {
  const now = new Date();
  let a, b, label, buckets;
  if (range === 'day') {
    a = new Date(now.getFullYear(), now.getMonth(), now.getDate() + off); b = new Date(a); b.setDate(b.getDate() + 1);
    label = off === 0 ? 'Today' : off === -1 ? 'Yesterday' : a.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    buckets = Array.from({ length: 24 }, (_, h) => ({ key: `${dayKey(a)}T${pad(h)}`, label: h % 6 === 0 ? (h === 0 ? '12a' : h === 12 ? '12p' : h > 12 ? `${h - 12}p` : `${h}a`) : '', tip: new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' }) }));
  } else if (range === 'week') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() + off * 7);
    a = start; b = new Date(start); b.setDate(b.getDate() + 7);
    const end = new Date(b); end.setDate(end.getDate() - 1);
    label = off === 0 ? 'This week' : off === -1 ? 'Last week' : `${a.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    buckets = Array.from({ length: 7 }, (_, d) => { const x = new Date(a); x.setDate(x.getDate() + d); return { key: dayKey(x), label: x.toLocaleDateString(undefined, { weekday: 'narrow' }), tip: x.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) }; });
  } else if (range === 'month') {
    a = new Date(now.getFullYear(), now.getMonth() + off, 1); b = new Date(a.getFullYear(), a.getMonth() + 1, 1);
    label = a.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const n = new Date(b - 1).getDate();
    buckets = Array.from({ length: n }, (_, d) => { const x = new Date(a.getFullYear(), a.getMonth(), d + 1); return { key: dayKey(x), label: [1, 8, 15, 22, 29].includes(d + 1) ? String(d + 1) : '', tip: x.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) }; });
  } else {
    a = new Date(now.getFullYear() + off, 0, 1); b = new Date(a.getFullYear() + 1, 0, 1);
    label = String(a.getFullYear());
    buckets = Array.from({ length: 12 }, (_, m) => { const x = new Date(a.getFullYear(), m, 1); return { key: `${a.getFullYear()}-${pad(m + 1)}`, label: x.toLocaleDateString(undefined, { month: 'narrow' }), tip: x.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) }; });
  }
  return { a: dayKey(a), b: dayKey(b), label, buckets };
}
function renderStats(v) {
  setTitle('Stats');
  const P = periodBounds(S.statRange, S.statOffset);
  const inRange = Object.entries(S.log).filter(([k]) => { const d = k.slice(0, 10); return d >= P.a && d < P.b; });
  const total = inRange.reduce((s, [, x]) => s + x, 0);
  const per = new Map(P.buckets.map(b => [b.key, 0]));
  const byPreacher = new Map(), byTopic = new Map(), msgs = new Set();
  for (const [k, sec] of inRange) {
    const [stamp, sid] = k.split('|');
    const bk = S.statRange === 'day' ? stamp.slice(0, 13) : S.statRange === 'year' ? stamp.slice(0, 7) : stamp.slice(0, 10);
    if (per.has(bk)) per.set(bk, per.get(bk) + sec);
    const i = item(sid);
    const pr = i ? i.preacher : 'Unknown', tp = i ? i.topic : 'Unknown';
    byPreacher.set(pr, (byPreacher.get(pr) || 0) + sec);
    byTopic.set(tp, (byTopic.get(tp) || 0) + sec);
    if (sec >= 30) msgs.add(sid);
  }
  const finished = Object.values(S.progress).filter(p => p.done && p.doneAt && dayKey(new Date(p.doneAt)) >= P.a && dayKey(new Date(p.doneAt)) < P.b).length;
  const bars = P.buckets.map(b => ({ ...b, v: per.get(b.key) || 0 }));
  const allTime = Object.values(S.log).reduce((s, x) => s + x, 0);
  v.innerHTML = `<div class="seg">${[['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']].map(([k, l]) => `<button data-r="${k}" class="${S.statRange === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="period"><button id="p-prev" aria-label="Previous">‹</button><b>${esc(P.label)}</b><button id="p-next" aria-label="Next" ${S.statOffset >= 0 ? 'disabled' : ''}>›</button></div>
    <div class="hero"><div><b>${dur(total)}</b><span>listened</span></div>
      <div><b>${msgs.size}</b><span>messages</span></div><div><b>${finished}</b><span>finished</span></div><div><b>${streak()}</b><span>day streak</span></div></div>
    <div class="card chart" id="chart">${barChart(bars)}</div>
    ${breakdown('By preacher', byPreacher, total)}
    ${breakdown('By type of message', byTopic, total)}
    <p class="small" style="text-align:center;margin-top:18px">All time: ${dur(allTime)} listened · ${Object.values(S.progress).filter(p => p.done).length} messages finished</p>`;
  v.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { S.statRange = b.dataset.r; S.statOffset = 0; render(); });
  $('#p-prev').onclick = () => { S.statOffset--; render(); };
  $('#p-next').onclick = () => { if (S.statOffset < 0) { S.statOffset++; render(); } };
  bindChart($('#chart'), bars);
}
function streak() {
  const days = new Set(Object.entries(S.log).filter(([, s]) => s >= 60).map(([k]) => k.slice(0, 10)));
  const d = new Date(); let n = 0;
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1); // today not started yet doesn't break it
  while (days.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function barChart(bars) {
  const W = 340, H = 150, top = 8, bottom = 18, left = 30;
  const max = Math.max(...bars.map(b => b.v), 60);
  const unit = max >= 5400 ? 3600 : 60;
  const stepU = niceStep(max / unit / 3);
  const ymax = Math.ceil(max / unit / stepU) * stepU * unit;
  const ih = H - top - bottom, iw = W - left;
  const bw = iw / bars.length, gap = Math.min(2, bw * 0.25);
  let g = '';
  for (let y = 0; y <= ymax; y += stepU * unit) {
    const yy = top + ih - (y / ymax) * ih;
    g += `<line class="grid" x1="${left}" x2="${W}" y1="${yy}" y2="${yy}"/><text class="ax" x="${left - 5}" y="${yy + 3}" text-anchor="end">${y === 0 ? '0' : y % 3600 === 0 ? y / 3600 + 'h' : y > 3600 ? Math.floor(y / 3600) + 'h' + (y % 3600 / 60) : y / 60 + 'm'}</text>`;
  }
  bars.forEach((b, k) => {
    const x = left + k * bw + gap / 2, h = (b.v / ymax) * ih, w = Math.max(1, bw - gap);
    if (b.v > 0) {
      const hh = Math.max(h, 2), r = Math.min(4, w / 2, hh);
      const y0 = top + ih;
      g += `<path class="bar" d="M${x},${y0} V${y0 - hh + r} Q${x},${y0 - hh} ${x + r},${y0 - hh} H${x + w - r} Q${x + w},${y0 - hh} ${x + w},${y0 - hh + r} V${y0} Z" style="fill:var(--bar)"/>`;
    }
    g += `<rect class="hit" data-k="${k}" x="${left + k * bw}" y="${top}" width="${bw}" height="${ih + bottom}"/>`;
    if (b.label) g += `<text class="ax" x="${left + k * bw + bw / 2}" y="${H - 4}" text-anchor="middle">${b.label}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Listening time chart">${g}</svg><div class="tip" hidden></div>`;
}
function niceStep(x) { const p = Math.pow(10, Math.floor(Math.log10(x || 1))); const f = x / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
function bindChart(el, bars) {
  const tip = el.querySelector('.tip'), svg = el.querySelector('svg');
  const show = e => {
    const r = e.target.closest('rect.hit'); if (!r) return;
    const b = bars[+r.dataset.k];
    const box = svg.getBoundingClientRect(), eb = el.getBoundingClientRect(), rb = r.getBoundingClientRect();
    tip.innerHTML = `<b>${dur(b.v)}</b> · ${esc(b.tip)}`;
    tip.hidden = false;
    tip.style.left = Math.max(60, Math.min(eb.width - 60, rb.left - eb.left + rb.width / 2)) + 'px';
    tip.style.top = (box.top - eb.top + 14) + 'px';
  };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', () => { tip.hidden = true; });
}
function breakdown(title, map, total) {
  const rows = [...map].sort((a, b) => b[1] - a[1]);
  if (!rows.length) return `<div class="h2">${title}</div><div class="card"><p class="muted">No listening in this period yet.</p></div>`;
  let shown = rows.slice(0, 7);
  if (rows.length > 8) shown.push(['Everyone else', rows.slice(7).reduce((s, r) => s + r[1], 0)]); else shown = rows;
  const max = shown[0][1];
  return `<div class="h2">${title}</div><div class="card" style="padding:4px 14px">${shown.map(([n, s]) =>
    `<div class="hbar"><span class="nm">${esc(n)}</span><span class="v">${dur(s)} · ${Math.round(s / total * 100)}%</span><span class="tr"><i style="width:${s / max * 100}%"></i></span></div>`).join('')}</div>`;
}

// ---------- More: import, phone list, backup ----------
async function renderMore(v) {
  setTitle('More');
  const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  if (S.tab !== 'more') return;
  const gb = x => (x / 1e9).toFixed(x > 1e10 ? 0 : 1) + ' GB';
  v.innerHTML = `<div class="card"><b>Add files</b><p class="muted">Pick the cleaned messages (the .m4a files the Mac made) and catalog.json from the Files app. You can select many at once. After they're added you can delete them from Files to save space.</p>
      <button class="btn wide" id="add">Add files</button><div id="imp" class="small" style="margin-top:8px"></div></div>
    <div class="card"><b>Phone list</b><p class="muted">${S.want.size} message${S.want.size === 1 ? '' : 's'} waiting to be put on this phone. Export the list, send it to your Mac, and run:<br><code>python3 tools/prepare.py --list phone-list.txt</code></p>
      <div class="btns"><button class="btn ghost" id="exp-want" ${S.want.size ? '' : 'disabled'}>Export phone list</button>
      ${S.want.size ? '<button class="btn ghost" id="clr-want">Clear the list</button>' : ''}</div></div>
    <div class="card"><b>On this phone</b><p class="muted">${S.onPhone.size} message${S.onPhone.size === 1 ? '' : 's'} · ${S.items.length.toLocaleString()} in the catalog${est ? ` · using ${gb(est.usage || 0)}${est.quota ? ` of ${gb(est.quota)} available` : ''}` : ''}${persisted ? ' · protected from clean-up' : ''}</p>
      <label style="display:flex;gap:10px;align-items:center;margin-top:8px"><input type="checkbox" id="auto-next" ${S.settings.autoNext ? 'checked' : ''}> Play the next part of a series automatically</label>
      <label style="display:flex;gap:10px;align-items:flex-start;margin-top:10px"><input type="checkbox" id="car-mark" ${S.settings.carBookmark ? 'checked' : ''} style="margin-top:3px"> <span>The ⏭ next button in the car, on headphones or the lock screen saves a bookmark (with a chime) instead of skipping</span></label></div>
    <div class="card"><b>Backup</b><p class="muted">Saves your progress, notes, listening history and edits to one small file (not the audio). Keep a copy in iCloud Drive in case the phone is reset.</p>
      <div class="btns"><button class="btn ghost" id="backup">Save a backup</button><button class="btn ghost" id="restore">Restore from a backup</button></div></div>
    <p class="small" style="text-align:center;margin-top:16px">Sermon Library · everything stays on this phone</p>`;
  $('#add').onclick = pickFiles;
  $('#restore').onclick = pickFiles;
  $('#auto-next').onchange = e => { S.settings.autoNext = e.target.checked; put('kv', S.settings, 'settings'); };
  $('#car-mark').onchange = e => { S.settings.carBookmark = e.target.checked; put('kv', S.settings, 'settings'); };
  $('#backup').onclick = exportBackup;
  if (S.want.size) {
    $('#exp-want').onclick = () => {
      const lines = [...S.want].map(id => { const i = item(id); return `${id}  ${i ? `${i.preacher} | ${i.series} | ${i.title}` : ''}`; });
      saveFile('phone-list.txt', lines.join('\n') + '\n', 'text/plain');
    };
    $('#clr-want').onclick = () => { if (confirm('Clear the phone list?')) { S.want.clear(); saveWant(); render(); } };
  }
}
function pickFiles() { const f = $('#file-in'); f.value = ''; f.click(); }
$('#file-in').addEventListener('change', async e => {
  const files = [...e.target.files];
  if (!files.length) return;
  const status = t => { const el = $('#imp'); if (el) el.textContent = t; else toast(t); };
  let added = 0, skipped = 0, n = 0;
  const extra = await get('kv', 'extra') || [];
  for (const f of files) {
    n++;
    status(`Adding ${n} of ${files.length}…`);
    try {
      if (/\.json$/i.test(f.name)) {
        const data = JSON.parse(await f.text());
        if (data.items) { await put('kv', data, 'catalog'); setCatalog(data); for (const x of extra) if (!S.byId.has(x.id)) { S.items.push(x); S.byId.set(x.id, x); } toast(`Catalog loaded: ${data.items.length.toLocaleString()} messages`); }
        else if (data.kind === 'sermon-library-backup') { await restoreBackup(data); }
        continue;
      }
      if (!/^audio\//.test(f.type) && !/\.(m4a|mp3|aac|wav|aiff?|ogg|opus)$/i.test(f.name)) { skipped++; continue; }
      let id = (f.name.match(/\[([0-9a-f]{8})\]/) || [])[1];
      if (!id) {
        id = 'x' + (await sha(f.name + f.size)).slice(0, 7);
        if (!S.byId.has(id)) {
          const e2 = { id, preacher: '[Unknown preacher]', series: '', part: null, title: f.name.replace(/\.[^.]+$/, ''), topic: 'Christian Living', path: f.name, size: f.size };
          extra.push(e2); S.items.push(e2); S.byId.set(id, e2);
        }
      }
      await put('audio', { blob: f, name: f.name, size: f.size, added: Date.now() }, id);
      S.onPhone.add(id); S.want.delete(id); added++;
    } catch (err) { console.error(err); skipped++; }
  }
  await put('kv', extra, 'extra'); saveWant();
  status(`Added ${added} message${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}.`);
  if (added) toast(`Added ${added} message${added === 1 ? '' : 's'} to your phone`);
  render();
});
async function sha(s) {
  const h = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function saveFile(name, text, type) {
  const blob = new Blob([text], { type });
  const file = new File([blob], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file] }).catch(() => {}); return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function exportBackup() {
  await saveProgress();
  const data = { kind: 'sermon-library-backup', version: 1, at: new Date().toISOString(), progress: S.progress, notes: S.notes.map(({ audio: _a, ...n }) => n),  // voice recordings stay on the phone
    log: S.log, overrides: S.overrides, want: [...S.want], settings: S.settings, extra: await get('kv', 'extra') || [] };
  saveFile(`sermon-library-backup-${dayKey(new Date())}.json`, JSON.stringify(data), 'application/json');
}
async function restoreBackup(d) {
  if (!confirm(`Restore the backup from ${new Date(d.at).toLocaleString()}? It merges with what's on this phone.`)) return;
  for (const [k, p] of Object.entries(d.progress || {})) if (!S.progress[k] || S.progress[k].at < p.at) { S.progress[k] = p; await put('progress', p, k); }
  const have = new Set(S.notes.map(n => `${n.sid}|${n.t}|${n.text}`));
  for (const n of d.notes || []) if (!have.has(`${n.sid}|${n.t}|${n.text}`)) { const c = { sid: n.sid, t: n.t, text: n.text, at: n.at, kind: n.kind, len: n.len }; c.nid = await tx('notes', 'readwrite', s => req(s.add(c))); S.notes.push(c); }
  for (const [k, s] of Object.entries(d.log || {})) if (!S.log[k] || S.log[k] < s) S.log[k] = s;
  await tx('log', 'readwrite', s => { for (const [k, x] of Object.entries(S.log)) s.put(x, k); });
  S.overrides = { ...(d.overrides || {}), ...S.overrides }; await put('kv', S.overrides, 'overrides');
  (d.want || []).forEach(x => S.want.add(x)); saveWant();
  const extra = await get('kv', 'extra') || [];
  for (const x of d.extra || []) if (!S.byId.has(x.id)) { extra.push(x); S.items.push(x); S.byId.set(x.id, x); }
  await put('kv', extra, 'extra');
  toast('Backup restored');
}

// ---------- Sheet ----------
function sheet(html, onAction) {
  const sh = $('#sheet'), card = sh.querySelector('.sheet-card');
  card.innerHTML = html; sh.hidden = false;
  card.querySelectorAll('[data-a]').forEach(b => b.onclick = () => onAction(b.dataset.a));
  sh.onclick = e => { if (e.target === sh) closeSheet(); };
}
function closeSheet() { $('#sheet').hidden = true; }
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSheet();
  if (e.key === ' ' && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); togglePlay(); }
});

// ---------- Start ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
load().catch(err => { console.error(err); $('#view').innerHTML = `<div class="empty"><b>Couldn't open storage</b>${esc(err.message)}</div>`; });
window.__sl = { S, audio, put, get }; // for testing
