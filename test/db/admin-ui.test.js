'use strict';

// Smoke test of the REAL admin dashboard (index.html + app.js) inside jsdom,
// talking to the real server and the test database. It proves the screen is
// wired to the API (not cosmetic). It is not a visual/pixel test.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pool, resetDatabase, startServer, closeAll, ROOT } = require('./helpers/setup');

let dom;
let w;
let downloads;

const $ = (id) => w.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, label, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

function type(el, value) {
  el.value = value;
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
}

before(async () => {
  await resetDatabase('full');
  const base = await startServer();

  const dir = path.join(ROOT, 'src', 'admin', 'public');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace(/<script src="[^"]*"><\/script>/, '');
  const js = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');

  downloads = [];
  dom = new JSDOM(html, { url: `${base}/admin`, runScripts: 'outside-only', pretendToBeVisual: true });
  w = dom.window;

  w.fetch = (u, o) => fetch(new URL(u, base), o);
  w.confirm = () => true;
  w.alert = () => {};
  w.URL.createObjectURL = (blob) => { downloads.push(blob); return 'blob:test'; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function click() { downloads.push({ download: this.download }); };
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async () => {} } });

  w.eval(js);
});

after(async () => {
  dom.window.close();
  await closeAll();
});

test('UI: login, then create customers with names through the screen, see them in the table', async () => {
  assert.ok(!$('loginView').classList.contains('hidden'));

  $('username').value = 'test-admin';
  $('password').value = 'test-password';
  $('loginForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));

  await until(() => !$('dashboardView').classList.contains('hidden'), 'dashboard visible');
  await until(() => $('licensesTableBody').textContent.includes('لا توجد نتائج'), 'empty table');

  // wrong password shows an error and does not enter
  // (covered by API tests; here we only check the happy path)

  $('createLicenseBtn').click();
  await until(() => $('productSelect').options.length > 1, 'products loaded');
  $('productSelect').value = 'school-accreditation';
  assert.ok(!$('createModal').classList.contains('hidden'));

  type($('namesInput'), 'مدرسة النور\nمدرسة المستقبل | 1500\n\n  مدرسة الأمل  | ٢٠٠٠');
  assert.match($('namesCount').textContent, /3/);
  type($('defaultCurrency'), 'egp');
  type($('maxDevices'), '2');

  $('createLicenseForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));

  await until(() => !$('createResult').classList.contains('hidden'), 'result shown');
  assert.match($('createMessage').textContent, /تم إنشاء 3 ترخيص/);
  assert.equal($('createResultBody').querySelectorAll('tr').length, 3);

  await until(() => $('licensesTableBody').querySelectorAll('tr').length === 3, '3 rows in table');
  const text = $('licensesTableBody').textContent;
  for (const n of ['مدرسة النور', 'مدرسة المستقبل', 'مدرسة الأمل']) assert.ok(text.includes(n), n);
  assert.match(text, /1,500\.00/);
  assert.match(text, /2,000\.00/);
  assert.equal($('totalCount').textContent, '3');
  assert.equal($('incompleteCount').textContent, '1', 'only the first customer has no price');

  // DB agrees
  const { rows } = await pool.query(
    'SELECT c.customer_number, c.name, c.sale_price, c.currency, l.max_devices FROM customers c JOIN licenses l ON l.customer_id = c.id ORDER BY 1'
  );
  assert.deepEqual(rows.map((r) => [Number(r.customer_number), r.name, r.sale_price, r.currency, r.max_devices]), [
    [1, 'مدرسة النور', null, 'EGP', 2], // the shared currency applies; no price was given
    [2, 'مدرسة المستقبل', '1500.00', 'EGP', 2],
    [3, 'مدرسة الأمل', '2000.00', 'EGP', 2],
  ]);
});

test('UI: clicking Create twice quickly sends one operation (same idempotency key)', async () => {
  const before = (await pool.query('SELECT COUNT(*)::int AS n FROM licenses')).rows[0].n;

  $('modeCount').click();
  type($('quantityInput'), '4');

  const submit = () => $('createLicenseForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  submit();
  submit(); // second click while the first is in flight

  await until(() => /تم إنشاء 4/.test($('createMessage').textContent), 'created 4');
  await sleep(150);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM licenses')).rows[0].n, before + 4);
});

test('UI: search by number and Arabic partial name, sort, edit customer, export', async () => {
  // search by number
  type($('searchInput'), '#2');
  await until(() => $('licensesTableBody').querySelectorAll('tr').length === 1, 'one result for #2');
  assert.ok($('licensesTableBody').textContent.includes('مدرسة المستقبل'));

  // partial Arabic name
  type($('searchInput'), 'الأمل');
  await until(() => $('licensesTableBody').textContent.includes('مدرسة الأمل') && $('licensesTableBody').querySelectorAll('tr').length === 1, 'name search');

  // sort by customer number descending
  type($('searchInput'), '');
  await until(() => $('licensesTableBody').querySelectorAll('tr').length === 7, 'all 7 rows');
  w.document.querySelector('th[data-sort="customer_number"]').click();
  await until(() => $('licensesTableBody').querySelector('.cust-no').textContent === '1', 'sorted asc');
  w.document.querySelector('th[data-sort="customer_number"]').click();
  await until(() => $('licensesTableBody').querySelector('.cust-no').textContent === '7', 'sorted desc');

  // incomplete filter
  $('incompleteFilter').checked = true;
  $('incompleteFilter').dispatchEvent(new w.Event('change', { bubbles: true }));
  await until(() => $('licensesTableBody').querySelectorAll('tr').length === 5, '5 incomplete rows');
  $('incompleteFilter').checked = false;
  $('incompleteFilter').dispatchEvent(new w.Event('change', { bubbles: true }));
  await until(() => $('licensesTableBody').querySelectorAll('tr').length === 7, 'back to 7');

  // open customer #1 and record the sale
  const keyBefore = (await pool.query('SELECT license_key, status, max_devices FROM licenses l JOIN customers c ON c.id = l.customer_id WHERE c.customer_number = 1')).rows[0];
  w.document.querySelector('th[data-sort="customer_number"]').click(); // asc
  await until(() => $('licensesTableBody').querySelector('.cust-no').textContent === '1', 'asc again');
  $('licensesTableBody').querySelector('.cust-no').click();
  await until(() => $('cName').value === 'مدرسة النور', 'customer form filled');

  type($('cPrice'), '1750.5');
  type($('cCurrency'), 'sar');
  type($('cSoldAt'), '2026-09-30');
  type($('cNotes'), 'تم الدفع كاملًا');
  $('customerForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => $('customerModal').classList.contains('hidden'), 'modal closed after save');

  await until(() => $('licensesTableBody').textContent.includes('1,750.50'), 'price visible in table');
  const saved = (await pool.query('SELECT sale_price, currency, sold_at::text AS sold, notes FROM customers WHERE customer_number = 1')).rows[0];
  assert.deepEqual(saved, { sale_price: '1750.50', currency: 'SAR', sold: '2026-09-30', notes: 'تم الدفع كاملًا' });

  const keyAfter = (await pool.query('SELECT license_key, status, max_devices FROM licenses l JOIN customers c ON c.id = l.customer_id WHERE c.customer_number = 1')).rows[0];
  assert.deepEqual(keyAfter, keyBefore, 'license untouched by the customer edit');

  // export the current results (CSV and XLSX) through the screen
  downloads.length = 0;
  $('exportScope').value = 'search';
  $('exportCsvBtn').click();
  await until(() => downloads.some((d) => d.download && /\.csv$/.test(d.download)), 'csv download triggered');
  $('exportXlsxBtn').click();
  await until(() => downloads.some((d) => d.download && /\.xlsx$/.test(d.download)), 'xlsx download triggered');

  // "selected" with nothing selected is refused with a message, no download
  downloads.length = 0;
  $('exportScope').value = 'selected';
  $('exportCsvBtn').click();
  await sleep(100);
  assert.equal(downloads.length, 0);
  assert.match($('toast').textContent, /حدّد/);
});

test('UI: revoke asks for confirmation and really revokes; XSS in names is escaped', async () => {
  const { rows } = await pool.query(
    `INSERT INTO customers (name) VALUES ($1) RETURNING id`, ['<img src=x onerror="window.__xss=1">']
  );
  await pool.query(
    `INSERT INTO licenses (license_key, product_id, customer_id) VALUES ('SCHL-XSS000-AAAAAA-BBBBBB-CCCCCC','school-accreditation',$1)`,
    [rows[0].id]
  );

  $('refreshBtn').click();
  await until(() => $('licensesTableBody').textContent.includes('<img src=x'), 'name rendered as TEXT');
  assert.equal(w.__xss, undefined);
  assert.equal($('licensesTableBody').querySelectorAll('img').length, 0);

  let asked = '';
  w.confirm = (m) => { asked = m; return true; };

  const row = [...$('licensesTableBody').querySelectorAll('tr')].find((tr) => tr.textContent.includes('SCHL-XSS000'));
  row.querySelector('[data-action="revoke"]').click();
  await until(() => asked !== '', 'confirm shown');
  assert.match(asked, /SCHL-XSS000/);

  await until(async () =>
    (await pool.query("SELECT status FROM licenses WHERE license_key = 'SCHL-XSS000-AAAAAA-BBBBBB-CCCCCC'")).rows[0].status === 'REVOKED',
  'license revoked in DB');

  // declining the confirmation changes nothing
  w.confirm = () => false;
  await until(() => [...$('licensesTableBody').querySelectorAll('tr')].some((tr) => tr.textContent.includes('SCHL-XSS000') && tr.querySelector('[data-action="reactivate"]')), 'reactivate button');
  const r2 = [...$('licensesTableBody').querySelectorAll('tr')].find((tr) => tr.textContent.includes('SCHL-XSS000'));
  r2.querySelector('[data-action="reactivate"]').click();
  await sleep(150);
  assert.equal((await pool.query("SELECT status FROM licenses WHERE license_key = 'SCHL-XSS000-AAAAAA-BBBBBB-CCCCCC'")).rows[0].status, 'REVOKED');
});

test('UI: programs tab lists / adds a program; creating without a program is refused; filter by program', async () => {
  w.confirm = () => true;
  $('tabProducts').click();
  await until(() => $('productsTableBody').textContent.includes('school-accreditation'), 'products listed');
  assert.ok(!$('productsPanel').classList.contains('hidden'));

  $('addProductBtn').click();
  type($('productIdInput'), 'ui-second');
  type($('productNameInput'), 'برنامج ثانٍ');
  $('productForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => $('productsTableBody').textContent.includes('ui-second'), 'new program shown');
  const inDb = await pool.query("SELECT name FROM products WHERE product_id = 'ui-second'");
  assert.equal(inDb.rows[0].name, 'برنامج ثانٍ');

  // the create dialog has no default program: submitting without a choice creates nothing
  $('tabLicenses').click();
  const before = (await pool.query('SELECT COUNT(*)::int AS n FROM licenses')).rows[0].n;
  $('createLicenseBtn').click();
  assert.equal($('productSelect').value, '');
  $('modeNames').click();
  type($('namesInput'), 'بدون برنامج');
  $('createLicenseForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 300));
  assert.match($('createMessage').textContent, /اختر البرنامج/);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM licenses')).rows[0].n, before);

  // choose the second program and create; the table filter can isolate it
  $('productSelect').value = 'ui-second';
  $('createLicenseForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !$('createResult').classList.contains('hidden'), 'created');
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM licenses WHERE product_id = 'ui-second'");
  assert.equal(r.rows[0].n, 1);

  $('productFilter').value = 'ui-second';
  $('productFilter').dispatchEvent(new w.Event('change', { bubbles: true }));
  await until(() => $('licensesTableBody').querySelectorAll('tr').length === 1 && $('licensesTableBody').textContent.includes('بدون برنامج'), 'filtered rows');
});
