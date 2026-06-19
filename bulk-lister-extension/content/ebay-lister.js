// content/ebay-lister.js – Injected by service worker into eBay tabs
// Fills the eBay listing form using human-like browser automation ONLY (no eBay API)

(async function () {
  if (window.__blListerRan) return;
  window.__blListerRan = true;

  console.log('[BulkLister] eBay lister injected on', location.href);

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

  await sleep(rand(1000, 2000));

  // ── Captcha Check ─────────────────────────────────────────────────────
  if (
    document.querySelector('iframe[src*="captcha"]') ||
    document.querySelector('#captcha-container') ||
    document.body?.innerText?.toLowerCase().includes('verify you are human')
  ) {
    chrome.runtime.sendMessage({ action: 'CAPTCHA_REQUIRED', page: 'ebay', url: location.href });
    await waitForCaptchaGone();
  }

  // ── Confirm this is the listing form ──────────────────────────────────
  const isListForm =
    location.href.includes('/sl/list') ||
    location.href.includes('/sell/') ||
    document.querySelector('#str-title, [data-test-id="str-title"], #listing-title, input[name="title"]');

  if (!isListForm) {
    console.log('[BulkLister] Not a listing form page, reporting success to proceed');
    // Sometimes eBay redirects – treat as failure and move on
    chrome.runtime.sendMessage({
      action: 'LIST_RESULT',
      success: false,
      reason: 'Not redirected to eBay listing form (URL: ' + location.href + ')',
    });
    return;
  }

  // ── Get product data ──────────────────────────────────────────────────
  const stored = await chrome.storage.local.get('currentListingData');
  const product = stored.currentListingData;

  if (!product) {
    chrome.runtime.sendMessage({ action: 'LIST_RESULT', success: false, reason: 'No product data found in storage' });
    return;
  }

  console.log('[BulkLister] Filling form for:', product.title);

  try {
    await fillForm(product);
  } catch (e) {
    console.error('[BulkLister] Form fill error:', e);
    chrome.runtime.sendMessage({ action: 'LIST_RESULT', success: false, reason: e.message });
  }

  // ── Form Filler ───────────────────────────────────────────────────────
  async function fillForm(p) {
    // Title
    const titleInput = await waitFor(
      '#str-title input, [data-test-id="str-title"] input, #listing-title, input[name="title"]',
      12000
    );
    if (!titleInput) throw new Error('Title input not found on eBay form');
    await humanType(titleInput, p.title.slice(0, 80));
    await sleep(rand(400, 900));

    // Description (try multiple selectors for different eBay form versions)
    const descSel = '#description-editor, #itemDescription, [data-test-id="description"] textarea, .str-description-text textarea, iframe[title*="Description"]';
    const descArea = document.querySelector(descSel);
    if (descArea) {
      const content = [
        p.description || '',
        '',
        (p.bullets || []).map(b => '• ' + b).join('\n'),
      ].join('\n').trim();

      if (descArea.tagName === 'IFRAME') {
        // eBay sometimes uses an iframe-based editor
        try {
          const iDoc = descArea.contentDocument || descArea.contentWindow.document;
          if (iDoc && iDoc.body) {
            iDoc.body.innerText = content;
          }
        } catch (_) {}
      } else {
        await humanType(descArea, content);
      }
      await sleep(rand(300, 700));
    }

    // Price
    const priceInput = document.querySelector(
      '#price, [data-test-id="price"] input, input[name="BIN_PRICE"], input[name="startPrice"], input[data-test-id="buy-it-now-price"]'
    );
    if (priceInput && p.price) {
      const numPrice = p.price.replace(/[^0-9.]/g, '');
      if (numPrice) {
        await humanType(priceInput, numPrice);
        await sleep(rand(200, 500));
      }
    }

    // Condition – set to "New"
    const condSel = document.querySelector('#condId, [data-test-id="condition"] select, select[name="condition"]');
    if (condSel) {
      const newOpt = Array.from(condSel.options).find(o =>
        o.text.toLowerCase().includes('new') && !o.text.toLowerCase().includes('open box')
      );
      if (newOpt) {
        condSel.value = newOpt.value;
        condSel.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(rand(300, 600));
      }
    }

    // Quantity – default 1
    const qtyInput = document.querySelector('#quantity, input[name="quantity"], [data-test-id="quantity"] input');
    if (qtyInput && qtyInput.value === '') {
      await humanType(qtyInput, '1');
      await sleep(rand(200, 400));
    }

    // Human pause before clicking List
    await sleep(rand(800, 1800));

    // Click List Item / Save button
    const listBtn = await waitFor(
      '#pListingBtn, [data-test-id="list-it-button"], [data-test-id="SUBMIT"], button[data-action="list"], #reviewAndSubmitBtn, button[type="submit"]',
      8000
    );
    if (!listBtn) throw new Error('Could not find the List Item / Submit button');

    await humanClick(listBtn);
    await sleep(rand(2500, 5000));

    // ── Detect result ─────────────────────────────────────────────────
    const success = !!(
      document.querySelector('.str-congrats, [data-test-id="listing-success"], #confirmation-page-header, .listing-confirmation, .success-message') ||
      location.href.includes('confirmation') ||
      location.href.includes('success')
    );

    const errorEl = document.querySelector('.str-error, .field-error, [data-test-id="field-error"], .error-message, [role="alert"]');
    if (!success && errorEl) {
      throw new Error(errorEl.textContent.trim().slice(0, 200));
    }

    chrome.runtime.sendMessage({ action: 'LIST_RESULT', success: true });
  }

  // ── Human-like Typing ─────────────────────────────────────────────────
  async function humanType(el, text) {
    el.focus();
    // Clear existing value
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(rand(80, 200));

    for (const char of text) {
      // Occasional longer pause mimicking hesitation
      const delay = Math.random() < 0.04 ? rand(250, 700) : rand(25, 110);
      await sleep(delay);
      el.value += char;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: char, inputType: 'insertText' }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  // ── Human-like Click ──────────────────────────────────────────────────
  async function humanClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2 + (Math.random() - 0.5) * 6;
    const y = rect.top + rect.height / 2 + (Math.random() - 0.5) * 4;
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x - 10, clientY: y }));
    await sleep(rand(60, 150));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
    await sleep(rand(40, 100));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
    await sleep(rand(30, 90));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y, button: 0 }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, button: 0 }));
  }

  // ── Wait for Element ──────────────────────────────────────────────────
  function waitFor(selector, timeout = 10000) {
    return new Promise(resolve => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const obs = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) { obs.disconnect(); resolve(found); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
    });
  }

  // ── Wait for Captcha to Disappear ─────────────────────────────────────
  function waitForCaptchaGone(timeout = 60000) {
    return new Promise(resolve => {
      const check = setInterval(() => {
        const still = document.querySelector('iframe[src*="captcha"], #captcha-container');
        if (!still) { clearInterval(check); resolve(); }
      }, 1500);
      setTimeout(() => { clearInterval(check); resolve(); }, timeout);
    });
  }

})();
