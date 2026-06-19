// content/amazon-scraper.js – Injected by service worker into Amazon tabs
// CRITICAL: Must call chrome.runtime.sendMessage({action:'SCRAPE_RESULT',...}) at end

(async function () {
  // Prevent double-injection
  if (window.__blScrapeRan) return;
  window.__blScrapeRan = true;

  console.log('[BulkLister] Amazon scraper injected on', location.href);

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

  // Wait for page to stabilise
  await sleep(rand(800, 1800));

  // ── Captcha Detection ────────────────────────────────────────────────
  const bodyText = document.body.innerText.toLowerCase();
  if (
    document.querySelector('form[action*="validateCaptcha"]') ||
    bodyText.includes('enter the characters you see below') ||
    bodyText.includes('sorry, we just need to make sure')
  ) {
    chrome.runtime.sendMessage({ action: 'CAPTCHA_REQUIRED', page: 'amazon', url: location.href });
    await sleep(20000); // wait for captcha solver
    await sleep(rand(500, 1000));
  }

  // ── Verify product page ──────────────────────────────────────────────
  const hasTitle = document.querySelector('#productTitle, #title, .product-title-word-break');
  if (!hasTitle) {
    chrome.runtime.sendMessage({
      action: 'SCRAPE_RESULT',
      data: { error: 'Not a valid Amazon product page (no title found)' }
    });
    return;
  }

  try {
    const data = extractProductData();
    await sleep(rand(200, 500));
    console.log('[BulkLister] Scraped product:', data.title);
    chrome.runtime.sendMessage({ action: 'SCRAPE_RESULT', data });
  } catch (e) {
    console.error('[BulkLister] Scrape error:', e);
    chrome.runtime.sendMessage({ action: 'SCRAPE_RESULT', data: { error: 'Scrape exception: ' + e.message } });
  }

  function extractProductData() {
    // ── Title ─────────────────────────────────────────────────────────
    const titleEl = document.querySelector('#productTitle, #title span, .product-title-word-break');
    const title = titleEl ? titleEl.textContent.trim() : '';

    // ── ASIN ──────────────────────────────────────────────────────────
    let asin = '';
    const m = location.href.match(/\/dp\/([A-Z0-9]{10})/);
    if (m) asin = m[1];
    if (!asin) {
      const el = document.querySelector('[data-asin]');
      if (el) asin = el.dataset.asin;
    }

    // ── Price ─────────────────────────────────────────────────────────
    let price = '';
    const priceSelectors = [
      '#priceblock_ourprice',
      '#priceblock_dealprice',
      '.a-price .a-offscreen',
      '#corePrice_feature_div .a-price .a-offscreen',
      '#apex_offerDisplay_desktop .a-price .a-offscreen',
      '#sns-base-price',
      '#price',
    ];
    for (const sel of priceSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) { price = el.textContent.trim(); break; }
    }

    // ── Brand ─────────────────────────────────────────────────────────
    let brand = '';
    const brandEl = document.querySelector('#bylineInfo, #brand, [data-feature-name="bylineInfo"]');
    if (brandEl) brand = brandEl.textContent.replace(/^(Brand:|Visit the|Store:|\s)+/i, '').trim();
    // Fallback: check product details table
    if (!brand) {
      document.querySelectorAll('#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr').forEach(row => {
        const th = row.querySelector('th,td');
        if (th && th.textContent.toLowerCase().includes('brand')) {
          const td = row.querySelectorAll('td')[0] || row.querySelectorAll('td')[1];
          if (td) brand = td.textContent.trim();
        }
      });
    }

    // ── FBA Check ─────────────────────────────────────────────────────
    // ONLY check the main buy-box area – ignore cross-sell sections
    const buyboxArea = document.querySelector(
      '#buybox, #tabular-buybox, #mir-layout-DELIVERY_BLOCK, #shippingMessageInsideBuyBox_feature_div, #merchant-info'
    );
    const buyboxText = (buyboxArea?.textContent || '').toLowerCase();
    const isFBA = buyboxText.includes('fulfilled by amazon') ||
      buyboxText.includes('amazon.com') ||
      buyboxText.includes('ships from amazon') ||
      buyboxText.includes('sold by amazon');

    // ── Bullet Points (MAIN product only) ────────────────────────────
    // Target only #feature-bullets – completely ignoring carousels/recommendations
    const bullets = [];
    const bulletsSection = document.querySelector('#feature-bullets, #featurebullets_feature_div');
    if (bulletsSection) {
      bulletsSection.querySelectorAll('li span.a-list-item').forEach(el => {
        const text = el.textContent.trim();
        if (text && text.length > 5 && !text.startsWith('Make sure this fits')) {
          bullets.push(text);
        }
      });
    }

    // ── Description (main product section only) ───────────────────────
    // Use #productDescription which is ONLY the main product description
    // We never touch carousels like "customers also viewed"
    const descEl = document.querySelector('#productDescription p, #productDescription, #productDescription_feature_div .a-section p');
    const description = descEl ? descEl.textContent.trim() : bullets.slice(0, 3).join(' ');

    // ── Images (main image block only) ───────────────────────────────
    const images = [];
    const imgBlock = document.querySelector('#imageBlock, #altImages, #main-image-container, #imgTagWrapperId');
    if (imgBlock) {
      imgBlock.querySelectorAll('img').forEach(img => {
        const src = (img.dataset.oldHires || img.dataset.src || img.src || '');
        if (src.includes('images-amazon') && !images.includes(src)) {
          images.push(src.replace(/_[A-Z0-9]+_\./, '_AC_SL1500_.'));
        }
      });
    }

    // ── Category ─────────────────────────────────────────────────────
    let category = '';
    const breadcrumbs = document.querySelectorAll('#wayfinding-breadcrumbs_feature_div a, .a-breadcrumb li a');
    if (breadcrumbs.length) category = breadcrumbs[breadcrumbs.length - 1]?.textContent?.trim() || '';

    // ── Rating & Reviews ──────────────────────────────────────────────
    const ratingEl = document.querySelector('#acrPopover span.a-icon-alt');
    const reviewEl = document.querySelector('#acrCustomerReviewText');
    const rating = ratingEl?.textContent?.trim() || '';
    const reviewCount = reviewEl?.textContent?.trim() || '';

    if (!title) throw new Error('No product title found on page');

    return {
      asin, title, price, brand,
      isFBA: isFBA,
      bullets, description, images,
      category, rating, reviewCount,
      sourceUrl: location.href,
      scrapedAt: Date.now(),
    };
  }

})();
