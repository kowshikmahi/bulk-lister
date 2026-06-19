// popup.js – Bulk Lister Pro Popup Controller (FIXED v1.0.1)

const $ = id => document.getElementById(id);

let selectedDomain = 'ebay.com';
let userBlacklist = [];
let sessionLog = [];
let isRunning = false;
let pollInterval = null;

// ── Init ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await loadApiKeys();
  await loadUserBlacklist();
  await loadSessionState();
  initTabs();
  initDomainBadges();
  initUrlCounter();
  initSlider();
  bindButtons();
  bindApiKeyToggles();
  listenToBackground();
  startPolling(); // Poll storage for updates when background sends while popup is closed
});

// ── Polling ───────────────────────────────────────────────────────────────
// Even if popup missed background messages, this catches up via storage
function startPolling() {
  pollInterval = setInterval(async () => {
    const s = await chrome.storage.local.get(['sessionStats', 'sessionLog', 'isRunning']);
    if (s.sessionStats) updateCounters(s.sessionStats);
    if (Array.isArray(s.sessionLog) && s.sessionLog.length !== sessionLog.length) {
      sessionLog = s.sessionLog;
      renderLog();
    }
    // Sync running state
    if (s.isRunning !== undefined && s.isRunning !== isRunning) {
      setRunningUI(s.isRunning);
    }
  }, 1500);
}

// ── Tab Navigation ────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      $('tab-' + tab.dataset.tab).classList.add('active');
    });
  });
}

// ── Domain Badges ─────────────────────────────────────────────────────────
function initDomainBadges() {
  document.querySelectorAll('.domain-badge').forEach(badge => {
    badge.addEventListener('click', () => {
      document.querySelectorAll('.domain-badge').forEach(b => b.classList.remove('active'));
      badge.classList.add('active');
      selectedDomain = badge.dataset.domain;
    });
  });
}

// ── URL Counter ───────────────────────────────────────────────────────────
function initUrlCounter() {
  $('urlInput').addEventListener('input', () => {
    const urls = getUrls();
    $('urlCount').textContent = `${urls.length} URL${urls.length !== 1 ? 's' : ''}`;
  });
}

function getUrls() {
  return $('urlInput').value
    .split('\n')
    .map(u => u.trim())
    .filter(u => u.startsWith('http'));
}

// ── Slider Sync ───────────────────────────────────────────────────────────
function initSlider() {
  const num = $('tabCount');
  const slider = $('tabSlider');
  num.addEventListener('input', () => { slider.value = num.value; });
  slider.addEventListener('input', () => { num.value = slider.value; });
}

// ── Load Settings ─────────────────────────────────────────────────────────
async function loadSettings() {
  const s = await chrome.storage.local.get('settings');
  const cfg = s.settings || {};
  if (cfg.tabCount)  { $('tabCount').value = cfg.tabCount; $('tabSlider').value = cfg.tabCount; }
  if (cfg.fbaOnly !== undefined)    $('fbaOnly').checked = cfg.fbaOnly;
  if (cfg.aiOptimize !== undefined) $('aiOptimize').checked = cfg.aiOptimize;
  if (cfg.autoClose !== undefined)  $('autoClose').checked = cfg.autoClose;
  if (cfg.closeTimeout) $('closeTimeout').value = cfg.closeTimeout;
  if (cfg.perfMode !== undefined)   $('perfMode').checked = cfg.perfMode;
  if (cfg.aiModel)   $('aiModel').value = cfg.aiModel;
  if (cfg.delayMin)  $('delayMin').value = cfg.delayMin;
  if (cfg.delayMax)  $('delayMax').value = cfg.delayMax;
  if (cfg.domain) {
    selectedDomain = cfg.domain;
    document.querySelectorAll('.domain-badge').forEach(b => {
      b.classList.toggle('active', b.dataset.domain === selectedDomain);
    });
  }
}

async function saveSettings() {
  const cfg = {
    tabCount: parseInt($('tabCount').value),
    fbaOnly: $('fbaOnly').checked,
    aiOptimize: $('aiOptimize').checked,
    autoClose: $('autoClose').checked,
    closeTimeout: parseInt($('closeTimeout').value),
    perfMode: $('perfMode').checked,
    aiModel: $('aiModel').value,
    delayMin: parseInt($('delayMin').value),
    delayMax: parseInt($('delayMax').value),
    domain: selectedDomain,
  };
  await chrome.storage.local.set({ settings: cfg });
  showToast('Settings saved ✓');
}

// ── API Keys ──────────────────────────────────────────────────────────────
async function loadApiKeys() {
  const s = await chrome.storage.local.get('apiKeys');
  const k = s.apiKeys || {};
  if (k.openai)        $('openaiKey').value = k.openai;
  if (k.captcha)       $('captchaKey').value = k.captcha;
  if (k.ebayCookie)    $('ebayCookie').value = k.ebayCookie;
  if (k.captchaProvider) {
    document.querySelectorAll('.captcha-provider-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.provider === k.captchaProvider);
    });
  }
}

async function saveApiKeys() {
  const provider = document.querySelector('.captcha-provider-btn.active')?.dataset.provider || '2captcha';
  await chrome.storage.local.set({
    apiKeys: {
      openai: $('openaiKey').value.trim(),
      captcha: $('captchaKey').value.trim(),
      captchaProvider: provider,
      ebayCookie: $('ebayCookie').value.trim(),
    }
  });
  showToast('API Keys saved ✓');
}

function bindApiKeyToggles() {
  document.querySelectorAll('.show-key-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = $(btn.dataset.target);
      inp.type = inp.type === 'password' ? 'text' : 'password';
      btn.textContent = inp.type === 'password' ? '👁' : '🙈';
    });
  });
  document.querySelectorAll('.captcha-provider-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.captcha-provider-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

// ── User Blacklist ────────────────────────────────────────────────────────
async function loadUserBlacklist() {
  const s = await chrome.storage.local.get('userBlacklist');
  userBlacklist = s.userBlacklist || [];
  renderBlacklist();
}

function renderBlacklist() {
  const container = $('userBlacklistTags');
  if (!userBlacklist.length) {
    container.innerHTML = '<span style="color:var(--text-muted);font-size:11px">No keywords yet</span>';
    return;
  }
  container.innerHTML = userBlacklist.map((kw, i) => `
    <div class="tag">${kw}<span class="rm" data-i="${i}">×</span></div>
  `).join('');
  container.querySelectorAll('.rm').forEach(btn => {
    btn.addEventListener('click', async () => {
      userBlacklist.splice(parseInt(btn.dataset.i), 1);
      await chrome.storage.local.set({ userBlacklist });
      renderBlacklist();
    });
  });
}

async function addKeyword() {
  const kw = $('newKeyword').value.trim().toLowerCase();
  if (!kw || userBlacklist.includes(kw)) return;
  userBlacklist.push(kw);
  await chrome.storage.local.set({ userBlacklist });
  $('newKeyword').value = '';
  renderBlacklist();
}

// ── Session State ─────────────────────────────────────────────────────────
async function loadSessionState() {
  const s = await chrome.storage.local.get(['sessionStats', 'sessionLog', 'isRunning']);
  if (s.sessionStats) updateCounters(s.sessionStats);
  if (Array.isArray(s.sessionLog)) { sessionLog = s.sessionLog; renderLog(); }
  if (s.isRunning) setRunningUI(true);
}

function updateCounters(stats) {
  $('cntTotal').textContent   = stats.total   || 0;
  $('cntSuccess').textContent = stats.success || 0;
  $('cntFailed').textContent  = stats.failed  || 0;
  $('cntSkipped').textContent = stats.skipped || 0;

  const done  = (stats.success || 0) + (stats.failed || 0) + (stats.skipped || 0);
  const total = stats.total || 0;
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
  $('progressBar').style.width = pct + '%';
  $('progressPct').textContent = pct + '%';
  $('progressText').textContent = total > 0 ? `Processing ${done} of ${total}` : 'Not started';
}

function renderLog() {
  const log = $('statusLog');
  if (!sessionLog.length) {
    log.innerHTML = '<div class="empty-log">No activity yet. Start Bulk Lister to see results here.</div>';
    return;
  }
  log.innerHTML = [...sessionLog].reverse().map(e => `
    <div class="log-entry">
      <div class="log-dot ${e.status}"></div>
      <div style="flex:1;min-width:0">
        <div class="log-reason">${e.message}</div>
        <div class="log-url">${e.url || ''}</div>
      </div>
      <div style="margin-left:8px;font-size:10px;color:var(--text-muted);white-space:nowrap">${e.time || ''}</div>
    </div>
  `).join('');
}

// ── Buttons ───────────────────────────────────────────────────────────────
function bindButtons() {
  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('saveApiBtn').addEventListener('click', saveApiKeys);
  $('addKeywordBtn').addEventListener('click', addKeyword);
  $('newKeyword').addEventListener('keydown', e => { if (e.key === 'Enter') addKeyword(); });
  $('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('clearLogBtn').addEventListener('click', clearLog);
  $('exportCsvBtn').addEventListener('click', exportCsv);
  $('startBtn').addEventListener('click', startListing);
  $('stopBtn').addEventListener('click', stopListing);
  $('pauseBtn').addEventListener('click', pauseListing);
}

async function startListing() {
  const urls = getUrls();
  if (!urls.length) { showToast('⚠ Paste at least one Amazon URL first'); return; }

  await saveSettings();

  const [settingsData, apiData, blData] = await Promise.all([
    chrome.storage.local.get('settings'),
    chrome.storage.local.get('apiKeys'),
    chrome.storage.local.get('userBlacklist'),
  ]);

  const settings = settingsData.settings || {};
  const apiKeys  = apiData.apiKeys || {};
  const userBL   = blData.userBlacklist || [];

  if (settings.aiOptimize && !apiKeys.openai) {
    showToast('⚠ Add OpenAI API key in the API Keys tab, or disable AI Optimization');
    return;
  }

  // Reset session counters
  const stats = { total: urls.length, success: 0, failed: 0, skipped: 0 };
  sessionLog = [];
  await chrome.storage.local.set({ sessionStats: stats, sessionLog: [], isRunning: true });

  updateCounters(stats);
  renderLog();
  setRunningUI(true);

  // Send to background
  try {
    await chrome.runtime.sendMessage({
      action: 'START_LISTING',
      urls,
      domain: selectedDomain,
      settings,
      apiKeys,
      userBlacklist: userBL,
    });
    showToast('🚀 Bulk Lister started!');
  } catch (e) {
    setRunningUI(false);
    showToast('❌ Failed to contact background. Try reloading the extension.');
    console.error('START_LISTING error:', e);
  }
}

async function stopListing() {
  try {
    await chrome.runtime.sendMessage({ action: 'STOP_LISTING' });
  } catch (_) {}
  await chrome.storage.local.set({ isRunning: false });
  setRunningUI(false);
  addLogEntry('info', 'Session stopped by user.', '');
  showToast('⏹ Stopped');
}

async function pauseListing() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'PAUSE_LISTING' });
    showToast(resp?.paused ? '⏸ Paused' : '▶ Resumed');
  } catch (_) {}
}

function setRunningUI(running) {
  isRunning = running;
  const badge = $('statusBadge');
  if (running) {
    badge.className = 'status-badge running';
    badge.innerHTML = '<span class="pulse">●</span> Running';
    $('startBtn').style.display = 'none';
    $('stopBtn').style.display = '';
    $('pauseBtn').style.display = '';
  } else {
    badge.className = 'status-badge idle';
    badge.innerHTML = '● Idle';
    $('startBtn').style.display = '';
    $('stopBtn').style.display = 'none';
    $('pauseBtn').style.display = 'none';
  }
}

// ── Background Message Listener ───────────────────────────────────────────
function listenToBackground() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'SESSION_UPDATE') {
      if (msg.stats) updateCounters(msg.stats);
      if (msg.logEntry) addLogEntry(msg.logEntry.status, msg.logEntry.message, msg.logEntry.url);
    }
    if (msg.action === 'SESSION_DONE') {
      setRunningUI(false);
      chrome.storage.local.set({ isRunning: false });
      addLogEntry('info',
        `✅ Session complete – Listed: ${msg.stats?.success || 0} | Failed: ${msg.stats?.failed || 0} | Skipped: ${msg.stats?.skipped || 0}`,
        ''
      );
    }
  });
}

function addLogEntry(status, message, url) {
  const entry = { status, message, url, time: new Date().toLocaleTimeString() };
  sessionLog.push(entry);
  chrome.storage.local.set({ sessionLog });
  renderLog();
}

// ── Log Actions ───────────────────────────────────────────────────────────
async function clearLog() {
  sessionLog = [];
  await chrome.storage.local.set({ sessionLog: [] });
  renderLog();
}

function exportCsv() {
  if (!sessionLog.length) { showToast('No log data to export'); return; }
  const csv = [
    'Status,Message,URL,Time',
    ...sessionLog.map(e => `"${e.status}","${(e.message||'').replace(/"/g,'""')}","${e.url || ''}","${e.time || ''}"`)
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bulk-lister-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Toast ─────────────────────────────────────────────────────────────────
function showToast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    t.style.cssText = `position:fixed;bottom:14px;left:50%;transform:translateX(-50%);
      background:#1a2240;color:#e2e8f0;border:1px solid #4f6ef7;border-radius:8px;
      padding:8px 16px;font-size:12px;z-index:9999;white-space:nowrap;pointer-events:none`;
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.style.opacity = '0'; }, 2500);
}
