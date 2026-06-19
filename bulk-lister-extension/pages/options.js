// pages/options.js – Admin Options Page Controller
// Extracted from inline script to comply with Chrome Extension CSP (no inline scripts allowed)

let activeDomain = 'ebay.com';

const defaultAdminData = {
  'ebay.com': {
    vero: ['philips','honda','rolex','nike','adidas','apple','samsung','sony','bose','dyson','dewalt','makita','milwaukee'],
    policy: ['police','over the counter medication','otc medication','narcotic','drug','firearm','explosive'],
    strip: ['visit our website','check our online store','visit our store','see our website','shop at our website','find us online','our amazon store','available on amazon','sold on amazon','buy on amazon'],
    allow: ['message us via ebay','contact us on ebay','via ebay messages','ebay messages','get in touch on ebay','message us through ebay'],
  },
  'ebay.co.uk': {
    vero: ['philips','honda','rolex','nike','adidas','apple','samsung','sony'],
    policy: ['police','firearm','narcotic','controlled drug'],
    strip: ['visit our website','check our online store'],
    allow: ['message us via ebay','via ebay messages'],
  },
  'ebay.de': {
    vero: ['philips','honda','rolex','nike'],
    policy: ['polizei','waffe','sprengstoff'],
    strip: ['besuchen sie unsere website'],
    allow: ['ebay nachricht','per ebay'],
  },
  'ebay.com.au': {
    vero: ['philips','honda','rolex'],
    policy: ['police','firearm','controlled substance'],
    strip: ['visit our website'],
    allow: ['via ebay','ebay messages'],
  },
  'ebay.it': {
    vero: ['philips','honda','rolex'],
    policy: ['polizia','arma'],
    strip: ['visita il nostro sito'],
    allow: ['via ebay'],
  },
  'ebay.fr': {
    vero: ['philips','honda','rolex'],
    policy: ['police','arme'],
    strip: ['visitez notre site'],
    allow: ['via ebay'],
  },
};

let adminData = JSON.parse(JSON.stringify(defaultAdminData));

async function loadAdminData() {
  const s = await chrome.storage.local.get('adminData');
  if (s.adminData) adminData = Object.assign({}, defaultAdminData, s.adminData);
  renderForDomain(activeDomain);
}

function renderForDomain(domain) {
  const d = adminData[domain] || { vero: [], policy: [], strip: [], allow: [] };
  document.getElementById('veroInput').value   = d.vero.join('\n');
  document.getElementById('policyInput').value = d.policy.join('\n');
  document.getElementById('stripInput').value  = d.strip.join('\n');
  document.getElementById('allowInput').value  = d.allow.join('\n');
  document.getElementById('veroDomainLabel').textContent   = domain;
  document.getElementById('policyDomainLabel').textContent = domain;
}

function collectForDomain(domain) {
  const parse = id => document.getElementById(id).value
    .split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
  adminData[domain] = {
    vero:   parse('veroInput'),
    policy: parse('policyInput'),
    strip:  parse('stripInput'),
    allow:  parse('allowInput'),
  };
}

document.addEventListener('DOMContentLoaded', () => {
  // Domain tab switching
  document.querySelectorAll('.domain-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      collectForDomain(activeDomain);
      document.querySelectorAll('.domain-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeDomain = tab.dataset.domain;
      renderForDomain(activeDomain);
    });
  });

  // Save button
  document.getElementById('saveBtn').addEventListener('click', async () => {
    collectForDomain(activeDomain);
    await chrome.storage.local.set({ adminData });
    const toast = document.getElementById('toast');
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 2500);
  });

  // Quick-add VeRO brand
  document.getElementById('addVeroBtn').addEventListener('click', () => {
    const inp = document.getElementById('newVero');
    const val = inp.value.trim().toLowerCase();
    if (!val) return;
    const cur = document.getElementById('veroInput').value;
    document.getElementById('veroInput').value = cur ? cur + '\n' + val : val;
    inp.value = '';
  });

  // Quick-add policy keyword
  document.getElementById('addPolicyBtn').addEventListener('click', () => {
    const inp = document.getElementById('newPolicy');
    const val = inp.value.trim().toLowerCase();
    if (!val) return;
    const cur = document.getElementById('policyInput').value;
    document.getElementById('policyInput').value = cur ? cur + '\n' + val : val;
    inp.value = '';
  });

  // Enter key on add inputs
  document.getElementById('newVero').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('addVeroBtn').click();
  });
  document.getElementById('newPolicy').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('addPolicyBtn').click();
  });

  loadAdminData();
});
