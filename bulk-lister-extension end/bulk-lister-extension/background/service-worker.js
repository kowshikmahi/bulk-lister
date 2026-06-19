// background/service-worker.js – Bulk Lister Pro (FULLY FIXED v1.0.1)
// KEY FIXES:
// 1. No "type: module" - plain service worker (MV3 module mode causes silent failures)
// 2. Use scripting.executeScript() to inject content scripts on demand (no manifest content_scripts)
// 3. return true in onMessage to keep async channel open
// 4. Keep service worker alive with chrome.alarms during active session
// 5. All errors logged to storage so popup can see them

// ── Keep-Alive Alarm ──────────────────────────────────────────────────────
// FIXED: Must NOT call chrome.alarms.create() at top-level — it causes
// "Service worker registration failed. Status code: 15"
// Instead create alarm inside onInstalled and onStartup events.
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // Accessing storage keeps the service worker alive
    chrome.storage.local.get('isRunning').catch(() => {});
  }
});

// ── State ─────────────────────────────────────────────────────────────────
let sessionState = {
  running: false,
  paused: false,
  urls: [],
  currentIndex: 0,
  activeTabs: {},
  stats: { total: 0, success: 0, failed: 0, skipped: 0 },
  settings: {},
  apiKeys: {},
  domain: 'ebay.com',
  userBlacklist: [],
};

// ── Admin Lists (hidden from users) ──────────────────────────────────────
const ADMIN_VERO_BRANDS = {
  'ebay.com':    ['philips','honda','rolex','nike','adidas','apple','samsung','sony','bose','dyson','dewalt','makita','milwaukee'],
  'ebay.co.uk':  ['philips','honda','rolex','nike','adidas','apple','samsung','sony','bose','dyson','dewalt','makita'],
  'ebay.de':     ['philips','honda','rolex','nike','adidas','apple','samsung','sony','bose','dyson'],
  'ebay.com.au': ['philips','honda','rolex','nike','adidas','apple','samsung','sony'],
  'ebay.it':     ['philips','honda','rolex','nike','adidas','apple','samsung'],
  'ebay.fr':     ['philips','honda','rolex','nike','adidas','apple','samsung'],
};

const ADMIN_POLICY_KEYWORDS = {
  'ebay.com':    ['police','weapon','firearm','explosive','narcotic','prescription only','otc medication','over the counter medication'],
  'ebay.co.uk':  ['police','weapon','firearm','explosive','narcotic','controlled drug','prescription only'],
  'ebay.de':     ['polizei','waffe','sprengstoff','betäubungsmittel'],
  'ebay.com.au': ['police','weapon','firearm','explosive','controlled substance'],
  'ebay.it':     ['polizia','arma','esplosivo','narcotico'],
  'ebay.fr':     ['police','arme','explosif','narcotique'],
};

const EBAY_STRIP_PHRASES = [
  'visit our website','check our online store','visit our store',
  'see our website','shop at our website','find us online',
  'our amazon store','available on amazon','sold on amazon',
  'buy on amazon','check amazon','visit amazon',
];

// ── Message Listener ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.action) {
        case 'START_LISTING':
          await startSession(msg);
          sendResponse({ ok: true });
          break;
        case 'STOP_LISTING':
          sessionState.running = false;
          sessionState.paused = false;
          closeAllActiveTabs();
          await chrome.storage.local.set({ isRunning: false });
          sendResponse({ ok: true });
          break;
        case 'PAUSE_LISTING':
          sessionState.paused = !sessionState.paused;
          sendResponse({ paused: sessionState.paused });
          break;
        case 'SCRAPE_RESULT':
          if (sender && sender.tab) {
            await handleScrapeResult(sender.tab.id, msg.data);
          }
          sendResponse({ ok: true });
          break;
        case 'LIST_RESULT':
          if (sender && sender.tab) {
            await handleListResult(sender.tab.id, msg.success, msg.reason);
          }
          sendResponse({ ok: true });
          break;
        case 'CAPTCHA_REQUIRED':
          broadcastUpdate(msg.url || '', {
            status: 'info',
            message: `⚠ Captcha detected on ${msg.page || 'page'} – solver triggered`,
            url: msg.url || '',
          });
          sendResponse({ ok: true });
          break;
        case 'GET_STATE':
          sendResponse({ state: sessionState.running, stats: sessionState.stats });
          break;
        default:
          sendResponse({ ok: false, error: 'Unknown action: ' + msg.action });
      }
    } catch (e) {
      console.error('[BulkLister] Error in message handler:', e);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // CRITICAL: keeps message channel open for async sendResponse
});

// ── Tab Listeners ─────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  if (sessionState.activeTabs[tabId]) {
    delete sessionState.activeTabs[tabId];
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const tabInfo = sessionState.activeTabs[tabId];
  if (!tabInfo) return;

  const url = tab.url || '';

  // Phase: scraping – Amazon page loaded, inject scraper
  if (tabInfo.phase === 'scraping' && url.includes('amazon')) {
    console.log('[BulkLister] Amazon page loaded, injecting scraper into tab', tabId);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/amazon-scraper.js'],
      });
    } catch (e) {
      console.error('[BulkLister] Failed to inject amazon-scraper:', e.message);
      recordResult('failed', tabInfo.url, 'Could not inject scraper: ' + e.message);
      await closeTab(tabId);
    }
    return;
  }

  // Phase: listing – eBay page loaded, inject lister
  if (tabInfo.phase === 'listing' && url.includes('ebay')) {
    console.log('[BulkLister] eBay page loaded, injecting lister into tab', tabId);
    // Store the product data so the content script can read it
    await chrome.storage.local.set({ currentListingData: tabInfo.productData });
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/ebay-lister.js'],
      });
    } catch (e) {
      console.error('[BulkLister] Failed to inject ebay-lister:', e.message);
      recordResult('failed', tabInfo.url, 'Could not inject eBay lister: ' + e.message);
      await closeTab(tabId);
    }
    return;
  }
});

// ── Session Start ─────────────────────────────────────────────────────────
async function startSession(msg) {
  // Reset state completely
  sessionState = {
    running: true,
    paused: false,
    urls: msg.urls,
    currentIndex: 0,
    activeTabs: {},
    stats: { total: msg.urls.length, success: 0, failed: 0, skipped: 0 },
    settings: msg.settings || {},
    apiKeys: msg.apiKeys || {},
    domain: msg.domain || 'ebay.com',
    userBlacklist: msg.userBlacklist || [],
  };

  await chrome.storage.local.set({
    isRunning: true,
    sessionStats: { ...sessionState.stats },
    sessionLog: [],
  });

  console.log('[BulkLister] Session started –', msg.urls.length, 'URLs, domain:', sessionState.domain);
  broadcastUpdate('', { status: 'info', message: `🚀 Session started – ${msg.urls.length} URLs queued on ${sessionState.domain}`, url: '' });

  setTimeout(() => processQueue(), 200);
}

// ── Queue Processor ────────────────────────────────────────────────────────
async function processQueue() {
  console.log('[BulkLister] Queue processor started');

  while (sessionState.running) {
    if (sessionState.paused) {
      await sleep(600);
      continue;
    }

    const maxTabs = Math.min(parseInt(sessionState.settings.tabCount) || 2, 10);
    const activeCnt = Object.keys(sessionState.activeTabs).length;

    // All URLs sent out – wait for active tabs to finish
    if (sessionState.currentIndex >= sessionState.urls.length) {
      if (activeCnt === 0) {
        console.log('[BulkLister] All URLs processed – session done');
        sessionState.running = false;
        await chrome.storage.local.set({ isRunning: false });
        broadcastDone();
        break;
      }
      await sleep(800);
      continue;
    }

    // Respect tab concurrency limit
    if (activeCnt >= maxTabs) {
      await sleep(400);
      continue;
    }

    const url = sessionState.urls[sessionState.currentIndex];
    sessionState.currentIndex++;

    await openAmazonTab(url);

    // Human-like delay between opening tabs
    const delay = randomDelay(
      parseInt(sessionState.settings.delayMin) || 1000,
      parseInt(sessionState.settings.delayMax) || 3000
    );
    await sleep(delay);
  }

  console.log('[BulkLister] Queue processor exited');
}

// ── Open Amazon Tab ────────────────────────────────────────────────────────
async function openAmazonTab(url) {
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    sessionState.activeTabs[tab.id] = {
      url,
      startTime: Date.now(),
      phase: 'scraping',
      productData: null,
    };

    console.log('[BulkLister] Opened tab', tab.id, 'for', url);
    broadcastUpdate(url, { status: 'info', message: `📖 Scraping: ${url}`, url });

    // Auto-close timeout
    if (sessionState.settings.autoClose !== false) {
      const timeout = (parseInt(sessionState.settings.closeTimeout) || 60) * 1000;
      setTimeout(async () => {
        if (sessionState.activeTabs[tab.id]) {
          console.warn('[BulkLister] Tab', tab.id, 'timed out');
          recordResult('failed', url, `Timed out after ${sessionState.settings.closeTimeout || 60}s`);
          await closeTab(tab.id);
        }
      }, timeout);
    }
  } catch (e) {
    console.error('[BulkLister] openAmazonTab error:', e.message);
    recordResult('failed', url, 'Failed to open tab: ' + e.message);
  }
}

// ── Handle Scrape Result ───────────────────────────────────────────────────
async function handleScrapeResult(tabId, data) {
  const tabInfo = sessionState.activeTabs[tabId];
  if (!tabInfo) {
    console.warn('[BulkLister] SCRAPE_RESULT from unknown tab', tabId);
    return;
  }

  const { url } = tabInfo;
  console.log('[BulkLister] Scrape result tab', tabId, '– title:', data?.title || 'ERROR:', data?.error);

  if (!data || data.error) {
    await closeTab(tabId);
    recordResult('failed', url, data?.error || 'Scrape returned no data');
    return;
  }

  // ── FILTER 1: FBA Only ────────────────────────────────────────────────
  if (sessionState.settings.fbaOnly && !data.isFBA) {
    await closeTab(tabId);
    recordResult('skipped', url, 'Not FBA – skipped (FBA filter is ON)');
    return;
  }

  // ── FILTER 2: VeRO Brands (Admin) ────────────────────────────────────
  const veroList = ADMIN_VERO_BRANDS[sessionState.domain] || ADMIN_VERO_BRANDS['ebay.com'];
  const brand = (data.brand || '').toLowerCase().trim();
  const matchedVero = veroList.find(b => brand === b || brand.includes(b));
  if (matchedVero) {
    await closeTab(tabId);
    recordResult('skipped', url, `VeRO brand blocked: "${data.brand}"`);
    return;
  }

  // ── FILTER 3: Policy Keywords (Admin) ────────────────────────────────
  const policyList = ADMIN_POLICY_KEYWORDS[sessionState.domain] || [];
  const fullText = [data.title || '', data.description || '', ...(data.bullets || [])].join(' ').toLowerCase();
  const matchedPolicy = policyList.find(kw => fullText.includes(kw));
  if (matchedPolicy) {
    await closeTab(tabId);
    recordResult('skipped', url, `Policy keyword blocked: "${matchedPolicy}"`);
    return;
  }

  // ── FILTER 4: User Blacklist ──────────────────────────────────────────
  const matchedUser = (sessionState.userBlacklist || []).find(kw => fullText.includes(kw.toLowerCase()));
  if (matchedUser) {
    await closeTab(tabId);
    recordResult('skipped', url, `Your blacklist matched: "${matchedUser}"`);
    return;
  }

  // ── AI Optimization ───────────────────────────────────────────────────
  let optimizedData = { ...data };
  if (sessionState.settings.aiOptimize && sessionState.apiKeys?.openai) {
    try {
      optimizedData = await aiOptimizeContent(data);
      broadcastUpdate(url, { status: 'info', message: `🤖 AI optimized: "${optimizedData.title}"`, url });
    } catch (e) {
      console.warn('[BulkLister] AI optimization failed:', e.message);
      broadcastUpdate(url, { status: 'info', message: `⚠ AI failed, using original title`, url });
    }
  }

  // ── eBay Safe-Text Sanitize ───────────────────────────────────────────
  optimizedData = sanitizeForEbay(optimizedData);

  // ── Navigate Tab to eBay ──────────────────────────────────────────────
  sessionState.activeTabs[tabId].phase = 'listing';
  sessionState.activeTabs[tabId].productData = optimizedData;

  // Store data before navigation so content script can access it
  await chrome.storage.local.set({ currentListingData: optimizedData });

  const ebayUrl = `https://www.${sessionState.domain}/sl/list`;
  console.log('[BulkLister] Navigating tab', tabId, 'to eBay:', ebayUrl);
  broadcastUpdate(url, { status: 'info', message: `🛒 Listing on eBay: "${optimizedData.title}"`, url });

  chrome.tabs.update(tabId, { url: ebayUrl });
}

// ── Handle eBay List Result ────────────────────────────────────────────────
async function handleListResult(tabId, success, reason) {
  const tabInfo = sessionState.activeTabs[tabId];
  if (!tabInfo) return;

  const { url } = tabInfo;
  await closeTab(tabId);

  if (success) {
    recordResult('success', url, `✅ Listed successfully on ${sessionState.domain}`);
  } else {
    recordResult('failed', url, `eBay listing failed: ${reason || 'Unknown error'}`);
  }
}

// ── eBay Safe-Text Sanitizer ──────────────────────────────────────────────
function sanitizeForEbay(data) {
  const sanitize = (text) => {
    if (!text) return text;
    let t = text;
    // Remove external URLs (keep ebay.com URLs)
    t = t.replace(/https?:\/\/(?!([a-z]+\.)?ebay\.)[^\s<>"]+/gi, '');
    t = t.replace(/\bwww\.(?!ebay\.)[a-zA-Z0-9-]+\.[a-zA-Z]{2,}[^\s]*/gi, '');
    // Strip forbidden phrases
    for (const phrase of EBAY_STRIP_PHRASES) {
      t = t.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
    }
    return t.replace(/\s{2,}/g, ' ').trim();
  };
  return {
    ...data,
    title: sanitize(data.title),
    description: sanitize(data.description),
    bullets: (data.bullets || []).map(sanitize),
  };
}

// ── AI Content Optimization ────────────────────────────────────────────────
async function aiOptimizeContent(data) {
  const apiKey = sessionState.apiKeys.openai;
  const model = sessionState.settings.aiModel || 'gpt-4o-mini';

  const prompt = `You are an expert eBay listing copywriter. Optimize this Amazon product for eBay.

Title: ${data.title}
Description: ${data.description || ''}
Bullets: ${(data.bullets || []).join(' | ')}
Price: ${data.price || ''}

Rules:
- eBay title: max 80 characters, keyword-rich, no trademark violations
- Description: 2-3 engaging paragraphs for eBay buyers
- Never mention Amazon, external websites, or "visit our website"
- eBay customer service phrases like "message us via eBay" are allowed

Respond ONLY with valid JSON, no markdown:
{"title":"...","description":"...","bullets":["...","...","..."]}`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      temperature: 0.7,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${err}`);
  }

  const result = await resp.json();
  const text = result.choices[0].message.content.trim();
  const jsonStr = text.replace(/^```json\s*/, '').replace(/```$/, '').trim();
  const parsed = JSON.parse(jsonStr);

  return {
    ...data,
    title: parsed.title || data.title,
    description: parsed.description || data.description,
    bullets: parsed.bullets || data.bullets,
    aiOptimized: true,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────
async function closeTab(tabId) {
  try {
    delete sessionState.activeTabs[tabId];
    await chrome.tabs.remove(tabId);
  } catch (_) { /* tab may already be closed */ }
}

function closeAllActiveTabs() {
  Object.keys(sessionState.activeTabs).forEach(id => {
    chrome.tabs.remove(parseInt(id)).catch(() => {});
  });
  sessionState.activeTabs = {};
}

function recordResult(status, url, message) {
  sessionState.stats[status] = (sessionState.stats[status] || 0) + 1;
  chrome.storage.local.set({ sessionStats: { ...sessionState.stats } });
  broadcastUpdate(url, { status, message, url });
}

function broadcastUpdate(url, logEntry) {
  const entry = { ...logEntry, time: new Date().toLocaleTimeString() };

  // Append to log in storage
  chrome.storage.local.get('sessionLog', (s) => {
    const log = Array.isArray(s.sessionLog) ? s.sessionLog : [];
    log.push(entry);
    chrome.storage.local.set({ sessionLog: log });
  });

  // Notify popup (it may be closed – that's ok)
  chrome.runtime.sendMessage({
    action: 'SESSION_UPDATE',
    stats: { ...sessionState.stats },
    logEntry: entry,
  }).catch(() => {});
}

function broadcastDone() {
  const stats = { ...sessionState.stats };
  chrome.runtime.sendMessage({ action: 'SESSION_DONE', stats }).catch(() => {});

  chrome.notifications.create('done_' + Date.now(), {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: '✅ Bulk Lister Complete',
    message: `Listed: ${stats.success}  |  Failed: ${stats.failed}  |  Skipped: ${stats.skipped}`,
  });
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
