// ─── STATE ──────────────────────────────────────────────────────────────────
let currentTab = 'text';
let selectedFile = null;

// ─── TAB SWITCHING ───────────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.getElementById('panel-text').classList.toggle('hidden', tab !== 'text');
  document.getElementById('panel-image').classList.toggle('hidden', tab !== 'image');
  document.getElementById('tab-text').classList.toggle('active', tab === 'text');
  document.getElementById('tab-image').classList.toggle('active', tab === 'image');
  hideResults();
}

// ─── CHAR COUNTER ────────────────────────────────────────────────────────────
document.getElementById('text-input').addEventListener('input', function () {
  document.getElementById('char-count').textContent = this.value.length;
});

// ─── DRAG & DROP ─────────────────────────────────────────────────────────────
const dropZone = document.getElementById('drop-zone');
['dragenter', 'dragover'].forEach(e => {
  dropZone.addEventListener(e, ev => { ev.preventDefault(); dropZone.classList.add('drag-over'); });
});
['dragleave', 'drop'].forEach(e => {
  dropZone.addEventListener(e, ev => { ev.preventDefault(); dropZone.classList.remove('drag-over'); });
});
dropZone.addEventListener('drop', ev => {
  const file = ev.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) loadImageFile(file);
  else showToast('Please drop an image file.', 'error');
});

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (file) loadImageFile(file);
}

function loadImageFile(file) {
  selectedFile = file;
  const reader = new FileReader();
  reader.onload = e => {
    const preview = document.getElementById('image-preview');
    preview.src = e.target.result;
    preview.classList.remove('hidden');
    dropZone.querySelector('.drop-inner').classList.add('hidden');
    document.getElementById('btn-clear-image').style.display = 'flex';
  };
  reader.readAsDataURL(file);
  hideResults();
}

function clearImage() {
  selectedFile = null;
  document.getElementById('file-input').value = '';
  document.getElementById('image-preview').classList.add('hidden');
  document.getElementById('image-preview').src = '';
  dropZone.querySelector('.drop-inner').classList.remove('hidden');
  document.getElementById('btn-clear-image').style.display = 'none';
  hideResults();
}

// ─── TEXT ANALYSIS ───────────────────────────────────────────────────────────
async function analyzeText() {
  const text = document.getElementById('text-input').value.trim();
  if (text.length < 20) { showToast('Please enter at least 20 characters.', 'error'); return; }

  const btn = document.getElementById('btn-text-verify');
  setLoading(true, btn);

  try {
    const res = await fetch('/api/analyze-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Analysis failed');
    renderResults(data);
  } catch (err) {
    showToast(err.message || 'Failed to analyze. Try again.', 'error');
    hideResults();
  } finally {
    setLoading(false, btn);
  }
}

// ─── IMAGE ANALYSIS ──────────────────────────────────────────────────────────
async function analyzeImage() {
  if (!selectedFile) { showToast('Please select an image first.', 'error'); return; }

  const btn = document.getElementById('btn-image-verify');
  setLoading(true, btn);

  const formData = new FormData();
  formData.append('image', selectedFile);

  try {
    const res = await fetch('/api/analyze-image', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Analysis failed');
    renderResults(data);
  } catch (err) {
    showToast(err.message || 'Failed to analyze image. Try again.', 'error');
    hideResults();
  } finally {
    setLoading(false, btn);
  }
}

// ─── RENDER RESULTS ──────────────────────────────────────────────────────────
function renderResults(data) {
  const section = document.getElementById('results-section');
  const card = document.getElementById('result-card');
  const spinner = document.getElementById('loading-spinner');

  section.classList.remove('hidden');
  spinner.classList.add('hidden');
  card.classList.remove('hidden');

  const { detection, sources } = data;

  // Verdict badge
  const verdictEl = document.getElementById('verdict-badge');
  const verdictMap = {
    'AI-Generated': { cls: 'verdict-ai', icon: '🤖', label: '🤖 AI-Generated' },
    'Human-Written': { cls: 'verdict-human', icon: '✍️', label: '✍️ Human-Written' },
    'Real Image': { cls: 'verdict-human', icon: '📷', label: '📷 Real Image' },
    'Uncertain': { cls: 'verdict-uncertain', icon: '⚠️', label: '⚠️ Uncertain' },
    'Model loading...': { cls: 'verdict-loading', icon: '⏳', label: '⏳ Model loading...' }
  };
  const v = verdictMap[detection.verdict] || verdictMap['Uncertain'];
  verdictEl.textContent = v.label;
  verdictEl.className = `verdict-badge ${v.cls}`;

  // Confidence tag
  const confEl = document.getElementById('confidence-tag');
  if (detection.confidence) {
    confEl.textContent = detection.confidence + ' Confidence';
    confEl.style.display = '';
  } else {
    confEl.style.display = 'none';
  }

  // Score bars
  const aiPct = detection.aiProbability;
  const humanPct = detection.humanProbability;

  if (aiPct !== null && aiPct !== undefined) {
    document.getElementById('ai-pct').textContent = aiPct + '%';
    document.getElementById('human-pct').textContent = humanPct + '%';
    setTimeout(() => {
      document.getElementById('ai-bar').style.width = aiPct + '%';
      document.getElementById('human-bar').style.width = humanPct + '%';
    }, 50);
  } else {
    document.getElementById('ai-pct').textContent = '—';
    document.getElementById('human-pct').textContent = '—';
    document.getElementById('ai-bar').style.width = '0';
    document.getElementById('human-bar').style.width = '0';
  }

  // Note
  const noteEl = document.getElementById('result-note');
  if (detection.note) {
    noteEl.textContent = '⚠️ ' + detection.note;
    noteEl.classList.remove('hidden');
  } else {
    noteEl.classList.add('hidden');
  }

  // Sources
  const sourcesSection = document.getElementById('sources-section');
  const sourcesList = document.getElementById('sources-list');
  const noSources = document.getElementById('no-sources');

  if (sources && sources.length > 0) {
    sourcesSection.classList.remove('hidden');
    noSources.classList.add('hidden');
    sourcesList.innerHTML = sources.map(s => `
      <a class="source-item" href="${escHtml(s.url)}" target="_blank" rel="noopener noreferrer">
        ${s.thumbnail ? `<img class="source-thumb" src="${escHtml(s.thumbnail)}" alt="" onerror="this.style.display='none'"/>` : ''}
        <div class="source-title">${escHtml(s.title || 'Source')}</div>
        <div class="source-url">${escHtml(s.displayUrl || s.url || '')}</div>
        ${s.snippet ? `<div class="source-snippet">${escHtml(s.snippet)}</div>` : ''}
      </a>
    `).join('');
  } else {
    sourcesSection.classList.add('hidden');
    noSources.classList.remove('hidden');
  }

  // Scroll to results
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function setLoading(loading, btn) {
  const section = document.getElementById('results-section');
  const spinner = document.getElementById('loading-spinner');
  const card = document.getElementById('result-card');

  if (loading) {
    section.classList.remove('hidden');
    spinner.classList.remove('hidden');
    card.classList.add('hidden');
    btn.disabled = true;
    btn.innerHTML = `<div class="btn-spinner"></div> Analyzing...`;
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    spinner.classList.add('hidden');
    btn.disabled = false;
    btn.innerHTML = currentTab === 'text'
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Verify Authenticity`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Analyze Image`;
  }
}

function hideResults() {
  document.getElementById('results-section').classList.add('hidden');
  document.getElementById('result-card').classList.add('hidden');
  document.getElementById('ai-bar').style.width = '0';
  document.getElementById('human-bar').style.width = '0';
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let toastTimer;
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

// Add inline style for btn spinner
const style = document.createElement('style');
style.textContent = `.btn-spinner{width:14px;height:14px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:spin 0.75s linear infinite;display:inline-block;}`;
document.head.appendChild(style);

// ─── KEYBOARD SHORTCUT ───────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if (currentTab === 'text') analyzeText();
    else analyzeImage();
  }
});
