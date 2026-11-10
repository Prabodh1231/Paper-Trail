const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  paper: null,
  refs: [],
  documents: [],
  filter: 'all',
  selectedRefId: null,
  settings: { email: '', coreApiKey: '', embeddingBase: '', embeddingModel: '', embeddingKey: '', baseUrl: '', model: '', modelKey: '' },
  activeFileName: '',
  pdfjs: null,
  embeddingCache: new Map(),
};

const demoText = `Demo reading notes\n\nThis short, original demo summary describes a sequence modeling paper that proposes a Transformer architecture based on attention, with encoder and decoder stacks built from self-attention and feed-forward layers. It reports that this design can be trained in parallel and compares favorably with recurrent and convolutional sequence models on translation tasks. These notes are included only to demonstrate the reading workflow; they are not the paper's full text.\n\nReferences\n[1] Bahdanau, D., Cho, K., and Bengio, Y. Neural Machine Translation by Jointly Learning to Align and Translate. 2014. DOI: 10.48550/arXiv.1409.0473\n[2] Sutskever, I., Vinyals, O., and Le, Q. V. Sequence to Sequence Learning with Neural Networks. 2014. DOI: 10.48550/arXiv.1409.3215\n[3] Hochreiter, S. and Schmidhuber, J. Long Short-Term Memory. Neural Computation, 1997. DOI: 10.1162/neco.1997.9.8.1735\n[4] Cho, K. et al. Learning Phrase Representations using RNN Encoder-Decoder for Statistical Machine Translation. 2014. DOI: 10.3115/v1/D14-1179`;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function safeExternalUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

function safeHttpsUrl(value) {
  const url = safeExternalUrl(value);
  return url.startsWith('https:') ? url : '';
}

function normalizeDoi(value) {
  const match = String(value || '').match(/10\.\d{4,9}\/[\w.()/:;-]+/i);
  return match ? match[0].replace(/[.,;]+$/, '').toLowerCase() : '';
}

function showToast(message, kind = 'success') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', kind === 'error');
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 3600);
}

function setBusy(button, busy, label = 'Working…') {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.innerHTML;
    button.innerHTML = `<span class="button-spinner"></span><span>${escapeHtml(label)}</span>`;
    button.disabled = true;
  } else {
    button.innerHTML = button.dataset.originalText || button.innerHTML;
    button.disabled = false;
  }
}

function apiRequest(path, payload, options = {}) {
  return fetch(path, {
    method: options.method || 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  }).then(async (response) => {
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${response.status}).`);
    }
    return options.raw ? response : response.json();
  });
}

function inferTitle(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const excluded = /^(abstract|introduction|keywords|contents|references|bibliography|doi:|arxiv:|preprint|copyright)/i;
  const candidate = lines.slice(0, 18).find((line) => line.length >= 14 && line.length <= 220 && !excluded.test(line) && !/^\d+(\.\d+)*\s/.test(line));
  return candidate ? candidate.replace(/\s+/g, ' ') : '';
}

function extractDoi(text) {
  return normalizeDoi(text);
}

function extractReferenceTitle(raw) {
  const quoted = String(raw).match(/[“"]([^”"]{12,})[”"]|‘([^’]{12,})’/);
  if (quoted) return (quoted[1] || quoted[2]).trim();
  const withoutDoi = String(raw)
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/doi\s*:?\s*10\.\d{4,9}\/[\w.()/:;-]+/gi, ' ')
    .replace(/^\s*(?:\[\d+\]|\(\d+\)|\d+[.)])\s*/, ' ');
  const parts = withoutDoi.split(/\.\s+(?=[A-Z“"\[])/).map((part) => part.trim()).filter(Boolean);
  const meaningful = parts.filter((part) => part.length > 24 && !/^(vol\.?|pp?\.?|journal|proceedings|arxiv|https?:)/i.test(part));
  if (meaningful.length >= 2) {
    const likely = meaningful.find((part) => /\b(?:19|20)\d{2}\b/.test(part)) || meaningful[1];
    return likely.replace(/\b(?:19|20)\d{2}\b/g, '').replace(/[,:;]+$/, '').trim();
  }
  if (meaningful.length === 1) return meaningful[0].replace(/\b(?:19|20)\d{2}\b/g, '').trim();
  return withoutDoi.replace(/\b(?:19|20)\d{2}\b/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function extractReferences(text) {
  const source = String(text || '').replace(/\u0000/g, ' ');
  // Prefer the LAST line that is only a reference-section heading ("References",
  // "7. REFERENCES", "Bibliography:"), so a body sentence mentioning "references"
  // does not truncate the paper. Fall back to the last inline heading that is
  // immediately followed by a first numbered entry.
  const headingLines = [...source.matchAll(/^[ \t]*(?:\d{1,2}\.?[ \t]*)?(?:references|bibliography|works cited|literature cited)[ \t]*:?[ \t]*$/gim)];
  const inlineHeadings = headingLines.length ? [] : [...source.matchAll(/\b(?:references|bibliography|works cited|literature cited)\b:?\s*(?=(?:\[1\]|\(1\)|1[.)])\s)/gi)];
  const heading = headingLines.at(-1) || inlineHeadings.at(-1);
  let section = heading ? source.slice(heading.index + heading[0].length) : '';
  if (!section) {
    const doiMatches = [...source.matchAll(/(?:\[\d+\]|\d+[.)])[^\n]{12,}?10\.\d{4,9}\/[\w.()/:;-]+/gi)];
    section = doiMatches.map((match) => match[0]).join('\n');
  }
  section = section.split(/\n\s*\n\s*(?:appendix|acknowledg(?:e)?ments|author contributions|supplementary|funding|conflict of interest)\b/i)[0];
  const numbered = [...section.matchAll(/(?:^|\n)\s*(?:\[(\d{1,3})\]|\((\d{1,3})\)|(\d{1,3})[.)])\s+/g)];
  let entries = [];
  if (numbered.length > 1) {
    entries = numbered.map((match, index) => {
      const start = match.index + match[0].length;
      const end = index + 1 < numbered.length ? numbered[index + 1].index : section.length;
      return section.slice(start, end).replace(/\s*\n\s*/g, ' ').trim();
    });
  } else {
    entries = section.split(/\n+/).map((entry) => entry.trim());
    if (entries.length <= 1) {
      entries = section.split(/(?<=\.)\s+(?=[A-Z][^.!?]{5,}\b(?:19|20)\d{2}\b)/).map((entry) => entry.trim());
    }
  }

  const candidates = entries
    .map((raw) => raw.replace(/^\s*(?:references|bibliography)\s*/i, '').trim())
    .filter((raw) => raw.length >= 26 && /(?:\b(?:19|20)\d{2}\b|10\.\d{4,9}\/|arxiv|proceedings|journal)/i.test(raw));
  const results = [];
  const seen = new Set();
  for (const raw of candidates) {
    const doi = extractDoi(raw);
    const title = extractReferenceTitle(raw);
    const key = (doi || title).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    results.push({ id: `ref-${results.length + 1}-${Math.random().toString(36).slice(2, 7)}`, raw: raw.slice(0, 1200), title, doi, authors: [], year: Number(raw.match(/\b(?:19|20)\d{2}\b/)?.[0]) || null });
    if (results.length >= 30) break;
  }
  return results;
}

function titleShort(value, max = 29) {
  const text = String(value || 'Untitled reference').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function accessLabel(reference) {
  if (reference.access === 'full-text-found') return 'Full text found';
  if (reference.access === 'abstract-only') return 'Abstract only';
  if (reference.access === 'checking') return 'Checking';
  return 'Unavailable';
}

function getSeedDoc() {
  if (!state.paper?.text) return [];
  return [{
    id: 'seed-paper',
    title: state.paper.title || 'Starting paper',
    url: state.paper.doi ? `https://doi.org/${state.paper.doi}` : '',
    accessLabel: state.paper.sourceLabel || (state.paper.text.length > 1500 ? 'main paper text' : 'paper text / abstract'),
    type: 'seed',
    text: state.paper.text,
  }];
}

function updateAbstractDocuments() {
  const seed = getSeedDoc();
  const fulltexts = state.documents.filter((document) => document.type === 'fulltext');
  const indexedRefs = new Set(fulltexts.map((document) => document.refId));
  const abstracts = state.refs.filter((reference) => reference.abstract && !indexedRefs.has(reference.id)).map((reference) => ({
    id: `abstract-${reference.id}`,
    refId: reference.id,
    title: reference.title,
    url: reference.url || reference.doi && `https://doi.org/${reference.doi}` || '',
    accessLabel: 'abstract-only',
    type: 'abstract',
    text: reference.abstract,
  }));
  state.documents = [...seed, ...abstracts, ...fulltexts];
  updateEvidenceControls();
  updateSeedAction();
}

function updateSeedAction() {
  const button = $('#seedIndexButton');
  if (!button) return;
  const hasFullText = state.paper?.sourceLabel === 'main paper text' || (state.paper?.text?.length > 1500 && state.paper?.sourceLabel !== 'abstract-only');
  const location = state.paper?.locations?.find((entry) => safeHttpsUrl(entry.url));
  button.classList.toggle('hidden', !location || hasFullText);
  button.onclick = () => indexReference('__seed__', button);
}

function showView(name) {
  const landing = name === 'landing';
  $('#landingView').classList.toggle('hidden', !landing);
  $('#workspaceView').classList.toggle('hidden', landing);
  $('#crumbLabel').textContent = landing ? 'Reading room' : 'Source graph';
  $('#navWorkspace').classList.toggle('active', landing);
  $('#navSources').classList.toggle('active', !landing);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updatePaperMeta() {
  $('#workspaceTitle').textContent = state.paper?.title || 'Untitled research paper';
  const doi = state.paper?.doi;
  const authors = (state.paper?.authors || []).slice(0, 2).join(', ');
  const identity = [authors, state.paper?.year].filter(Boolean).map(escapeHtml).join(' · ');
  $('#workspaceMeta').innerHTML = `${identity ? `<span>${identity}</span><span> · </span>` : ''}${doi ? `<a href="https://doi.org/${encodeURIComponent(doi)}" target="_blank" rel="noopener noreferrer">DOI ${escapeHtml(doi)}</a><span> · </span>` : ''}<span>${state.refs.length} references parsed</span>`;
}

function createGraph() {
  const canvas = $('#graphCanvas');
  const refs = state.refs;
  if (!refs.length) {
    canvas.innerHTML = '<div class="graph-empty"><span>↗</span><strong>Reference links will appear here</strong><small>Add reference text or use a paper DOI to discover its citation trail.</small></div>';
    return;
  }
  // Size the coordinate system to the rendered canvas so SVG text renders at its real CSS pixel size.
  const w = Math.max(300, Math.round(canvas.clientWidth || 600));
  const h = Math.max(230, Math.round(canvas.clientHeight || 260));
  const cx = w / 2, cy = h / 2 + 2, rx = Math.max(90, w / 2 - 78), ry = Math.max(60, h / 2 - 60);
  const maxLabel = Math.max(10, Math.min(22, Math.floor(w / 22)));
  const points = refs.map((reference, index) => {
    const angle = (-Math.PI / 2) + (2 * Math.PI * index / Math.max(refs.length, 1));
    return { reference, index, x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
  });
  let svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Starting paper connected to ${refs.length} references">`;
  svg += `<circle cx="${cx}" cy="${cy}" r="38" fill="none" stroke="#e6eee7" stroke-dasharray="2 4" />`;
  for (const point of points) {
    const selected = state.selectedRefId === point.reference.id;
    svg += `<path class="graph-edge ${selected ? 'active-edge' : ''}" d="M ${cx} ${cy} Q ${(cx + point.x) / 2 + 5} ${(cy + point.y) / 2 - 6} ${point.x} ${point.y}"/>`;
  }
  svg += `<g class="graph-node seed" transform="translate(${cx} ${cy})"><circle r="32"/><text text-anchor="middle" y="-2">Starting</text><text text-anchor="middle" y="13">paper</text></g>`;
  for (const point of points) {
    const ref = point.reference;
    const kind = ref.access === 'full-text-found' ? 'full' : ref.access === 'abstract-only' ? 'abstract' : 'missing';
    // Readable labels need room: with many references, label nodes by their list number instead.
    const title = escapeHtml(refs.length > 10 ? String(point.index + 1).padStart(2, '0') : titleShort(ref.title, maxLabel));
    svg += `<g class="graph-node ${kind} ${state.selectedRefId === ref.id ? 'selected' : ''}" data-ref-id="${escapeHtml(ref.id)}" transform="translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})" tabindex="0" role="button" aria-label="${escapeHtml(ref.title)} — ${accessLabel(ref)}"><circle r="19"/><text text-anchor="middle" y="${point.y < cy - 10 ? -41 : 35}">${title}</text><text class="node-sub" text-anchor="middle" y="${point.y < cy - 10 ? -26 : 51}">${kind === 'full' ? 'full text' : kind === 'abstract' ? 'abstract' : ref.access === 'checking' ? 'checking' : 'not found'}</text></g>`;
  }
  svg += '</svg>';
  canvas.innerHTML = svg;
  $$('.graph-node[data-ref-id]', canvas).forEach((node) => {
    const activate = () => selectReference(node.dataset.refId);
    node.addEventListener('click', activate);
    node.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } });
  });
}

function renderReference(reference, index) {
  const className = reference.access === 'full-text-found' ? 'full' : reference.access === 'abstract-only' ? 'abstract' : 'missing';
  const statusText = reference.access === 'full-text-found' ? 'Free copy found' : reference.access === 'abstract-only' ? 'Abstract available' : reference.access === 'checking' ? 'Checking sources…' : 'No open copy found';
  const confidence = reference.confidence ? `<span class="badge confidence">${Math.round(reference.confidence * 100)}% match</span>` : '';
  const providerList = (reference.providers || []).slice(0, 3).join(' · ');
  const indexed = state.documents.some((document) => document.type === 'fulltext' && document.refId === reference.id);
  const location = reference.locations?.[0];
  const openUrl = safeExternalUrl(location?.url);
  const locationDetails = location ? [location.host || location.source, location.version, location.license].filter(Boolean).join(' · ') : '';
  const accessButton = reference.access === 'full-text-found' && reference.locations?.some((entry) => safeHttpsUrl(entry.url))
    ? `<button class="ref-action primary index-copy" data-ref-id="${escapeHtml(reference.id)}" type="button" ${indexed ? 'disabled' : ''}>${indexed ? 'Indexed ✓' : 'Index free copy'}</button>`
    : '';
  const linkButton = openUrl
    ? `<a class="ref-action" href="${escapeHtml(openUrl)}" target="_blank" rel="noopener noreferrer">Open source <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6m0-6-9 9"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/></svg></a>`
    : reference.doi ? `<a class="ref-action" href="https://doi.org/${encodeURIComponent(reference.doi)}" target="_blank" rel="noopener noreferrer">View DOI <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6m0-6-9 9"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/></svg></a>` : '';
  return `<article class="reference-item ${state.selectedRefId === reference.id ? 'reference-selected' : ''}" id="ref-card-${escapeHtml(reference.id)}">
    <span class="ref-number">${String(index + 1).padStart(2, '0')}</span>
    <div class="ref-copy"><h3 class="ref-title">${escapeHtml(reference.title || reference.raw || 'Untitled reference')}</h3>
      <p class="ref-meta">${escapeHtml((reference.authors || []).slice(0, 3).join(', ') || 'Authors not resolved')}${reference.year ? ` · ${escapeHtml(reference.year)}` : ''}${reference.doi ? ` · DOI ${escapeHtml(reference.doi)}` : ''}</p>
      <div class="ref-badges"><span class="badge ${className}">${statusText}</span>${confidence}${providerList ? `<span class="badge">${escapeHtml(providerList)}</span>` : ''}${locationDetails ? `<span class="badge">${escapeHtml(locationDetails)}</span>` : ''}</div>
    </div><div class="ref-actions">${accessButton}${linkButton}</div></article>`;
}

function renderReferences() {
  const list = $('#referencesList');
  const empty = $('#emptyReferences');
  const refs = state.refs.filter((reference) => state.filter === 'all' || reference.access === state.filter);
  list.innerHTML = refs.map((reference) => renderReference(reference, state.refs.indexOf(reference))).join('');
  empty.classList.toggle('hidden', state.refs.length > 0);
  list.classList.toggle('hidden', state.refs.length === 0);
  $$('.index-copy', list).forEach((button) => button.addEventListener('click', () => indexReference(button.dataset.refId, button)));
  $('#graphCount').textContent = String(state.refs.length);
  $('#allCount').textContent = String(state.refs.length);
  $('#fullCount').textContent = String(state.refs.filter((reference) => reference.access === 'full-text-found').length);
  $('#abstractCount').textContent = String(state.refs.filter((reference) => reference.access === 'abstract-only').length);
  const full = state.refs.filter((reference) => reference.access === 'full-text-found').length;
  const abstract = state.refs.filter((reference) => reference.access === 'abstract-only').length;
  const unavailable = state.refs.filter((reference) => !['full-text-found', 'abstract-only', 'checking'].includes(reference.access)).length;
  $('#summaryFull').textContent = String(full);
  $('#summaryAbstract').textContent = String(abstract);
  $('#summaryUnavailable').textContent = String(unavailable);
  const accessPct = state.refs.length ? Math.round((full + abstract * 0.45) / state.refs.length * 100) : 0;
  $('#accessMeterFill').style.width = `${accessPct}%`;
  $('#accessSummaryNote').textContent = state.refs.length
    ? `${full} full-text copies and ${abstract} abstracts can currently contribute evidence.`
    : 'We’ll check free-to-read locations for each reference.';
  createGraph();
  updateEvidenceControls();
}

function selectReference(refId) {
  state.selectedRefId = refId;
  const reference = state.refs.find((entry) => entry.id === refId);
  renderReferences();
  const card = $(`#ref-card-${CSS.escape(refId)}`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (reference) showToast(`${titleShort(reference.title, 55)} · ${accessLabel(reference)}`);
}

function updateEvidenceControls() {
  const totalChars = state.documents.reduce((sum, document) => sum + String(document.text || '').length, 0);
  const hasAny = state.documents.some((document) => String(document.text || '').trim().length > 0);
  $('#chatInput').disabled = !hasAny;
  $('#sendQuestion').disabled = !hasAny;
  const sourceCount = state.documents.filter((document) => document.type !== 'seed').length + (state.documents.some((document) => document.type === 'seed') ? 1 : 0);
  $('#evidenceCount').textContent = `${sourceCount} source${sourceCount === 1 ? '' : 's'} indexed · ${Math.round(totalChars / 1000)}k chars`;
  const hasEmbeddings = state.settings.embeddingModel && state.settings.embeddingBase;
  const hasChatModel = state.settings.model && (state.settings.modelKey || state.settings.baseUrl);
  $('#answerMode').textContent = hasEmbeddings ? (hasChatModel ? 'GraphRAG + AI' : 'Semantic GraphRAG') : (hasChatModel ? 'LLM + lexical graph' : 'Lexical graph search');
}

function showWorkspace() {
  updatePaperMeta();
  showView('workspace');
}

async function explorePaper() {
  const title = $('#paperTitle').value.trim() || inferTitle($('#paperText').value);
  const doi = normalizeDoi($('#paperDoi').value || $('#paperText').value);
  const text = $('#paperText').value.trim();
  if (!title && !doi && !text) {
    showToast('Add a paper title, DOI, text, or PDF to get started.', 'error');
    return;
  }
  if (text.length < 200 && !doi && !title) {
    showToast('Add more paper text or a DOI so reference discovery has enough context.', 'error');
    return;
  }

  const button = $('#exploreButton');
  setBusy(button, true, 'Following references…');
  $('#noticeBar').classList.add('hidden');
  state.paper = { title: title || 'Research paper', doi, text, fileName: state.activeFileName };
  state.embeddingCache.clear();
  state.refs = extractReferences(text);
  state.documents = getSeedDoc();
  $('#chatMessages').innerHTML = '<div class="assistant-message welcome-message"><span class="assistant-avatar">✳</span><div><strong>Looking across the literature</strong><p>Matching reference details and checking legal open-access locations. This can take a few seconds.</p></div></div>';
  updateAbstractDocuments();
  showWorkspace();

  try {
    // Step 1: match the starting paper and, when no bibliography was pasted,
    // discover its references. Reference lookups happen in step 2.
    const result = await apiRequest('/api/resolve', {
      paper: { title: state.paper.title, doi: state.paper.doi, text: state.paper.text.slice(0, 2000) },
      references: [],
      discoverOnly: true,
      skipDiscovery: state.refs.length > 0,
      email: state.settings.email,
      coreApiKey: state.settings.coreApiKey,
    });
    if (state.refs.length) result.references = [];
    if (result.paper) {
      state.paper.title = result.paper.title || state.paper.title;
      state.paper.doi = result.paper.doi || state.paper.doi;
      state.paper.authors = result.paper.authors || [];
      state.paper.year = result.paper.year || null;
      state.paper.locations = result.paper.locations || [];
      if (!state.paper.text && result.paper.abstract) {
        state.paper.text = result.paper.abstract;
        state.paper.sourceLabel = 'abstract-only';
      }
    }
    state.refs = (state.refs.length ? state.refs : result.references || [])
      .map((reference) => ({ ...reference, access: 'checking', status: 'checking', locations: [], providers: [] }));
    updateAbstractDocuments();
    renderReferences();
    updatePaperMeta();

    // Step 2: resolve references a few at a time and render each batch as it lands.
    const BATCH = 3;
    const pending = [...state.refs];
    for (let index = 0; index < pending.length; index += BATCH) {
      const batch = pending.slice(index, index + BATCH);
      setBusy(button, false);
      setBusy(button, true, `Checking ${Math.min(index + BATCH, pending.length)} of ${pending.length}…`);
      let updates;
      try {
        const batchResult = await apiRequest('/api/resolve', {
          paper: {},
          references: batch.map(({ id, raw, title, doi, authors, year }) => ({ id, raw, title, doi, authors, year })),
          email: state.settings.email,
          coreApiKey: state.settings.coreApiKey,
        });
        updates = new Map((batchResult.references || []).map((reference) => [reference.id, reference]));
      } catch (error) {
        updates = new Map(batch.map((reference) => [reference.id, { access: 'unavailable', status: 'not-found', confidence: 0, error: error.message }]));
      }
      state.refs = state.refs.map((reference) => (updates.has(reference.id) ? { ...reference, ...updates.get(reference.id) } : reference));
      updateAbstractDocuments();
      renderReferences();
    }
    const found = state.refs.filter((reference) => reference.access === 'full-text-found').length;
    const abstractCount = state.refs.filter((reference) => reference.access === 'abstract-only').length;
    if (state.refs.length) {
      showToast(`Found ${found} open full-text copies and ${abstractCount} abstracts across ${state.refs.length} references.`);
      const sourceNote = result.referencesFrom && result.referencesFrom !== 'uploaded reference list' ? ` References were discovered from ${escapeHtml(result.referencesFrom)}.` : '';
      $('#chatMessages').innerHTML = `<div class="assistant-message welcome-message"><span class="assistant-avatar">✳</span><div><strong>Your source map is ready</strong><p>Reference abstracts are indexed. Choose “Index free copy” to add full text, then ask about connections across the evidence.${sourceNote}</p></div></div>`;
    } else {
      $('#noticeBar').textContent = state.paper.doi
        ? 'No reference list was found in the text and the citation service returned no reference records. Paste the bibliography or try another paper.'
        : 'No reference list was detected. Paste the bibliography section or add a paper DOI to discover citations.';
      $('#noticeBar').classList.remove('hidden');
      $('#chatMessages').innerHTML = '<div class="assistant-message welcome-message"><span class="assistant-avatar">✳</span><div><strong>Add a reference list</strong><p>Ctrl+V could not find references in the text yet. Go back and paste the bibliography section or enter a DOI.</p></div></div>';
      renderReferences();
    }
  } catch (error) {
    state.refs = state.refs.map((reference) => ({ ...reference, access: 'unavailable', status: 'not-found', confidence: 0, locations: [], providers: [], error: error.message }));
    renderReferences();
    $('#noticeBar').textContent = `The paper text is ready, but reference services could not be reached: ${error.message} You can still ask questions about the paper text in this tab.`;
    $('#noticeBar').classList.remove('hidden');
    $('#chatMessages').innerHTML = '<div class="assistant-message welcome-message"><span class="assistant-avatar">✳</span><div><strong>Paper text is ready</strong><p>External discovery could not connect. Your pasted or extracted paper text is still available for evidence search.</p></div></div>';
    showToast('Could not reach the discovery services.', 'error');
  } finally {
    setBusy(button, false);
  }
}

function loadPdfJs() {
  if (state.pdfjs) return Promise.resolve(state.pdfjs);
  if (state.pdfjsPromise) return state.pdfjsPromise;
  state.pdfjsPromise = import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs')
    .then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
      state.pdfjs = pdfjs;
      return pdfjs;
    });
  return state.pdfjsPromise;
}

async function extractPdfText(data) {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    const parts = [];
    let lastY = null;
    for (const item of content.items) {
      if (!item.str) continue;
      const y = item.transform?.[5] ?? null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2.2) parts.push('\n');
      else if (parts.length && !parts.at(-1).endsWith('\n')) parts.push(' ');
      parts.push(item.str);
      lastY = y;
    }
    pages.push(parts.join(''));
  }
  return pages.join('\n\n');
}

async function loadLocalFile(file) {
  state.activeFileName = file.name;
  $('#uploadLabel').textContent = `Selected: ${file.name}`;
  const extension = file.name.split('.').pop().toLowerCase();
  try {
    let text;
    if (extension === 'pdf' || file.type === 'application/pdf') {
      if (file.size > 24 * 1024 * 1024) throw new Error('The prototype supports PDFs up to 24 MB.');
      text = await extractPdfText(new Uint8Array(await file.arrayBuffer()));
      if (text.trim().length < 120) throw new Error('This PDF has no selectable text. OCR support is not included yet; paste its text or abstract instead.');
      showToast('PDF text extracted in your browser.');
    } else {
      if (file.size > 3 * 1024 * 1024) throw new Error('Text files can be up to 3 MB.');
      text = await file.text();
    }
    $('#paperText').value = text;
    if (!$('#paperTitle').value.trim()) $('#paperTitle').value = inferTitle(text);
    const doi = extractDoi(text);
    if (doi && !$('#paperDoi').value.trim()) $('#paperDoi').value = doi;
    showToast(`${file.name} is ready to explore.`);
  } catch (error) {
    $('#uploadLabel').textContent = 'Drop a PDF here, or browse files';
    showToast(error.message || 'Could not read this file.', 'error');
  }
}

async function indexReference(refId, button) {
  const isSeed = refId === '__seed__';
  const reference = isSeed ? state.paper : state.refs.find((entry) => entry.id === refId);
  if (!reference?.locations?.length) return;
  setBusy(button, true, 'Indexing…');
  try {
    const location = reference.locations.find((entry) => entry.pdfUrl && safeHttpsUrl(entry.url)) || reference.locations.find((entry) => safeHttpsUrl(entry.url));
    if (!location) throw new Error('No secure HTTPS copy is available to index. Open the source link to check access.');
    const response = await apiRequest('/api/proxy-document', { url: location.url }, { raw: true });
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    let text = '';
    if (contentType.includes('pdf') || location.url.toLowerCase().includes('.pdf')) {
      text = await extractPdfText(new Uint8Array(await response.arrayBuffer()));
    } else {
      const raw = await response.text();
      if (contentType.includes('html')) {
        const doc = new DOMParser().parseFromString(raw, 'text/html');
        doc.querySelectorAll('script,style,nav,footer,header,aside,form').forEach((element) => element.remove());
        text = (doc.querySelector('article') || doc.querySelector('main') || doc.body)?.innerText || '';
      } else if (contentType.includes('xml')) {
        const doc = new DOMParser().parseFromString(raw, 'text/xml');
        text = doc.documentElement.textContent || '';
      } else text = raw;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length < 180) throw new Error('The source did not contain enough readable text to index. It may be a landing page or scanned PDF.');
    if (isSeed) {
      state.paper.text = text.slice(0, 180000);
      state.paper.sourceLabel = 'main paper text';
      state.documents = state.documents.filter((document) => document.refId !== '__seed__');
    } else {
      state.documents = state.documents.filter((document) => document.refId !== refId && document.type !== 'abstract');
      state.documents.push({ id: `full-${refId}`, refId, title: reference.title, url: location.url, accessLabel: 'full text', type: 'fulltext', text: text.slice(0, 180000) });
      reference.indexed = true;
    }
    updateAbstractDocuments();
    renderReferences();
    updatePaperMeta();
    showToast(`Indexed ${titleShort(reference.title, 42)} for source-grounded answers.`);
  } catch (error) {
    showToast(error.message || 'Could not index this open copy.', 'error');
  } finally {
    setBusy(button, false);
  }
}

const STOP_WORDS = new Set('a an and are as at be been but by can could did do does for from had has have how i if in into is it its may might of on or our should that the their them then there these they this to was we were what when where which who why will with would you your about across paper papers source sources reference references show tell explain'.split(' '));

function tokenize(text) {
  return String(text || '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)?.filter((word) => !STOP_WORDS.has(word)) || [];
}

function makeChunks(text, maxLength = 1150) {
  const paragraphs = String(text || '').split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9])/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxLength) {
      if (current) { chunks.push(current); current = ''; }
      for (let index = 0; index < paragraph.length; index += maxLength) chunks.push(paragraph.slice(index, index + maxLength));
    } else if ((current + ' ' + paragraph).length > maxLength) {
      if (current) chunks.push(current);
      current = paragraph;
    } else current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) chunks.push(current);
  return chunks;
}

function collectPassages() {
  return state.documents.flatMap((document) => makeChunks(document.text).map((text, index) => ({
    document,
    text,
    chunkIndex: index,
    nodeId: document.type === 'seed' ? 'seed-paper' : document.refId,
  })));
}

function lexicalScore(text, terms, question = '') {
  if (!terms.length) return 0;
  const content = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const occurrences = content.split(term).length - 1;
    if (occurrences) score += 1 + Math.min(occurrences - 1, 2) * .3;
  }
  if (!score) return 0;
  score = Math.min(1, score / Math.sqrt(terms.length * 2));
  if (question && content.includes(question.toLowerCase().trim())) score = Math.min(1, score + .15);
  return score;
}

function expandThroughCitationGraph(scored) {
  if (!scored.length) return [];
  // GraphRAG pass: retrieve likely source nodes, then expand up to two citation hops.
  // The current graph is a seed-paper → cited-reference map, so a reference can
  // expand back through the seed to related cited works.
  const bestByNode = new Map();
  for (const item of scored) bestByNode.set(item.nodeId, Math.max(bestByNode.get(item.nodeId) || 0, item.score));
  const startNodes = [...bestByNode.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([nodeId]) => nodeId);
  const neighbors = new Map([['seed-paper', new Set(state.refs.map((reference) => reference.id))]]);
  for (const reference of state.refs) neighbors.set(reference.id, new Set(['seed-paper']));
  const distances = new Map(startNodes.map((nodeId) => [nodeId, 0]));
  const queue = [...startNodes];
  while (queue.length) {
    const nodeId = queue.shift();
    const distance = distances.get(nodeId) || 0;
    if (distance >= 2) continue;
    for (const neighbor of neighbors.get(nodeId) || []) {
      if (!distances.has(neighbor)) {
        distances.set(neighbor, distance + 1);
        queue.push(neighbor);
      }
    }
  }

  const expanded = scored
    .filter((item) => distances.has(item.nodeId))
    .map((item) => {
      const distance = distances.get(item.nodeId) || 0;
      const graphBoost = distance === 0 ? .18 : distance === 1 ? .09 : .035;
      const relation = item.nodeId === 'seed-paper' ? 'starting paper' : distance === 0 ? 'directly retrieved cited paper' : `linked through ${state.paper?.title || 'the starting paper'}`;
      return { ...item, score: item.score + graphBoost, relation };
    })
    .sort((a, b) => b.score - a.score);
  const perNode = new Map();
  return expanded.filter((item) => {
    const count = perNode.get(item.nodeId) || 0;
    if (count >= 2) return false;
    perNode.set(item.nodeId, count + 1);
    return true;
  }).slice(0, 8).map((item) => ({
    id: item.document.id,
    title: item.document.title,
    url: item.document.url,
    accessLabel: item.document.accessLabel,
    relationship: item.relation,
    text: item.text,
    score: item.score,
  }));
}

function rankEvidence(question) {
  const terms = tokenize(question);
  const scored = collectPassages().map((passage) => ({
    ...passage,
    score: lexicalScore(passage.text, terms, question),
  })).filter((item) => item.score > 0);
  return expandThroughCitationGraph(scored);
}

function embeddingCacheKey(entry) {
  return `${state.settings.embeddingBase}|${state.settings.embeddingModel}|${entry.document.id}|${entry.chunkIndex}|${fingerprint(entry.text)}`;
}

function fingerprint(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return `${text.length}-${(hash >>> 0).toString(36)}`;
}

async function requestEmbeddings(texts) {
  const vectors = [];
  for (let index = 0; index < texts.length; index += 32) {
    const result = await apiRequest('/api/embeddings', {
      texts: texts.slice(index, index + 32),
      baseUrl: state.settings.embeddingBase,
      model: state.settings.embeddingModel,
      apiKey: state.settings.embeddingKey,
    });
    vectors.push(...result.vectors);
  }
  return vectors;
}

function cosineSimilarity(left, right) {
  if (!left?.length || left.length !== right?.length) return 0;
  let dot = 0, leftNorm = 0, rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm && rightNorm ? dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) : 0;
}

async function rankEvidenceSemantic(question) {
  const passages = collectPassages();
  if (!passages.length) return [];
  const entries = passages.map((passage) => ({ ...passage, cacheKey: embeddingCacheKey(passage) }));
  const missing = entries.filter((entry) => !state.embeddingCache.has(entry.cacheKey));
  for (let index = 0; index < missing.length; index += 32) {
    const batch = missing.slice(index, index + 32);
    const vectors = await requestEmbeddings(batch.map((entry) => entry.text));
    batch.forEach((entry, vectorIndex) => state.embeddingCache.set(entry.cacheKey, vectors[vectorIndex]));
  }
  const queryVector = (await requestEmbeddings([question]))[0];
  const terms = tokenize(question);
  const scored = entries.map((entry) => {
    const semantic = cosineSimilarity(queryVector, state.embeddingCache.get(entry.cacheKey));
    const lexical = lexicalScore(entry.text, terms, question);
    return { ...entry, score: semantic * .82 + lexical * .18 };
  }).sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score < .12) return [];
  const floor = Math.max(.08, scored[0].score * .44);
  return expandThroughCitationGraph(scored.filter((item) => item.score >= floor));
}

function renderAnswerText(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[(S\d+)\]/g, '<span class="source-chip">[$1]</span>');
}

// Route to access metadata only when the question is about availability itself
// ("Which sources are abstract-only?"), not when it merely mentions full text
// ("What does the full text say about alignment?").
function isAccessQuestion(query) {
  const access = /\b(abstract.?only|full.?text|free.?cop(?:y|ies)|open.?access|paywall(?:ed)?|availab(?:le|ility)|unavailable|accessible|can i (?:read|access))\b/i;
  const asksAboutAccess = /^\s*(?:which|how many|what(?: share| fraction| proportion)?|are|is|list|show|count)\b[^?]*\b(?:sources?|references?|papers?|copies|works|ones)\b/i;
  const asksAboutContent = /\b(say|says|said|claim|argue|describe|explain|propose|find|found|report|show(?:s|ed)? that|about|mean|method|result)\b/i;
  if (!access.test(query)) return false;
  if (/\b(availability|unavailable|paywall(?:ed)?|abstract.?only|can i (?:read|access))\b/i.test(query) && !asksAboutContent.test(query)) return true;
  return asksAboutAccess.test(query) && !asksAboutContent.test(query);
}

async function askQuestion(question) {
  const query = question.trim();
  if (!query) return;
  const messages = $('#chatMessages');
  messages.querySelector('.welcome-message')?.remove();
  messages.insertAdjacentHTML('beforeend', `<div class="user-message">${escapeHtml(query)}</div>`);
  const loadingId = `answer-${Date.now()}`;
  messages.insertAdjacentHTML('beforeend', `<div id="${loadingId}" class="assistant-message"><span class="assistant-avatar">✳</span><div><strong>Searching your evidence…</strong><p>Retrieving passages and following citation links.</p></div></div>`);
  $('#chatInput').value = '';
  $('#chatInput').disabled = true;
  $('#sendQuestion').disabled = true;
  messages.scrollTop = messages.scrollHeight;
  try {
    let retrievalMode = 'lexical';
    let evidence;
    if (isAccessQuestion(query) && state.refs.length) {
      retrievalMode = 'metadata';
      evidence = state.refs.slice(0, 8).map((reference) => ({
        id: `access-${reference.id}`,
        title: reference.title,
        url: reference.locations?.[0]?.url || reference.url || '',
        accessLabel: 'availability metadata',
        relationship: 'citation graph access record',
        text: `Access status: ${accessLabel(reference)}. Matching sources: ${(reference.providers || []).join(', ') || 'none confirmed'}. ${reference.locations?.[0]?.license ? `Reported license: ${reference.locations[0].license}.` : 'No license was reported by the discovery record.'}`,
      }));
    } else if (state.settings.embeddingModel && state.settings.embeddingBase) {
      retrievalMode = 'semantic';
      try {
        evidence = await rankEvidenceSemantic(query);
        if (!evidence.length) {
          const lexical = rankEvidence(query);
          if (lexical.length) {
            evidence = lexical;
            retrievalMode = 'lexical';
          }
        }
      } catch (error) {
        retrievalMode = 'lexical';
        evidence = rankEvidence(query);
        showToast(`Embeddings unavailable; using lexical retrieval. ${error.message}`, 'error');
      }
    } else {
      evidence = rankEvidence(query);
    }
    const result = await apiRequest('/api/answer', {
      question: query,
      evidence,
      model: state.settings.model && (state.settings.modelKey || state.settings.baseUrl) ? {
        apiKey: state.settings.modelKey,
        baseUrl: state.settings.baseUrl,
        model: state.settings.model,
      } : null,
    });
    const citations = evidence.map((item, index) => {
      const sourceUrl = safeExternalUrl(item.url);
      return `<div class="source-citation"><strong>[S${index + 1}]</strong> ${escapeHtml(item.title)} · ${escapeHtml(item.accessLabel)} · ${escapeHtml(item.relationship || 'retrieved source')}${sourceUrl ? ` · <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">open source</a>` : ''}</div>`;
    }).join('');
    $(`#${loadingId}`).outerHTML = `<div class="assistant-message"><span class="assistant-avatar">✳</span><div><strong>${result.mode === 'model' ? 'Evidence-grounded synthesis' : 'Evidence passages'}${result.model ? ` · ${escapeHtml(result.model)}` : ''}</strong><div class="answer-copy">${renderAnswerText(result.answer)}</div><div class="source-citation-list">${citations}</div></div></div>`;
    $('#answerMode').textContent = result.mode === 'model'
      ? (retrievalMode === 'semantic' ? 'GraphRAG + AI' : retrievalMode === 'metadata' ? 'Access metadata + AI' : 'LLM + lexical graph')
      : (retrievalMode === 'semantic' ? 'Semantic GraphRAG' : retrievalMode === 'metadata' ? 'Access metadata' : 'Lexical graph search');
  } catch (error) {
    const item = $(`#${loadingId}`);
    if (item) item.outerHTML = `<div class="assistant-message"><span class="assistant-avatar">!</span><div><strong>Could not complete the answer</strong><p>${escapeHtml(error.message)}</p></div></div>`;
  } finally {
    $('#chatInput').disabled = state.documents.length === 0;
    $('#sendQuestion').disabled = state.documents.length === 0;
    messages.scrollTop = messages.scrollHeight;
  }
}

function openSettings() {
  $('#unpaywallEmail').value = state.settings.email;
  $('#coreApiKey').value = state.settings.coreApiKey;
  $('#embeddingBase').value = state.settings.embeddingBase;
  $('#embeddingModel').value = state.settings.embeddingModel;
  $('#embeddingKey').value = state.settings.embeddingKey;
  $('#modelBase').value = state.settings.baseUrl;
  $('#modelName').value = state.settings.model;
  $('#modelKey').value = state.settings.modelKey;
  $('#settingsDialog').showModal();
}

function saveSettings() {
  state.settings = {
    email: $('#unpaywallEmail').value.trim(),
    coreApiKey: $('#coreApiKey').value.trim(),
    embeddingBase: $('#embeddingBase').value.trim(),
    embeddingModel: $('#embeddingModel').value.trim(),
    embeddingKey: $('#embeddingKey').value.trim(),
    baseUrl: $('#modelBase').value.trim(),
    model: $('#modelName').value.trim(),
    modelKey: $('#modelKey').value.trim(),
  };
  updateEvidenceControls();
  $('#settingsDialog').close();
  showToast('Settings are active for this tab.');
}

function loadSample() {
  $('#paperTitle').value = 'Attention Is All You Need';
  $('#paperDoi').value = '10.48550/arXiv.1706.03762';
  $('#paperText').value = demoText;
  state.activeFileName = 'demo-reading-notes.txt';
  $('#uploadLabel').textContent = 'Demo reading notes loaded';
  showToast('Sample paper details are ready. Click Explore references.');
  $('#paperTitle').focus();
}

function bindEvents() {
  $('#paperFile').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) loadLocalFile(file);
    event.target.value = '';
  });
  $('#dropZone').addEventListener('dragover', (event) => { event.preventDefault(); $('#dropZone').classList.add('dragging'); });
  $('#dropZone').addEventListener('dragleave', () => $('#dropZone').classList.remove('dragging'));
  $('#dropZone').addEventListener('drop', (event) => {
    event.preventDefault();
    $('#dropZone').classList.remove('dragging');
    const file = event.dataTransfer.files?.[0];
    if (file) loadLocalFile(file);
  });
  $('#exploreButton').addEventListener('click', explorePaper);
  $('#sampleButton').addEventListener('click', loadSample);
  $('#backButton').addEventListener('click', () => showView('landing'));
  $('#addPaperButton').addEventListener('click', () => { showView('landing'); $('#paperTitle').focus(); });
  $('#navWorkspace').addEventListener('click', () => showView(state.paper ? 'workspace' : 'landing'));
  $('#navSources').addEventListener('click', () => {
    if (!state.paper) { showToast('Add a paper first to create its source graph.'); return; }
    showView('workspace');
    $('#graphCanvas').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('#settingsButton').addEventListener('click', openSettings);
  $('#topSettingsButton').addEventListener('click', openSettings);
  $('#closeSettings').addEventListener('click', () => $('#settingsDialog').close());
  $('#saveSettings').addEventListener('click', saveSettings);
  $('#clearSettings').addEventListener('click', () => {
    $('#unpaywallEmail').value = '';
    $('#coreApiKey').value = '';
    $('#embeddingBase').value = '';
    $('#embeddingModel').value = '';
    $('#embeddingKey').value = '';
    $('#modelBase').value = '';
    $('#modelName').value = '';
    $('#modelKey').value = '';
    state.settings = { email: '', coreApiKey: '', embeddingBase: '', embeddingModel: '', embeddingKey: '', baseUrl: '', model: '', modelKey: '' };
    state.embeddingCache.clear();
    updateEvidenceControls();
    showToast('Optional credentials cleared from this tab.');
  });
  $$('.filter-tab').forEach((button) => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    $$('.filter-tab').forEach((tab) => tab.classList.toggle('active', tab === button));
    renderReferences();
  }));
  $('#chatForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#chatInput');
    askQuestion(input.value);
  });
  $$('.suggestion').forEach((button) => button.addEventListener('click', () => {
    const question = button.textContent.trim();
    if (button === $$('.suggestion')[0] && state.refs.length) $('#chatInput').value = `What ideas connect ${state.paper.title} with its references?`;
    else $('#chatInput').value = question;
    if (!$('#chatInput').disabled) $('#chatForm').requestSubmit();
    else showToast('Add or index evidence before asking a question.');
  }));
  $('#chatInput').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      $('#chatForm').requestSubmit();
    }
  });
}

bindEvents();
updateEvidenceControls();
let graphResizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(graphResizeTimer);
  graphResizeTimer = setTimeout(() => { if (state.refs.length) createGraph(); }, 150);
});
