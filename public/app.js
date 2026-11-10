const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  paper: null, refs: [], fulltexts: [], documents: [], filter: 'all', query: '',
  selectedRefId: null, centerView: 'map',
  settings: { email: '', coreApiKey: '', embeddingBase: '', embeddingModel: '', embeddingKey: '', baseUrl: '', model: '', modelKey: '' },
  activeFileName: '', pdfjs: null, pdfjsPromise: null, embeddingCache: new Map(),
  embeddingModelUsed: null,
  serverAI: { provider: null, chat: null, embeddings: null, rerank: null },
  rerankWarned: false,
  runId: 0, embeddingJob: null,
};

const demoText = `Demo reading notes

This short, original demo summary describes a sequence modeling paper that proposes a Transformer architecture based on attention, with encoder and decoder stacks built from self-attention and feed-forward layers. It reports that this design can be trained in parallel and compares favorably with recurrent and convolutional sequence models on translation tasks. These notes are included only to demonstrate the reading workflow; they are not the paper's full text.

References
[1] Bahdanau, D., Cho, K., and Bengio, Y. Neural Machine Translation by Jointly Learning to Align and Translate. 2014. DOI: 10.48550/arXiv.1409.0473
[2] Sutskever, I., Vinyals, O., and Le, Q. V. Sequence to Sequence Learning with Neural Networks. 2014. DOI: 10.48550/arXiv.1409.3215
[3] Hochreiter, S. and Schmidhuber, J. Long Short-Term Memory. Neural Computation, 1997. DOI: 10.1162/neco.1997.9.8.1735
[4] Cho, K. et al. Learning Phrase Representations using RNN Encoder-Decoder for Statistical Machine Translation. 2014. DOI: 10.3115/v1/D14-1179`;

const SPARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z"/></svg>';
const EXT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6m0-6-9 9"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/></svg>';

/* ---------- helpers ---------- */
function usesOwnEmbeddings(){ return Boolean(state.settings.embeddingModel && state.settings.embeddingBase); }
function hasEmbeddings(){ return usesOwnEmbeddings() || Boolean(state.serverAI.embeddings); }
function hasChatModel(){ return Boolean((state.settings.model && (state.settings.modelKey || state.settings.baseUrl)) || state.serverAI.chat); }
function hasReranker(){ return Boolean(state.serverAI.rerank); }

async function loadServerConfig(){
  try{
    const r = await fetch('/api/config', { cache: 'no-store' });
    if (r.ok) state.serverAI = { ...state.serverAI, ...(await r.json()).serverAI };
  }catch{ /* server defaults are optional */ }
  const parts = [state.serverAI.chat && `answers: ${state.serverAI.chat}`, state.serverAI.embeddings && `embeddings: ${state.serverAI.embeddings}`, state.serverAI.rerank && `rerank: ${state.serverAI.rerank}`].filter(Boolean);
  const note = $('#serverAiNote');
  if (note){
    note.textContent = parts.length ? `Server default (${state.serverAI.provider}, from .env): ${parts.join(' · ')}. Anything you fill in below overrides it for this tab.` : '';
    note.classList.toggle('hidden', !parts.length);
  }
  const summary = $('#serverAiSummary');
  if (summary) summary.textContent = parts.length
    ? `AI is ready from the server (${state.serverAI.provider}): ${parts.join(' · ')}. You can override it under “Sources & AI”.`
    : 'No server AI is configured. You can still trace references and search evidence lexically — or add endpoints under “Sources & AI”.';
  updateEvidenceControls();
}

function escapeHtml(v){
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function safeExternalUrl(v){
  try{ const u = new URL(String(v || '')); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; }catch{ return ''; }
}
function safeHttpsUrl(v){ const u = safeExternalUrl(v); return u.startsWith('https:') ? u : ''; }
function normalizeDoi(v){
  const m = String(v || '').match(/10\.\d{4,9}\/[\w.()/:;-]+/i);
  return m ? m[0].replace(/[.,;]+$/, '').toLowerCase() : '';
}
function showToast(msg, kind = 'success'){
  const t = $('#toast'); t.textContent = msg;
  t.classList.toggle('error', kind === 'error'); t.classList.add('show');
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => t.classList.remove('show'), 3800);
}
function setBusy(btn, busy, label = 'Working…'){
  if (!btn) return;
  if (busy){ btn.dataset.originalText = btn.innerHTML; btn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${escapeHtml(label)}</span>`; btn.disabled = true; }
  else { btn.innerHTML = btn.dataset.originalText || btn.innerHTML; btn.disabled = false; }
}
function apiRequest(path, payload, options = {}){
  return fetch(path, { method: options.method || 'POST', headers: { 'Content-Type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined })
    .then(async r => {
      if (!r.ok){ const d = await r.json().catch(() => ({})); throw new Error(d.error || `Request failed (${r.status}).`); }
      return options.raw ? r : r.json();
    });
}
/* Progress bar shared by tracing, downloading and embedding. */
function setProgress(done, total, label){
  const pct = total ? Math.round(done / total * 100) : 0;
  $('#progressWrap').classList.remove('hidden');
  $('#progressFill').style.width = `${pct}%`;
  $('#progressBar').setAttribute('aria-valuenow', String(pct));
  $('#progressText').textContent = label;
}
function hideProgressLater(runId, ms = 4000){
  setTimeout(() => { if (runId === state.runId) $('#progressWrap').classList.add('hidden'); }, ms);
}
function setJourney(step){
  $$('.journey li').forEach(li => {
    const n = Number(li.dataset.step);
    li.classList.toggle('done', n < step);
    if (n === step) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
}

/* ---------- client-side text extraction ---------- */
function inferTitle(text){
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const excluded = /^(abstract|introduction|keywords|contents|references|bibliography|doi:|arxiv:|preprint|copyright)/i;
  // Notices printed above many titles (licences, permissions, venue lines, e-mail, URLs).
  const boilerplate = /\b(permission|copyright|licen[cs]e|rights reserved|attribution|reproduce|published|proceedings|conference|journal|workshop|accepted|submitted|under review|preprint)\b|https?:|www\.|@|©/i;
  const c = lines.slice(0, 25).find(l => l.length >= 14 && l.length <= 220 && !excluded.test(l) && !boilerplate.test(l)
    && !/^\d+(\.\d+)*\s/.test(l)        // numbered section heading
    && !/^\p{Ll}/u.test(l)              // continuation of a wrapped sentence
    && !/[.,;:]$/.test(l));             // titles rarely end in punctuation; notices do
  return c ? c.replace(/\s+/g, ' ') : '';
}
// An arXiv PDF stamps its own ID with a version and subject class, e.g.
// "arXiv:1706.03762v7 [cs.CL] 2 Aug 2023". Cited arXiv IDs lack that stamp, so this
// identifies the paper itself and maps it to arXiv's DataCite DOI.
function arxivDoiFromStamp(text){
  const m = String(text || '').match(/arXiv:\s?(\d{4}\.\d{4,5})v\d+\s*\[[a-z-]+(?:\.[A-Za-z-]+)?\]/i);
  return m ? `10.48550/arxiv.${m[1]}` : '';
}
// A cited arXiv paper ("arXiv:1607.06450", "CoRR, abs/1409.0473", "arxiv.org/abs/…")
// maps to arXiv's DOI, which resolves exactly even when the title text is garbled.
function arxivDoiFromReference(raw){
  const m = String(raw || '').match(/(?:arxiv(?:\s*preprint)?\s*:?\s*|abs\/|arxiv\.org\/(?:abs|pdf)\/)(\d{4}\.\d{4,5})(?:v\d+)?/i);
  return m ? `10.48550/arxiv.${m[1]}` : '';
}
// The paper's own DOI: the arXiv stamp, or a DOI on the front page. Searching the
// whole text would pick up a cited work's DOI from the reference list.
function paperOwnDoi(text){
  return arxivDoiFromStamp(text) || extractDoi(String(text || '').slice(0, 3000));
}
function extractDoi(text){ return normalizeDoi(text); }
function extractReferenceTitle(raw){
  const quoted = String(raw).match(/[“"]([^”"]{12,})[”"]|‘([^’]{12,})’/);
  if (quoted) return (quoted[1] || quoted[2]).trim();
  const withoutDoi = String(raw).replace(/https?:\/\/\S+/gi, ' ').replace(/doi\s*:?\s*10\.\d{4,9}\/[\w.()/:;-]+/gi, ' ').replace(/^\s*(?:\[\d+\]|\(\d+\)|\d+[.)])\s*/, ' ');
  const parts = withoutDoi.split(/\.\s+(?=[A-Z“"\[])/).map(p => p.trim()).filter(Boolean);
  const meaningful = parts.filter(p => p.length > 24 && !/^(vol\.?|pp?\.?|journal|proceedings|arxiv|https?:)/i.test(p));
  if (meaningful.length >= 2){ const likely = meaningful.find(p => /\b(?:19|20)\d{2}\b/.test(p)) || meaningful[1]; return likely.replace(/\b(?:19|20)\d{2}\b/g, '').replace(/[,:;]+$/, '').trim(); }
  if (meaningful.length === 1) return meaningful[0].replace(/\b(?:19|20)\d{2}\b/g, '').trim();
  return withoutDoi.replace(/\b(?:19|20)\d{2}\b/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
}
function extractReferences(text){
  const source = String(text || '').replace(/\u0000/g, ' ');
  const headingLines = [...source.matchAll(/^[ \t]*(?:\d{1,2}\.?[ \t]*)?(?:references|bibliography|works cited|literature cited)[ \t]*:?[ \t]*$/gim)];
  const inlineHeadings = headingLines.length ? [] : [...source.matchAll(/\b(?:references|bibliography|works cited|literature cited)\b:?\s*(?=(?:\[1\]|\(1\)|1[.)])\s)/gi)];
  const heading = headingLines.at(-1) || inlineHeadings.at(-1);
  let section = heading ? source.slice(heading.index + heading[0].length) : '';
  if (!section){
    const doiMatches = [...source.matchAll(/(?:\[\d+\]|\d+[.)])[^\n]{12,}?10\.\d{4,9}\/[\w.()/:;-]+/gi)];
    section = doiMatches.map(m => m[0]).join('\n');
  }
  section = section.split(/\n\s*\n\s*(?:appendix|acknowledg(?:e)?ments|author contributions|supplementary|funding|conflict of interest)\b/i)[0];
  const numbered = [...section.matchAll(/(?:^|\n)\s*(?:\[(\d{1,3})\]|\((\d{1,3})\)|(\d{1,3})[.)])\s+/g)];
  let entries = [];
  if (numbered.length > 1){
    entries = numbered.map((m, i) => { const start = m.index + m[0].length; const end = i + 1 < numbered.length ? numbered[i + 1].index : section.length; return section.slice(start, end).replace(/\s*\n\s*/g, ' ').trim(); });
  }else{
    entries = section.split(/\n+/).map(e => e.trim());
    if (entries.length <= 1) entries = section.split(/(?<=\.)\s+(?=[A-Z][^.!?]{5,}\b(?:19|20)\d{2}\b)/).map(e => e.trim());
  }
  const candidates = entries.map(r => r.replace(/^\s*(?:references|bibliography)\s*/i, '').trim())
    .filter(r => r.length >= 26 && /(?:\b(?:19|20)\d{2}\b|10\.\d{4,9}\/|arxiv|proceedings|journal)/i.test(r));
  const results = []; const seen = new Set();
  for (const raw of candidates){
    const doi = extractDoi(raw) || arxivDoiFromReference(raw); const title = extractReferenceTitle(raw);
    const key = (doi || title).toLowerCase(); if (!key || seen.has(key)) continue; seen.add(key);
    results.push({ id: `ref-${results.length + 1}-${Math.random().toString(36).slice(2, 7)}`, raw: raw.slice(0, 1200), title, doi, authors: [], year: Number(raw.match(/\b(?:19|20)\d{2}\b/)?.[0]) || null });
    if (results.length >= 30) break;
  }
  return results;
}
function titleShort(v, max = 29){ const t = String(v || 'Untitled reference').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1).trim()}…` : t; }
function accessLabel(r){
  if (r.access === 'full-text-found') return 'Full text found';
  if (r.access === 'abstract-only') return 'Abstract only';
  if (r.access === 'checking') return 'Checking';
  return 'Unavailable';
}
function accessKind(r){ return r.access === 'full-text-found' ? 'full' : r.access === 'abstract-only' ? 'abstract' : r.access === 'checking' ? 'checking' : 'missing'; }
function badgeClass(r){ return accessKind(r); }
function statusText(r){
  return r.access === 'full-text-found' ? 'Free copy found' : r.access === 'abstract-only' ? 'Abstract available' : r.access === 'checking' ? 'Checking sources…' : 'No open copy found';
}

/* ---------- evidence documents ---------- */
function getSeedDoc(){
  if (!state.paper?.text) return [];
  return [{ id: 'seed-paper', title: state.paper.title || 'Starting paper', url: state.paper.doi ? `https://doi.org/${state.paper.doi}` : '', accessLabel: state.paper.sourceLabel || (state.paper.text.length > 1500 ? 'main paper text' : 'paper text / abstract'), type: 'seed', text: state.paper.text }];
}
function updateAbstractDocuments(){
  const indexedRefs = new Set(state.fulltexts.map(d => d.refId));
  const abstracts = state.refs.filter(r => r.abstract && !indexedRefs.has(r.id)).map(r => ({
    id: `abstract-${r.id}`, refId: r.id, title: r.title, url: r.url || (r.doi && `https://doi.org/${r.doi}`) || '', accessLabel: 'abstract-only', type: 'abstract', text: r.abstract
  }));
  state.documents = [...getSeedDoc(), ...abstracts, ...state.fulltexts];
  updateEvidenceControls(); updateSeedAction();
}
function updateSeedAction(){
  const btn = $('#seedIndexButton'); if (!btn) return;
  const hasFullText = state.paper?.sourceLabel === 'main paper text' || (state.paper?.text?.length > 1500 && state.paper?.sourceLabel !== 'abstract-only');
  const loc = state.paper?.locations?.find(e => safeHttpsUrl(e.url));
  btn.classList.toggle('hidden', !loc || hasFullText);
  btn.onclick = () => indexReference('__seed__', btn);
}

/* ---------- views ---------- */
function showView(name){
  const intake = name === 'intake';
  $('#intakeView').classList.toggle('hidden', !intake);
  $('#workspaceView').classList.toggle('hidden', intake);
  setJourney(intake ? 0 : 2);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function setCenterView(view){
  state.centerView = view;
  $('#graphView').classList.toggle('hidden', view !== 'map');
  $('#listView').classList.toggle('hidden', view !== 'list');
  $('#viewMapBtn').classList.toggle('is-active', view === 'map');
  $('#viewMapBtn').setAttribute('aria-pressed', String(view === 'map'));
  $('#viewListBtn').classList.toggle('is-active', view === 'list');
  $('#viewListBtn').setAttribute('aria-pressed', String(view === 'list'));
  if (view === 'map') requestAnimationFrame(createGraph);
}
function updatePaperMeta(){
  $('#workspaceTitle').textContent = state.paper?.title || 'Untitled research paper';
  const doi = state.paper?.doi;
  const authors = (state.paper?.authors || []).slice(0, 2).join(', ');
  const identity = [authors, state.paper?.year].filter(Boolean).map(escapeHtml).join(' · ');
  $('#workspaceMeta').innerHTML = `${identity ? `<span>${identity}</span><span> · </span>` : ''}${doi ? `<a href="https://doi.org/${encodeURIComponent(doi)}" target="_blank" rel="noopener noreferrer">DOI ${escapeHtml(doi)}</a><span> · </span>` : ''}<span>${state.refs.length} references</span>`;
}
function matchesView(r){
  if (state.filter !== 'all' && r.access !== state.filter) return false;
  if (state.query){
    const hay = `${r.title || ''} ${(r.authors || []).join(' ')} ${r.doi || ''}`.toLowerCase();
    if (!hay.includes(state.query)) return false;
  }
  return true;
}

/* ---------- graph ---------- */
function createGraph(){
  const canvas = $('#graphCanvas'); if (!canvas || $('#workspaceView').classList.contains('hidden')) return;
  const refs = state.refs;
  if (!refs.length){ canvas.innerHTML = '<div class="graph-empty"><strong>The trail will appear here</strong><small>Add reference text or use a paper DOI to discover its citation trail.</small></div>'; return; }
  const w = Math.max(300, Math.round(canvas.clientWidth || 600));
  const h = Math.max(280, Math.round(canvas.clientHeight || 320));
  const cx = w / 2, cy = h / 2 + 2, rx = Math.max(90, w / 2 - 86), ry = Math.max(66, h / 2 - 66);
  const maxLabel = Math.max(10, Math.min(22, Math.floor(w / 22)));
  const points = refs.map((reference, index) => { const a = (-Math.PI / 2) + (2 * Math.PI * index / Math.max(refs.length, 1)); return { reference, index, x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry }; });
  let svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Starting paper connected to ${refs.length} references">`;
  svg += `<circle cx="${cx}" cy="${cy}" r="42" fill="none" stroke="var(--line)" stroke-dasharray="2 4"/>`;
  for (const p of points) svg += `<path class="graph-edge ${state.selectedRefId === p.reference.id ? 'active-edge' : ''}" d="M ${cx} ${cy} Q ${(cx + p.x) / 2 + 5} ${(cy + p.y) / 2 - 6} ${p.x} ${p.y}"/>`;
  svg += `<g class="graph-node seed" transform="translate(${cx} ${cy})"><circle r="34"/><text text-anchor="middle" y="-2">Seed</text><text text-anchor="middle" y="13">paper</text></g>`;
  for (const p of points){
    const ref = p.reference; const kind = accessKind(ref);
    const title = escapeHtml(refs.length > 10 ? String(p.index + 1).padStart(2, '0') : titleShort(ref.title, maxLabel));
    const sub = kind === 'full' ? 'full text' : kind === 'abstract' ? 'abstract' : kind === 'checking' ? 'checking' : 'not found';
    const above = p.y < cy - 10;
    svg += `<g class="graph-node ${kind} ${state.selectedRefId === ref.id ? 'selected' : ''}" data-ref-id="${escapeHtml(ref.id)}" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})" tabindex="0" role="button" aria-label="${escapeHtml(ref.title)} — ${accessLabel(ref)}. Inspect this reference."><circle r="19"/><text text-anchor="middle" y="${above ? -42 : 36}">${title}</text><text class="node-sub" text-anchor="middle" y="${above ? -27 : 52}">${sub}</text></g>`;
  }
  svg += '</svg>'; canvas.innerHTML = svg;
  $$('.graph-node[data-ref-id]', canvas).forEach(node => {
    const activate = () => selectReference(node.dataset.refId);
    node.addEventListener('click', activate);
    node.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); activate(); } });
  });
}

/* ---------- rendering ---------- */
function refActionButtons(reference){
  const indexed = state.fulltexts.some(d => d.refId === reference.id);
  const loc = reference.locations?.[0];
  const openUrl = safeExternalUrl(loc?.url);
  const indexBtn = reference.access === 'full-text-found' && reference.locations?.some(e => safeHttpsUrl(e.url))
    ? `<button class="ref-action primary index-copy" data-ref-id="${escapeHtml(reference.id)}" type="button" ${indexed || reference.indexing ? 'disabled' : ''} ${reference.indexError ? `title="${escapeHtml(reference.indexError)}"` : ''}>${indexed ? 'Indexed ✓' : reference.indexing ? 'Downloading…' : reference.indexError ? 'Retry download' : 'Index free copy'}</button>` : '';
  const linkBtn = openUrl
    ? `<a class="ref-action" href="${escapeHtml(openUrl)}" target="_blank" rel="noopener noreferrer">Open source ${EXT}</a>`
    : reference.doi ? `<a class="ref-action" href="https://doi.org/${encodeURIComponent(reference.doi)}" target="_blank" rel="noopener noreferrer">View DOI ${EXT}</a>` : '';
  return indexBtn + linkBtn;
}
function badgesHtml(reference){
  const confidence = reference.confidence ? `<span class="badge">${Math.round(reference.confidence * 100)}% match</span>` : '';
  const providers = (reference.providers || []).slice(0, 3).join(' · ');
  const loc = reference.locations?.[0];
  const locDetails = loc ? [loc.host || loc.source, loc.version, loc.license].filter(Boolean).join(' · ') : '';
  return `<div class="badges"><span class="badge ${badgeClass(reference)}">${statusText(reference)}</span>${confidence}${providers ? `<span class="badge">${escapeHtml(providers)}</span>` : ''}${locDetails ? `<span class="badge">${escapeHtml(locDetails)}</span>` : ''}</div>`;
}
function renderInspector(){
  const box = $('#inspector'); if (!box) return;
  const ref = state.refs.find(r => r.id === state.selectedRefId);
  if (!ref){
    const locCount = state.paper?.locations?.length || 0;
    box.innerHTML = `<p class="eyebrow">Inspector</p><h3 id="inspectorTitle">${escapeHtml(state.paper?.title || 'Seed paper')}</h3>
      <p class="ref-meta">The seed paper. ${locCount ? `${locCount} free location${locCount === 1 ? '' : 's'} found for it — use “Index main free copy” above to add its full text.` : 'Select any reference — in the navigator, on the map, or in the reading list — to see where it can be read, its match confidence, and its abstract.'}</p>`;
    return;
  }
  const index = state.refs.indexOf(ref);
  const locations = (ref.locations || []).map(loc => {
    const u = safeExternalUrl(loc.url);
    const detail = [loc.host || loc.source, loc.version, loc.license].filter(Boolean).join(' · ') || escapeHtml(loc.source || 'Open location');
    return `<li><span>${escapeHtml(detail)}</span>${u ? `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">Open ${EXT}</a>` : ''}</li>`;
  }).join('');
  box.innerHTML = `<p class="eyebrow">Inspector · Reference ${String(index + 1).padStart(2, '0')}</p>
    <h3 id="inspectorTitle">${escapeHtml(ref.title || ref.raw || 'Untitled reference')}</h3>
    <p class="ref-meta">${escapeHtml((ref.authors || []).slice(0, 4).join(', ') || 'Authors not resolved')}${ref.year ? ` · ${escapeHtml(ref.year)}` : ''}${ref.doi ? ` · DOI ${escapeHtml(ref.doi)}` : ''}</p>
    ${badgesHtml(ref)}
    ${ref.abstract ? `<p class="abstract-text">${escapeHtml(ref.abstract.slice(0, 700))}${ref.abstract.length > 700 ? '…' : ''}</p>` : '<p class="abstract-text">No abstract was returned for this reference.</p>'}
    ${locations ? `<ul class="locations">${locations}</ul>` : ''}
    <div class="ref-actions" style="flex-direction:row;flex-wrap:wrap;margin-top:12px">${refActionButtons(ref)}</div>`;
  $$('.index-copy', box).forEach(b => b.addEventListener('click', () => indexReference(b.dataset.refId, b)));
}
function renderReferences(){
  const filtered = state.refs.filter(matchesView);
  /* navigator */
  $('#navRefList').innerHTML = filtered.map(r => {
    const i = state.refs.indexOf(r);
    return `<li><button type="button" class="nav-item ${state.selectedRefId === r.id ? 'is-selected' : ''}" data-nav-ref="${escapeHtml(r.id)}" ${state.selectedRefId === r.id ? 'aria-current="true"' : ''}>
      <span class="nav-num">${String(i + 1).padStart(2, '0')}</span><span class="status-dot ${accessKind(r)}" aria-hidden="true"></span>
      <span><b>${escapeHtml(titleShort(r.title || r.raw, 52))}</b><small>${accessLabel(r)}${r.year ? ` · ${escapeHtml(r.year)}` : ''}</small></span></button></li>`;
  }).join('');
  $('#navEmpty').classList.toggle('hidden', filtered.length > 0 || state.refs.length === 0);
  $$('[data-nav-ref]').forEach(b => b.addEventListener('click', () => selectReference(b.dataset.navRef)));
  /* reading list */
  const list = $('#referencesList');
  list.innerHTML = filtered.map(r => {
    const index = state.refs.indexOf(r);
    return `<article class="ref-item ${state.selectedRefId === r.id ? 'is-selected' : ''}" id="ref-card-${escapeHtml(r.id)}" data-select-ref="${escapeHtml(r.id)}">
      <span class="ref-num" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
      <div><h3>${escapeHtml(r.title || r.raw || 'Untitled reference')}</h3>
        <p class="ref-meta">${escapeHtml((r.authors || []).slice(0, 3).join(', ') || 'Authors not resolved')}${r.year ? ` · ${escapeHtml(r.year)}` : ''}${r.doi ? ` · DOI ${escapeHtml(r.doi)}` : ''}</p>
        ${badgesHtml(r)}
      </div><div class="ref-actions">${refActionButtons(r)}</div></article>`;
  }).join('');
  $('#emptyReferences').classList.toggle('hidden', state.refs.length > 0);
  $$('.index-copy', list).forEach(b => b.addEventListener('click', ev => { ev.stopPropagation(); indexReference(b.dataset.refId, b); }));
  $$('[data-select-ref]', list).forEach(card => card.addEventListener('click', () => selectReference(card.dataset.selectRef, false)));
  /* counts + access */
  const full = state.refs.filter(r => r.access === 'full-text-found').length;
  const abs = state.refs.filter(r => r.access === 'abstract-only').length;
  const unavail = state.refs.filter(r => !['full-text-found', 'abstract-only', 'checking'].includes(r.access)).length;
  $('#graphCount').textContent = state.refs.length;
  $('#allCount').textContent = state.refs.length; $('#fullCount').textContent = full; $('#abstractCount').textContent = abs;
  $('#summaryFull').textContent = full; $('#summaryAbstract').textContent = abs; $('#summaryUnavailable').textContent = unavail;
  $('#accessMeterFill').style.width = `${state.refs.length ? Math.round((full + abs * 0.45) / state.refs.length * 100) : 0}%`;
  $('#accessMeter').setAttribute('aria-label', `${full} of ${state.refs.length} references have open full text, ${abs} have abstracts only`);
  $('#accessSummaryNote').textContent = state.refs.length ? `${full} full-text copies and ${abs} abstracts can currently contribute evidence.` : 'Checking free-to-read locations for each reference.';
  createGraph(); renderInspector(); updateEvidenceControls();
}
function selectReference(refId, scrollCard = false){
  state.selectedRefId = refId;
  renderReferences();
  if (scrollCard && state.centerView === 'list'){
    const card = document.getElementById(`ref-card-${refId}`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}
function updateEvidenceControls(){
  const totalChars = state.documents.reduce((s, d) => s + String(d.text || '').length, 0);
  const hasAny = state.documents.some(d => String(d.text || '').trim().length > 0);
  const input = $('#chatInput'), send = $('#sendQuestion');
  if (input) input.disabled = !hasAny;
  if (send) send.disabled = !hasAny;
  const countEl = $('#evidenceCount'); if (!countEl) return;
  countEl.textContent = `${state.documents.length} source${state.documents.length === 1 ? '' : 's'} indexed · ${Math.round(totalChars / 1000)}k chars`;
  const rerank = hasReranker() ? ' + rerank' : '';
  $('#answerMode').textContent = hasEmbeddings()
    ? (hasChatModel() ? `GraphRAG${rerank} + AI` : `Semantic GraphRAG${rerank}`)
    : (hasChatModel() ? `LLM + lexical graph${rerank}` : `Lexical graph search${rerank}`);
}
function welcomeMessage(html){
  $('#chatMessages').innerHTML = `<div class="msg msg-assistant welcome-message"><span class="avatar" aria-hidden="true">${SPARK}</span><div><strong>Reading companion</strong>${html}</div></div>`;
}

/* ---------- explore flow (progressive, batches of 3) ---------- */
async function explorePaper(){
  const title = $('#paperTitle').value.trim() || inferTitle($('#paperText').value);
  const doi = normalizeDoi($('#paperDoi').value) || paperOwnDoi($('#paperText').value);
  const text = $('#paperText').value.trim();
  if (!title && !doi && !text){ showToast('Add a paper title, DOI, text, or PDF to get started.', 'error'); return; }
  if (text.length < 200 && !doi && !title){ showToast('Add more paper text or a DOI so reference discovery has enough context.', 'error'); return; }
  const btn = $('#exploreButton');
  const runId = ++state.runId; // background jobs from a previous paper stop writing once this changes
  state.embeddingJob = null;
  setBusy(btn, true, 'Tracing references…');
  $('#noticeBar').classList.add('hidden');
  state.paper = { title: title || 'Research paper', doi, text, fileName: state.activeFileName, authors: [], locations: [] };
  state.embeddingCache.clear(); state.embeddingModelUsed = null; state.selectedRefId = null;
  state.refs = extractReferences(text); state.fulltexts = [];
  updateAbstractDocuments();
  showView('workspace'); setJourney(1);
  updatePaperMeta(); renderReferences();
  welcomeMessage('<p>Matching reference details and checking legal open-access locations. Results arrive in batches, so you can start reading before the last one lands.</p>');
  setProgress(0, state.refs.length || 1, 'Contacting discovery services…');
  try{
    const result = await apiRequest('/api/resolve', {
      paper: { title: state.paper.title, doi: state.paper.doi, text: state.paper.text.slice(0, 2000) },
      references: [], discoverOnly: true, skipDiscovery: state.refs.length > 0,
      email: state.settings.email, coreApiKey: state.settings.coreApiKey,
    });
    if (result.paper){
      state.paper.title = result.paper.title || state.paper.title;
      state.paper.doi = result.paper.doi || state.paper.doi;
      state.paper.authors = result.paper.authors || [];
      state.paper.year = result.paper.year || null;
      state.paper.locations = result.paper.locations || [];
      if (!state.paper.text && result.paper.abstract){ state.paper.text = result.paper.abstract; state.paper.sourceLabel = 'abstract-only'; }
    }
    const discovered = state.refs.length ? state.refs : (result.references || []);
    state.refs = discovered.map(r => ({ ...r, access: 'checking', status: 'checking', locations: [], providers: [] }));
    updateAbstractDocuments(); renderReferences(); updatePaperMeta();

    const BATCH = 3; const pending = [...state.refs];
    for (let i = 0; i < pending.length; i += BATCH){
      const batch = pending.slice(i, i + BATCH);
      setProgress(i, pending.length, `Checking ${Math.min(i + BATCH, pending.length)} of ${pending.length} references…`);
      let updates;
      try{
        const br = await apiRequest('/api/resolve', {
          paper: {}, references: batch.map(({ id, raw, title, doi, authors, year }) => ({ id, raw, title, doi, authors, year })),
          email: state.settings.email, coreApiKey: state.settings.coreApiKey,
        });
        updates = new Map((br.references || []).map(r => [r.id, r]));
      }catch (err){
        updates = new Map(batch.map(r => [r.id, { access: 'unavailable', status: 'not-found', confidence: 0, error: err.message }]));
      }
      state.refs = state.refs.map(r => updates.has(r.id) ? { ...r, ...updates.get(r.id) } : r);
      updateAbstractDocuments(); renderReferences();
    }
    setProgress(pending.length, pending.length || 1, pending.length ? `Checked all ${pending.length} references.` : 'No references to check.');
    setJourney(2);
    const found = state.refs.filter(r => r.access === 'full-text-found').length;
    const absCount = state.refs.filter(r => r.access === 'abstract-only').length;
    if (state.refs.length){
      showToast(`Found ${found} open full-text copies and ${absCount} abstracts across ${state.refs.length} references.`);
      const srcNote = result.referencesFrom && result.referencesFrom !== 'uploaded reference list' ? ` References were discovered from ${escapeHtml(result.referencesFrom)}.` : '';
      welcomeMessage(`<p>Your trail is ready. Free copies are now downloading and being indexed automatically; you can ask a question at any time, and answers improve as more full text arrives.${srcNote}</p>`);
    }else{
      $('#noticeBar').textContent = state.paper.doi
        ? 'No reference list was found in the text and the citation services returned no reference records. Paste the bibliography or try another paper.'
        : 'No reference list was detected. Paste the bibliography section or add a paper DOI to discover citations.';
      $('#noticeBar').classList.remove('hidden');
      welcomeMessage('<p>Ctrl+V could not find references yet. Go back and paste the bibliography section or enter a DOI.</p>');
      renderReferences();
    }
  }catch (err){
    state.refs = state.refs.map(r => ({ ...r, access: 'unavailable', status: 'not-found', confidence: 0, locations: [], providers: [], error: err.message }));
    renderReferences();
    $('#noticeBar').textContent = `The paper text is ready, but reference services could not be reached: ${err.message} You can still ask questions about the paper text in this tab.`;
    $('#noticeBar').classList.remove('hidden');
    welcomeMessage('<p>External discovery could not connect. Your pasted or extracted paper text is still available for evidence search.</p>');
    showToast('Could not reach the discovery services.', 'error');
  }finally{
    setBusy(btn, false);
  }
  if (runId === state.runId) autoPrepareSources(runId);
}

/* ---------- automatic preparation: download free copies, then embed ---------- */
// After references resolve, download every free copy (3 at a time) into this tab's
// memory, then embed all sources so the first question does not wait.
async function autoPrepareSources(runId){
  const targets = [];
  const seedHasFullText = state.paper?.sourceLabel === 'main paper text' || (state.paper?.text?.length > 1500 && state.paper?.sourceLabel !== 'abstract-only');
  if (!seedHasFullText && state.paper?.locations?.some(e => safeHttpsUrl(e.url))) targets.push('__seed__');
  for (const r of state.refs){
    const indexed = state.fulltexts.some(d => d.refId === r.id);
    if (r.access === 'full-text-found' && !indexed && r.locations?.some(e => safeHttpsUrl(e.url))) targets.push(r.id);
  }
  let done = 0, ok = 0;
  if (targets.length){
    setProgress(0, targets.length, `Downloading free copies: 0 of ${targets.length}…`);
    const queue = [...targets];
    const worker = async () => {
      while (queue.length && runId === state.runId){
        if (await indexReference(queue.shift(), null, { quiet: true, runId })) ok += 1;
        done += 1;
        if (runId === state.runId) setProgress(done, targets.length, `Downloading free copies: ${done} of ${targets.length}…`);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }
  if (runId !== state.runId) return;
  const downloaded = targets.length ? `${ok} of ${targets.length} free copies downloaded` : 'No free copies to download';
  if (ok) showToast(`${downloaded}.`);
  if (!hasEmbeddings()){
    setProgress(1, 1, `${downloaded}. Ready for questions.`);
    hideProgressLater(runId);
    return;
  }
  const passageCount = collectPassages().length;
  setProgress(0, 1, `${downloaded}. Embedding ${passageCount.toLocaleString()} passages…`);
  try{
    const count = await ensureEmbeddings(runId);
    if (runId === state.runId) setProgress(1, 1, `${downloaded}. ${count.toLocaleString()} passages embedded; ready for questions.`);
  }catch (err){
    if (runId === state.runId) setProgress(1, 1, `${downloaded}. Embedding failed (${err.message}); questions will use keyword search.`);
  }
  hideProgressLater(runId, 6000);
}

/* ---------- file loading / PDF.js (CDN, as before) ---------- */
function loadPdfJs(){
  if (state.pdfjs) return Promise.resolve(state.pdfjs);
  if (state.pdfjsPromise) return state.pdfjsPromise;
  state.pdfjsPromise = import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs').then(pdfjs => {
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
    state.pdfjs = pdfjs; return pdfjs;
  });
  return state.pdfjsPromise;
}
async function extractPdfText(data){
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const parts = []; let lastY = null;
    for (const item of content.items){
      if (!item.str) continue;
      const y = item.transform?.[5] ?? null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2.2) parts.push('\n');
      else if (parts.length && !parts.at(-1).endsWith('\n')) parts.push(' ');
      parts.push(item.str); lastY = y;
    }
    pages.push(parts.join(''));
  }
  return pages.join('\n\n');
}
async function loadLocalFile(file){
  state.activeFileName = file.name;
  $('#uploadLabel').textContent = `Selected: ${file.name}`;
  const ext = file.name.split('.').pop().toLowerCase();
  try{
    let text;
    if (ext === 'pdf' || file.type === 'application/pdf'){
      if (file.size > 24 * 1024 * 1024) throw new Error('The prototype supports PDFs up to 24 MB.');
      text = await extractPdfText(new Uint8Array(await file.arrayBuffer()));
      if (text.trim().length < 120) throw new Error('This PDF has no selectable text. OCR support is not included yet; paste its text or abstract instead.');
      showToast('PDF text extracted in your browser.');
    }else{
      if (file.size > 3 * 1024 * 1024) throw new Error('Text files can be up to 3 MB.');
      text = await file.text();
    }
    $('#paperText').value = text;
    if (!$('#paperTitle').value.trim()) $('#paperTitle').value = inferTitle(text);
    const doi = paperOwnDoi(text);
    if (doi && !$('#paperDoi').value.trim()) $('#paperDoi').value = doi;
    // Adding a file starts everything: references, free copies, embeddings.
    showToast(`${file.name} loaded. Tracing its references…`);
    explorePaper();
  }catch (err){
    $('#uploadLabel').textContent = 'Drop a PDF, TXT or Markdown file — or browse';
    showToast(err.message || 'Could not read this file.', 'error');
  }
}

/* ---------- downloading a free copy through the proxy (memory only) ---------- */
async function fetchSourceText(loc){
  const response = await apiRequest('/api/proxy-document', { url: loc.url }, { raw: true });
  const ct = (response.headers.get('content-type') || '').toLowerCase();
  let text = '';
  if (ct.includes('pdf') || loc.url.toLowerCase().includes('.pdf')){
    text = await extractPdfText(new Uint8Array(await response.arrayBuffer()));
  }else{
    const raw = await response.text();
    if (ct.includes('html')){
      const doc = new DOMParser().parseFromString(raw, 'text/html');
      doc.querySelectorAll('script,style,nav,footer,header,aside,form').forEach(el => el.remove());
      text = (doc.querySelector('article') || doc.querySelector('main') || doc.body)?.innerText || '';
    }else if (ct.includes('xml')){
      text = new DOMParser().parseFromString(raw, 'text/xml').documentElement.textContent || '';
    }else text = raw;
  }
  return text.replace(/\s+/g, ' ').trim();
}
// Tries up to three secure locations (PDFs first) until one yields readable text.
// Returns true on success; with quiet, the reference card shows the outcome instead of a toast.
async function indexReference(refId, btn, { quiet = false, runId = state.runId } = {}){
  const isSeed = refId === '__seed__';
  const reference = isSeed ? state.paper : state.refs.find(e => e.id === refId);
  if (!reference?.locations?.length || reference.indexing) return false;
  const locs = [...reference.locations.filter(e => e.pdfUrl && safeHttpsUrl(e.url)), ...reference.locations.filter(e => !e.pdfUrl && safeHttpsUrl(e.url))];
  setBusy(btn, true, 'Downloading…');
  reference.indexing = true; reference.indexError = '';
  if (!isSeed) renderReferences();
  let lastErr = new Error('No secure HTTPS copy is available to index. Open the source link to check access.');
  try{
    for (const loc of locs.slice(0, 3)){
      try{
        const text = await fetchSourceText(loc);
        if (text.length < 180) throw new Error('The source did not contain enough readable text to index. It may be a landing page or scanned PDF.');
        if (runId !== state.runId) return false; // a different paper was opened meanwhile
        if (isSeed){
          state.paper.text = text.slice(0, 180000); state.paper.sourceLabel = 'main paper text';
        }else{
          state.fulltexts = state.fulltexts.filter(d => d.refId !== refId);
          state.fulltexts.push({ id: `full-${refId}`, refId, title: reference.title, url: loc.url, accessLabel: 'full text', type: 'fulltext', text: text.slice(0, 180000) });
          reference.indexed = true;
        }
        updateAbstractDocuments();
        if (!quiet) showToast(`Indexed ${titleShort(reference.title, 42)} for source-grounded answers.`);
        return true;
      }catch (err){ lastErr = err; }
    }
    reference.indexError = lastErr.message || 'Could not download this open copy.';
    if (!quiet) showToast(reference.indexError, 'error');
    return false;
  }finally{
    reference.indexing = false;
    setBusy(btn, false);
    if (runId === state.runId){ renderReferences(); updatePaperMeta(); }
  }
}

/* ---------- retrieval: chunking, lexical, embeddings, rerank, graph expansion ---------- */
const STOP_WORDS = new Set('a an and are as at be been but by can could did do does for from had has have how i if in into is it its may might of on or our should that the their them then there these they this to was we were what when where which who why will with would you your about across paper papers source sources reference references show tell explain'.split(' '));
function tokenize(text){ return String(text || '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)?.filter(w => !STOP_WORDS.has(w)) || []; }
function makeChunks(text, maxLength = 1150){
  const paras = String(text || '').split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9])/).map(p => p.trim()).filter(Boolean);
  const chunks = []; let cur = '';
  for (const para of paras){
    if (para.length > maxLength){ if (cur){ chunks.push(cur); cur = ''; } for (let i = 0; i < para.length; i += maxLength) chunks.push(para.slice(i, i + maxLength)); }
    else if ((cur + ' ' + para).length > maxLength){ if (cur) chunks.push(cur); cur = para; }
    else cur = cur ? `${cur}\n\n${para}` : para;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
function collectPassages(){
  return state.documents.flatMap(doc => makeChunks(doc.text).map((text, index) => ({ document: doc, text, chunkIndex: index, nodeId: doc.type === 'seed' ? 'seed-paper' : doc.refId })));
}
function lexicalScore(text, terms, question = ''){
  if (!terms.length) return 0;
  const content = text.toLowerCase(); let score = 0;
  for (const term of terms){ const n = content.split(term).length - 1; if (n) score += 1 + Math.min(n - 1, 2) * .3; }
  if (!score) return 0;
  score = Math.min(1, score / Math.sqrt(terms.length * 2));
  if (question && content.includes(question.toLowerCase().trim())) score = Math.min(1, score + .15);
  return score;
}
function expandThroughCitationGraph(scored){
  if (!scored.length) return [];
  const bestByNode = new Map();
  for (const item of scored) bestByNode.set(item.nodeId, Math.max(bestByNode.get(item.nodeId) || 0, item.score));
  const startNodes = [...bestByNode.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id);
  const neighbors = new Map([['seed-paper', new Set(state.refs.map(r => r.id))]]);
  for (const r of state.refs) neighbors.set(r.id, new Set(['seed-paper']));
  const distances = new Map(startNodes.map(id => [id, 0])); const queue = [...startNodes];
  while (queue.length){
    const id = queue.shift(); const d = distances.get(id) || 0; if (d >= 2) continue;
    for (const n of neighbors.get(id) || []){ if (!distances.has(n)){ distances.set(n, d + 1); queue.push(n); } }
  }
  const expanded = scored.filter(i => distances.has(i.nodeId)).map(i => {
    const d = distances.get(i.nodeId) || 0;
    const boost = d === 0 ? .18 : d === 1 ? .09 : .035;
    const relation = i.nodeId === 'seed-paper' ? 'starting paper' : d === 0 ? 'directly retrieved cited paper' : `linked through ${state.paper?.title || 'the starting paper'}`;
    return { ...i, score: i.score + boost, relation };
  }).sort((a, b) => b.score - a.score);
  const perNode = new Map();
  return expanded.filter(i => { const c = perNode.get(i.nodeId) || 0; if (c >= 2) return false; perNode.set(i.nodeId, c + 1); return true; })
    .slice(0, 8).map(i => ({ id: i.document.id, title: i.document.title, url: i.document.url, accessLabel: i.document.accessLabel, relationship: i.relation, reranked: Boolean(i.reranked), text: i.text, score: i.score }));
}
async function rerankCandidates(question, scored, limit = 30){
  if (!hasReranker() || scored.length < 2) return scored;
  const candidates = scored.slice(0, limit);
  try{
    const { results } = await apiRequest('/api/rerank', { query: question, documents: candidates.map(i => i.text) });
    const rel = new Map(results.map(i => [i.index, i.score]));
    return candidates.map((item, index) => ({ ...item, score: (rel.get(index) ?? 0) * 0.8 + item.score * 0.2, reranked: true })).sort((a, b) => b.score - a.score);
  }catch (err){
    if (!state.rerankWarned) showToast(`Reranking unavailable; using first-stage ranking. ${err.message}`, 'error');
    state.rerankWarned = true; return scored;
  }
}
async function rankEvidence(question){
  const terms = tokenize(question);
  const scored = collectPassages().map(p => ({ ...p, score: lexicalScore(p.text, terms, question) })).filter(i => i.score > 0).sort((a, b) => b.score - a.score);
  return expandThroughCitationGraph(await rerankCandidates(question, scored));
}
function fingerprint(text){ let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return `${text.length}-${(h >>> 0).toString(36)}`; }
function embeddingCacheKey(entry){
  const src = usesOwnEmbeddings() ? `${state.settings.embeddingBase}|${state.settings.embeddingModel}` : `server|${state.serverAI.embeddings}`;
  return `${src}|${entry.document.id}|${entry.chunkIndex}|${fingerprint(entry.text)}`;
}
async function requestEmbeddings(texts){
  const vectors = []; let model = null;
  // 128 passages per request keeps a whole set of papers within free-tier daily limits.
  for (let i = 0; i < texts.length; i += 128){
    const result = await apiRequest('/api/embeddings', {
      texts: texts.slice(i, i + 128),
      baseUrl: usesOwnEmbeddings() ? state.settings.embeddingBase : '',
      model: usesOwnEmbeddings() ? state.settings.embeddingModel : '',
      apiKey: usesOwnEmbeddings() ? state.settings.embeddingKey : '',
    });
    if (model && result.model && result.model !== model) throw new Error('Embedding batches used different models; try again.');
    model = model || result.model || null; vectors.push(...result.vectors);
  }
  return { vectors, model };
}
function cosineSimilarity(a, b){
  if (!a?.length || a.length !== b?.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++){ dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
function embeddingEntries(){ return collectPassages().map(p => ({ ...p, cacheKey: embeddingCacheKey(p) })); }
// Embeds every passage not cached yet. Background preparation and questions share
// one queue, so the same passages are never embedded twice at once. Returns the
// number of embedded passages.
function ensureEmbeddings(runId = state.runId){
  const previous = state.embeddingJob;
  const run = async () => {
    if (previous) await previous.catch(() => {});
    const entries = embeddingEntries();
    const missing = entries.filter(e => !state.embeddingCache.has(e.cacheKey));
    if (!missing.length) return entries.length;
    let { vectors, model } = await requestEmbeddings(missing.map(e => e.text));
    if (runId !== state.runId) return 0;
    if (state.embeddingModelUsed && model && model !== state.embeddingModelUsed && missing.length < entries.length){
      // A fallback model answered; vectors from different models are not comparable, so re-embed everything.
      state.embeddingCache.clear();
      ({ vectors, model } = await requestEmbeddings(entries.map(e => e.text)));
      if (runId !== state.runId) return 0;
      entries.forEach((e, vi) => state.embeddingCache.set(e.cacheKey, vectors[vi]));
    }else{
      missing.forEach((e, vi) => state.embeddingCache.set(e.cacheKey, vectors[vi]));
    }
    state.embeddingModelUsed = model || state.embeddingModelUsed;
    return entries.length;
  };
  const job = run();
  state.embeddingJob = job;
  job.finally(() => { if (state.embeddingJob === job) state.embeddingJob = null; }).catch(() => {});
  return job;
}
async function rankEvidenceSemantic(question){
  if (!collectPassages().length) return [];
  await ensureEmbeddings();
  const entries = embeddingEntries();
  const { vectors, model } = await requestEmbeddings([question]);
  if (state.embeddingModelUsed && model && model !== state.embeddingModelUsed){
    throw new Error(`The question was embedded with ${model}, but sources used ${state.embeddingModelUsed}.`);
  }
  const queryVector = vectors[0]; const terms = tokenize(question);
  const scored = entries.map(e => {
    const semantic = cosineSimilarity(queryVector, state.embeddingCache.get(e.cacheKey));
    return { ...e, score: semantic * .82 + lexicalScore(e.text, terms, question) * .18 };
  }).sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score < .12) return [];
  const floor = Math.max(.08, scored[0].score * .44);
  return expandThroughCitationGraph(await rerankCandidates(question, scored.filter(i => i.score >= floor)));
}

/* ---------- Q&A ---------- */
function renderAnswerText(text){
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\[(S\d+)\]/g, '<span class="src-chip">[$1]</span>');
}
function isAccessQuestion(query){
  const access = /\b(abstract.?only|full.?text|free.?cop(?:y|ies)|open.?access|paywall(?:ed)?|availab(?:le|ility)|unavailable|accessible|can i (?:read|access))\b/i;
  const asksAboutAccess = /^\s*(?:which|how many|what(?: share| fraction| proportion)?|are|is|list|show|count)\b[^?]*\b(?:sources?|references?|papers?|copies|works|ones)\b/i;
  const asksAboutContent = /\b(say|says|said|claim|argue|describe|explain|propose|find|found|report|show(?:s|ed)? that|about|mean|method|result)\b/i;
  if (!access.test(query)) return false;
  if (/\b(availability|unavailable|paywall(?:ed)?|abstract.?only|can i (?:read|access))\b/i.test(query) && !asksAboutContent.test(query)) return true;
  return asksAboutAccess.test(query) && !asksAboutContent.test(query);
}
async function askQuestion(question){
  const query = question.trim(); if (!query) return;
  const messages = $('#chatMessages');
  messages.querySelector('.welcome-message')?.remove();
  messages.insertAdjacentHTML('beforeend', `<div class="msg msg-user">${escapeHtml(query)}</div>`);
  const loadingId = `answer-${Date.now()}`;
  messages.insertAdjacentHTML('beforeend', `<div id="${loadingId}" class="msg msg-assistant"><span class="avatar" aria-hidden="true">${SPARK}</span><div><strong>Searching your evidence…</strong><p>Retrieving passages and following citation links.</p></div></div>`);
  $('#chatInput').value = ''; $('#chatInput').disabled = true; $('#sendQuestion').disabled = true;
  messages.scrollTop = messages.scrollHeight;
  try{
    let retrievalMode = 'lexical'; let evidence;
    if (isAccessQuestion(query) && state.refs.length){
      retrievalMode = 'metadata';
      evidence = state.refs.slice(0, 8).map(r => ({
        id: `access-${r.id}`, title: r.title, url: r.locations?.[0]?.url || r.url || '', accessLabel: 'availability metadata', relationship: 'citation graph access record',
        text: `Access status: ${accessLabel(r)}. Matching sources: ${(r.providers || []).join(', ') || 'none confirmed'}. ${r.locations?.[0]?.license ? `Reported license: ${r.locations[0].license}.` : 'No license was reported by the discovery record.'}`
      }));
    }else if (hasEmbeddings()){
      retrievalMode = 'semantic';
      try{
        evidence = await rankEvidenceSemantic(query);
        if (!evidence.length){ const lex = await rankEvidence(query); if (lex.length){ evidence = lex; retrievalMode = 'lexical'; } }
      }catch (err){ retrievalMode = 'lexical'; evidence = await rankEvidence(query); showToast(`Embeddings unavailable; using lexical retrieval. ${err.message}`, 'error'); }
    }else{
      evidence = await rankEvidence(query);
    }
    const result = await apiRequest('/api/answer', {
      question: query, evidence,
      model: state.settings.model && (state.settings.modelKey || state.settings.baseUrl)
        ? { apiKey: state.settings.modelKey, baseUrl: state.settings.baseUrl, model: state.settings.model } : null,
    });
    const citations = evidence.map((item, index) => {
      const u = safeExternalUrl(item.url);
      return `<div class="citation"><strong>[S${index + 1}]</strong> ${escapeHtml(item.title)} · ${escapeHtml(item.accessLabel)} · ${escapeHtml(item.relationship || 'retrieved source')}${u ? ` · <a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">open source</a>` : ''}</div>`;
    }).join('');
    document.getElementById(loadingId).outerHTML =
      `<div class="msg msg-assistant"><span class="avatar" aria-hidden="true">${SPARK}</span><div><strong>${result.mode === 'model' ? 'Evidence-grounded synthesis' : 'Evidence passages'}${result.model ? ` · ${escapeHtml(result.model)}` : ''}</strong><div class="answer">${renderAnswerText(result.answer)}</div><div class="citations">${citations}</div></div></div>`;
    $('#answerMode').textContent = result.mode === 'model'
      ? (retrievalMode === 'semantic' ? 'GraphRAG + AI' : retrievalMode === 'metadata' ? 'Access metadata + AI' : 'LLM + lexical graph')
      : (retrievalMode === 'semantic' ? 'Semantic GraphRAG' : retrievalMode === 'metadata' ? 'Access metadata' : 'Lexical graph search');
    if (retrievalMode !== 'metadata' && evidence.some(i => i.reranked)) $('#answerMode').textContent += ' + rerank';
  }catch (err){
    const el = document.getElementById(loadingId);
    if (el) el.outerHTML = `<div class="msg msg-assistant"><span class="avatar" aria-hidden="true">!</span><div><strong>Could not complete the answer</strong><p>${escapeHtml(err.message)}</p></div></div>`;
  }finally{
    $('#chatInput').disabled = state.documents.length === 0;
    $('#sendQuestion').disabled = state.documents.length === 0;
    messages.scrollTop = messages.scrollHeight;
    $('#chatInput').focus();
  }
}

/* ---------- settings / sample ---------- */
function openSettings(){
  $('#unpaywallEmail').value = state.settings.email;
  $('#coreApiKey').value = state.settings.coreApiKey;
  $('#embeddingBase').value = state.settings.embeddingBase;
  $('#embeddingModel').value = state.settings.embeddingModel;
  $('#embeddingKey').value = state.settings.embeddingKey;
  $('#modelBase').value = state.settings.baseUrl;
  $('#modelName').value = state.settings.model;
  $('#modelKey').value = state.settings.modelKey;
  const d = $('#settingsDialog');
  if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
}
function closeSettings(){ const d = $('#settingsDialog'); if (d.open) d.close(); }
function saveSettings(){
  state.settings = {
    email: $('#unpaywallEmail').value.trim(), coreApiKey: $('#coreApiKey').value.trim(),
    embeddingBase: $('#embeddingBase').value.trim(), embeddingModel: $('#embeddingModel').value.trim(), embeddingKey: $('#embeddingKey').value.trim(),
    baseUrl: $('#modelBase').value.trim(), model: $('#modelName').value.trim(), modelKey: $('#modelKey').value.trim(),
  };
  updateEvidenceControls(); closeSettings(); showToast('Settings are active for this tab.');
}
function clearSettings(){
  ['#unpaywallEmail', '#coreApiKey', '#embeddingBase', '#embeddingModel', '#embeddingKey', '#modelBase', '#modelName', '#modelKey'].forEach(s => { $(s).value = ''; });
  state.settings = { email: '', coreApiKey: '', embeddingBase: '', embeddingModel: '', embeddingKey: '', baseUrl: '', model: '', modelKey: '' };
  state.embeddingCache.clear(); state.embeddingModelUsed = null;
  updateEvidenceControls(); showToast('Optional credentials cleared from this tab.');
}
function loadSample(){
  $('#paperTitle').value = 'Attention Is All You Need';
  $('#paperDoi').value = '10.48550/arXiv.1706.03762';
  $('#paperText').value = demoText;
  state.activeFileName = 'demo-reading-notes.txt';
  $('#uploadLabel').textContent = 'Demo reading notes loaded';
  showToast('Sample paper details are ready. Choose “Trace its references”.');
  $('#paperTitle').focus();
}

/* ---------- events ---------- */
function bindEvents(){
  $('#paperFile').addEventListener('change', e => { const f = e.target.files?.[0]; if (f) loadLocalFile(f); e.target.value = ''; });
  const dz = $('#dropZone');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragging'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragging'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('dragging'); const f = e.dataTransfer.files?.[0]; if (f) loadLocalFile(f); });
  $('#exploreButton').addEventListener('click', explorePaper);
  $('#sampleButton').addEventListener('click', loadSample);
  $('#backButton').addEventListener('click', () => showView('intake'));
  $('#brandHome').addEventListener('click', () => showView('intake'));
  $('#addPaperButton').addEventListener('click', () => { showView('intake'); $('#paperTitle').focus(); });
  $$('.open-settings').forEach(b => b.addEventListener('click', openSettings));
  $('#closeSettings').addEventListener('click', closeSettings);
  $('#saveSettings').addEventListener('click', saveSettings);
  $('#clearSettings').addEventListener('click', clearSettings);
  $('#viewMapBtn').addEventListener('click', () => setCenterView('map'));
  $('#viewListBtn').addEventListener('click', () => setCenterView('list'));
  $$('.filter-btn').forEach(btn => btn.addEventListener('click', () => {
    state.filter = btn.dataset.filter;
    $$('.filter-btn').forEach(t => { const on = t === btn; t.classList.toggle('is-active', on); t.setAttribute('aria-pressed', String(on)); });
    renderReferences();
  }));
  $('#refSearch').addEventListener('input', e => { state.query = e.target.value.trim().toLowerCase(); renderReferences(); });
  $('#chatForm').addEventListener('submit', e => { e.preventDefault(); askQuestion($('#chatInput').value); });
  $$('.suggestion').forEach((btn, i) => btn.addEventListener('click', () => {
    $('#chatInput').value = (i === 0 && state.refs.length && state.paper)
      ? `What ideas connect ${state.paper.title} with its references?` : btn.textContent.trim();
    if (!$('#chatInput').disabled) $('#chatForm').requestSubmit();
    else showToast('Add or index evidence before asking a question.');
  }));
  $('#chatInput').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter'){ e.preventDefault(); $('#chatForm').requestSubmit(); }
  });
}

bindEvents();
updateEvidenceControls();
welcomeMessage('<p>Index a few open copies or use the abstracts found for this paper, then ask a question about the evidence.</p>');
loadServerConfig();
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.refs.length) createGraph(); }, 150);
});

