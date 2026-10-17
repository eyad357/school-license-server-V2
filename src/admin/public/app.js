'use strict';

const state = {
  token: sessionStorage.getItem('admin_token') || '',
  rows: [],
  selected: new Set(), // 'L:<licenseId>' or 'C:<customerId>' (customer without license)
  sort: 'created_at',
  dir: 'desc',
  page: 1,
  pageSize: 25,
  total: 0,
  totalPages: 1,
  loadSeq: 0,
  createMode: 'names',
  createKey: null,
  createBusy: false,
  lastBatchLicenseIds: [],
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ helpers */

function showLogin() {
  $('loginView').classList.remove('hidden');
  $('dashboardView').classList.add('hidden');
}

function showDashboard() {
  $('loginView').classList.add('hidden');
  $('dashboardView').classList.remove('hidden');
}

function message(id, text = '', type = '') {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = `message ${type}`.trim();
}

let toastTimer;
function toast(text, type = '') {
  const el = $('toast');
  el.textContent = text;
  el.className = `toast ${type}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4500);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(value, emptyText = 'بدون انتهاء') {
  if (!value) return emptyText;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'غير معروف';
  return date.toLocaleDateString('ar-EG');
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ar-EG');
}

function formatMoney(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n)
    ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';
}

function newKey() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function statusBadge(status) {
  switch (status) {
    case 'ACTIVE': return '<span class="badge active">نشط</span>';
    case 'REVOKED': return '<span class="badge revoked">ملغى</span>';
    case 'EXPIRED': return '<span class="badge expired">منتهي</span>';
    case null:
    case undefined: return '<span class="badge inactive">بدون ترخيص</span>';
    default: return `<span class="badge inactive">${escapeHtml(status)}</span>`;
  }
}

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

/* ---------------------------------------------------------------------- API */

async function login(username, password) {
  const response = await fetch('/api/v1/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  let data;
  try { data = await response.json(); } catch (_e) { throw new Error('استجابة غير صالحة من الخادم.'); }

  if (!response.ok || !data.token) throw new Error(data.message || 'فشل تسجيل الدخول.');

  state.token = data.token;
  sessionStorage.setItem('admin_token', data.token);
  showDashboard();
  loadProducts();
  await loadRecords();
}

function logout() {
  state.token = '';
  state.rows = [];
  state.selected.clear();
  sessionStorage.removeItem('admin_token');
  showLogin();
}

async function api(path, options = {}) {
  const response = await fetch(`/api/v1/admin${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${state.token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  let data;
  try { data = await response.json(); } catch (_e) { throw new Error('استجابة غير صالحة من الخادم.'); }

  if (response.status === 401) {
    logout();
    throw new Error('انتهت جلسة الإدارة.');
  }

  if (!response.ok) {
    const error = new Error(data.message || `فشل الطلب (${response.status}).`);
    error.status = response.status;
    error.code = data.code;
    throw error;
  }

  return data;
}

/* -------------------------------------------------------------------- table */

function currentFilters() {
  return {
    q: $('searchInput').value.trim(),
    status: $('statusFilter').value,
    productId: $('productFilter').value,
    archived: $('archivedFilter').value,
    incomplete: $('incompleteFilter').checked ? '1' : '',
    sort: state.sort,
    dir: state.dir,
  };
}

function rowKey(row) {
  return row.license_id ? `L:${row.license_id}` : `C:${row.customer_id}`;
}

function renderSummary(summary) {
  if (!summary) return;
  $('totalCount').textContent = summary.totalLicenses;
  $('activeCount').textContent = summary.active;
  $('revokedCount').textContent = summary.revoked;
  $('expiredCount').textContent = summary.expired;
  $('incompleteCount').textContent = summary.incompleteRecords;
}

function renderSortHeaders() {
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.classList.remove('asc', 'desc');
    if (th.dataset.sort === state.sort) th.classList.add(state.dir);
  });
}

function renderRows() {
  const body = $('licensesTableBody');

  if (!state.rows.length) {
    body.innerHTML = '<tr><td colspan="12">لا توجد نتائج.</td></tr>';
    return;
  }

  body.innerHTML = state.rows.map((row) => {
    const key = rowKey(row);
    const hasLicense = Boolean(row.license_id);
    const hasCustomer = Boolean(row.customer_id);
    const incomplete = !hasCustomer || !row.customer_name || row.sale_price === null;

    const numberCell = hasCustomer
      ? `<button class="cust-no" type="button" data-action="customer" data-key="${escapeHtml(key)}">${escapeHtml(row.customer_number)}</button>`
      : '<span class="cust-no none">—</span>';

    const nameCell = hasCustomer
      ? `<button class="link-btn" type="button" data-action="customer" data-key="${escapeHtml(key)}">
           <bdi>${escapeHtml(row.customer_name || 'بدون اسم')}</bdi></button>
         ${row.archived_at ? '<span class="badge inactive">مؤرشف</span>' : ''}
         ${incomplete ? '<span class="badge warn">ناقص</span>' : ''}`
      : `<span class="muted">بدون عميل</span> <span class="badge warn">ناقص</span>
         <button class="secondary" type="button" data-action="complete" data-key="${escapeHtml(key)}">استكمال البيانات</button>`;

    const keyCell = hasLicense
      ? `<div class="key-cell">
           <span class="key">${escapeHtml(row.license_key)}</span>
           <button class="copy-btn" type="button" data-copy="${escapeHtml(row.license_key)}">نسخ</button>
         </div>`
      : '<span class="muted">—</span>';

    let actions = '';
    if (hasLicense) {
      const toggle = row.status === 'ACTIVE'
        ? `<button class="danger" type="button" data-action="revoke" data-key="${escapeHtml(key)}">إلغاء</button>`
        : `<button class="success" type="button" data-action="reactivate" data-key="${escapeHtml(key)}">تفعيل</button>`;

      actions = `
        <div class="actions">
          <button class="secondary" type="button" data-action="devices" data-key="${escapeHtml(key)}">الأجهزة</button>
          <button class="secondary" type="button" data-action="edit" data-key="${escapeHtml(key)}">تعديل</button>
          ${toggle}
          <button class="danger" type="button" data-action="delete" data-key="${escapeHtml(key)}">حذف</button>
        </div>`;
    }

    return `
      <tr class="${row.archived_at ? 'is-archived' : ''}">
        <td><input type="checkbox" data-select="${escapeHtml(key)}" ${state.selected.has(key) ? 'checked' : ''} aria-label="تحديد"></td>
        <td>${numberCell}</td>
        <td>${nameCell}</td>
        <td>${keyCell}</td>
        <td>${hasLicense ? `<bdi title="${escapeHtml(row.product_id)}">${escapeHtml(row.product_name || row.product_id)}</bdi>` : '—'}</td>
        <td>${statusBadge(row.status)}</td>
        <td class="num">${hasLicense ? `${escapeHtml(row.active_devices)} / ${escapeHtml(row.max_devices)}` : '—'}</td>
        <td class="num">${formatMoney(row.sale_price)}</td>
        <td>${escapeHtml(row.currency || '—')}</td>
        <td>${formatDate(row.license_created_at || row.customer_created_at, '—')}</td>
        <td>${row.sold_at ? escapeHtml(row.sold_at) : '—'}</td>
        <td>${actions}</td>
      </tr>`;
  }).join('');

  $('selectAll').checked = state.rows.length > 0 && state.rows.every((r) => state.selected.has(rowKey(r)));
}

function renderPager() {
  $('pageInfo').textContent = `صفحة ${state.page} من ${state.totalPages} — ${state.total} سجل`;
  $('prevPage').disabled = state.page <= 1;
  $('nextPage').disabled = state.page >= state.totalPages;
}

async function loadRecords() {
  const seq = ++state.loadSeq;
  message('tableMessage', 'جارٍ التحميل...', 'info');

  const params = new URLSearchParams();
  const f = currentFilters();
  Object.entries(f).forEach(([k, v]) => { if (v) params.set(k, v); });
  params.set('page', String(state.page));
  params.set('pageSize', String(state.pageSize));

  try {
    const data = await api(`/license-records?${params.toString()}`);
    if (seq !== state.loadSeq) return; // a newer request superseded this one

    state.rows = data.rows;
    state.total = data.total;
    state.page = data.page;
    state.totalPages = data.totalPages;

    renderSummary(data.summary);
    renderSortHeaders();
    renderRows();
    renderPager();
    message('tableMessage');
  } catch (error) {
    if (seq === state.loadSeq) message('tableMessage', error.message, 'error');
  }
}

function findRow(key) {
  return state.rows.find((r) => rowKey(r) === key);
}

let searchTimer;
function reloadFromFirstPage() {
  state.page = 1;
  loadRecords();
}

/* ------------------------------------------------------------------- create */

function parseNamesInput() {
  return $('namesInput').value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, price] = line.split('|').map((part) => part.trim());
      const entry = { name };
      if (price) entry.salePrice = price;
      return entry;
    });
}

function updateNamesCount() {
  const n = parseNamesInput().length;
  $('namesCount').textContent = n ? `عدد العملاء المُدخلين: ${n}${n > 1000 ? ' (الحد الأقصى 1000)' : ''}` : '';
}

function setCreateMode(mode) {
  state.createMode = mode;
  $('modeNames').classList.toggle('active', mode === 'names');
  $('modeCount').classList.toggle('active', mode === 'count');
  $('namesBox').classList.toggle('hidden', mode !== 'names');
  $('countBox').classList.toggle('hidden', mode !== 'count');
}

function resetCreateKey() {
  if (!state.createBusy) state.createKey = null;
}

function openCreateModal() {
  message('createMessage');
  $('createResult').classList.add('hidden');
  state.createKey = null;
  $('productSelect').value = ''; // the program must be chosen explicitly every time
  openModal('createModal');
}

async function submitCreate() {
  if (state.createBusy) return;

  const maxDevices = Number($('maxDevices').value);
  if (!Number.isInteger(maxDevices) || maxDevices < 1) {
    message('createMessage', 'الحد الأقصى للأجهزة يجب أن يكون 1 أو أكثر.', 'error');
    return;
  }

  if (!$('productSelect').value) {
    message('createMessage', 'اختر البرنامج أولًا.', 'error');
    return;
  }

  const body = {
    maxDevices,
    plan: $('plan').value.trim() || 'pro',
    duration: $('duration').value,
    productId: $('productSelect').value,
  };

  const defaults = {};
  if ($('defaultPrice').value.trim()) defaults.salePrice = $('defaultPrice').value.trim();
  if ($('defaultCurrency').value.trim()) defaults.currency = $('defaultCurrency').value.trim().toUpperCase();
  if ($('defaultSoldAt').value) defaults.soldAt = $('defaultSoldAt').value;
  if (Object.keys(defaults).length) body.defaults = defaults;

  if (state.createMode === 'names') {
    const customers = parseNamesInput();
    if (!customers.length) { message('createMessage', 'أدخل اسم عميل واحدًا على الأقل.', 'error'); return; }
    if (customers.length > 1000) { message('createMessage', 'الحد الأقصى 1000 ترخيص في العملية الواحدة.', 'error'); return; }
    body.customers = customers;
  } else {
    const quantity = Number($('quantityInput').value);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
      message('createMessage', 'العدد يجب أن يكون بين 1 و1000.', 'error');
      return;
    }
    body.quantity = quantity;
  }

  const n = body.customers ? body.customers.length : body.quantity;
  if (n > 1 && !confirm(`سيتم إنشاء ${n} ترخيص وعميل. هل تريد المتابعة؟`)) return;

  // The same key is reused for double clicks / retries of THIS submission.
  if (!state.createKey) state.createKey = newKey();

  state.createBusy = true;
  $('createSubmitBtn').disabled = true;
  message('createMessage', 'جارٍ الإنشاء... لا تُغلق الصفحة.', 'info');

  try {
    const data = await api('/licenses/bulk', {
      method: 'POST',
      headers: { 'Idempotency-Key': state.createKey },
      body: JSON.stringify(body),
    });

    state.createKey = null; // success: next submission is a new operation
    showCreateResult(data);

    message(
      'createMessage',
      data.replayed
        ? `هذه العملية نُفذت سابقًا — تم عرض نفس النتيجة (${data.quantity} ترخيص) دون إنشاء مكرر.`
        : `تم إنشاء ${data.quantity} ترخيص بنجاح.`,
      'success'
    );

    if (data.duplicateNames && data.duplicateNames.length) {
      toast(`تنبيه: أسماء مكررة (سُجّل كل منها كعميل مستقل): ${data.duplicateNames.slice(0, 5).join('، ')}`);
    }

    await loadRecords();
  } catch (error) {
    message(
      'createMessage',
      `${error.message}${error.status >= 500 ? ' — لم يتم إنشاء أي ترخيص؛ يمكنك إعادة المحاولة بأمان.' : ''}`,
      'error'
    );
  } finally {
    state.createBusy = false;
    $('createSubmitBtn').disabled = false;
  }
}

function showCreateResult(data) {
  state.lastBatchLicenseIds = data.items.map((i) => i.licenseId);
  $('createResultTitle').textContent = `${data.items.length} ترخيص`;
  $('createResultBody').innerHTML = data.items.map((i) => `
    <tr>
      <td class="num">${escapeHtml(i.customerNumber)}</td>
      <td><bdi>${escapeHtml(i.customerName || '—')}</bdi></td>
      <td><span class="key">${escapeHtml(i.licenseKey)}</span></td>
    </tr>`).join('');
  $('createResult').classList.remove('hidden');
  $('createResult').dataset.keys = data.items.map((i) => i.licenseKey).join('\n');
}

/* ----------------------------------------------------------------- customer */

function setCustomerForm(c) {
  $('cName').value = c.name || '';
  $('cEmail').value = c.email || '';
  $('cPrice').value = c.sale_price === null || c.sale_price === undefined ? '' : c.sale_price;
  $('cCurrency').value = c.currency || '';
  $('cSoldAt').value = c.sold_at || '';
  $('cNotes').value = c.notes || '';
  $('cCreatedAt').textContent = c.created_at ? formatDateTime(c.created_at) : '—';
}

async function openCustomer(row) {
  message('customerMessage');
  $('customerLicenseId').value = '';
  $('customerRef').value = row.customer_id;
  $('customerModalTitle').textContent = 'بيانات العميل';
  $('customerModalSub').textContent = 'جارٍ التحميل...';
  $('customerLicensesBox').classList.remove('hidden');
  $('customerLicensesBody').innerHTML = '';
  $('archiveCustomerBtn').classList.add('hidden');
  $('unarchiveCustomerBtn').classList.add('hidden');
  openModal('customerModal');

  try {
    const data = await api(`/customers/${row.customer_id}`);
    const c = data.customer;

    $('customerModalSub').textContent = `رقم العميل: ${c.customer_number}${c.archived_at ? ' — مؤرشف' : ''}`;
    setCustomerForm(c);
    $('archiveCustomerBtn').classList.toggle('hidden', Boolean(c.archived_at));
    $('unarchiveCustomerBtn').classList.toggle('hidden', !c.archived_at);

    $('customerLicensesBody').innerHTML = data.licenses.length
      ? data.licenses.map((l) => `
          <tr>
            <td><span class="key">${escapeHtml(l.license_key)}</span></td>
            <td>${statusBadge(l.status)}</td>
            <td class="num">${escapeHtml(l.active_devices)} / ${escapeHtml(l.max_devices)}</td>
            <td>${formatDate(l.expires_at)}</td>
          </tr>`).join('')
      : '<tr><td colspan="4">لا توجد تراخيص مرتبطة.</td></tr>';
  } catch (error) {
    message('customerMessage', error.message, 'error');
  }
}

function openCompleteData(row) {
  message('customerMessage');
  $('customerRef').value = '';
  $('customerLicenseId').value = row.license_id;
  $('customerModalTitle').textContent = 'استكمال بيانات الترخيص';
  $('customerModalSub').textContent =
    `${row.license_key} — سيُنشأ سجل عميل جديد برقم جديد ويُربط بهذا الترخيص (لا يتغير المفتاح ولا الأجهزة).`;
  setCustomerForm({});
  $('customerLicensesBox').classList.add('hidden');
  $('archiveCustomerBtn').classList.add('hidden');
  $('unarchiveCustomerBtn').classList.add('hidden');
  openModal('customerModal');
}

function customerPayload() {
  return {
    name: $('cName').value.trim(),
    email: $('cEmail').value.trim() || null,
    salePrice: $('cPrice').value.trim() || null,
    currency: $('cCurrency').value.trim().toUpperCase() || null,
    soldAt: $('cSoldAt').value || null,
    notes: $('cNotes').value.trim() || null,
  };
}

async function saveCustomer() {
  const licenseId = $('customerLicenseId').value;
  const ref = $('customerRef').value;
  const payload = customerPayload();

  if (!payload.name) { message('customerMessage', 'اسم العميل مطلوب.', 'error'); return; }

  message('customerMessage', 'جارٍ الحفظ...', 'info');
  $('customerSaveBtn').disabled = true;

  try {
    if (licenseId) {
      const data = await api(`/licenses/${licenseId}/assign-customer`, { method: 'POST', body: JSON.stringify(payload) });
      toast(`تم الحفظ — رقم العميل الجديد: ${data.customer.customer_number}`, 'success');
    } else {
      await api(`/customers/${ref}`, { method: 'PATCH', body: JSON.stringify(payload) });
      toast('تم حفظ بيانات العميل.', 'success');
    }

    closeModal('customerModal');
    await loadRecords();
  } catch (error) {
    message('customerMessage', error.message, 'error');
  } finally {
    $('customerSaveBtn').disabled = false;
  }
}

async function setArchived(archive) {
  const ref = $('customerRef').value;
  const text = archive
    ? 'سيتم إخفاء العميل من القائمة الافتراضية. رقمه يبقى محجوزًا ولا يُعاد استخدامه، ولا يتأثر أي ترخيص. متابعة؟'
    : 'استعادة العميل من الأرشيف؟';
  if (!confirm(text)) return;

  try {
    await api(`/customers/${ref}/${archive ? 'archive' : 'unarchive'}`, { method: 'POST' });
    toast(archive ? 'تمت الأرشفة.' : 'تمت الاستعادة.', 'success');
    closeModal('customerModal');
    await loadRecords();
  } catch (error) {
    message('customerMessage', error.message, 'error');
  }
}

/* ------------------------------------------------- license actions (kept) */

function describe(row) {
  return `${row.customer_number ? `عميل #${row.customer_number} — ` : ''}${row.customer_name || 'بدون اسم'}\n${row.license_key}`;
}

async function revokeLicense(row) {
  if (!confirm(`هل أنت متأكد من إلغاء هذا الترخيص؟\n\n${describe(row)}`)) return;
  try {
    await api(`/licenses/${row.license_id}/revoke`, { method: 'POST' });
    toast('تم إلغاء الترخيص.', 'success');
    await loadRecords();
  } catch (error) { toast(error.message, 'error'); }
}

async function reactivateLicense(row) {
  if (!confirm(`هل تريد إعادة تفعيل هذا الترخيص؟\n\n${describe(row)}`)) return;
  try {
    await api(`/licenses/${row.license_id}/reactivate`, { method: 'POST' });
    toast('تمت إعادة التفعيل.', 'success');
    await loadRecords();
  } catch (error) { toast(error.message, 'error'); }
}

async function deleteLicense(row) {
  const confirmed = confirm(
    'تحذير!\n\nسيتم حذف الترخيص نهائيًا:\n\n' + describe(row) +
    '\n\nسيتم حذف ارتباطات الأجهزة أيضًا.\nلا يمكن التراجع عن هذه العملية.\n\nهل أنت متأكد؟'
  );
  if (!confirmed) return;

  try {
    await api(`/licenses/${row.license_id}`, { method: 'DELETE' });
    toast('تم حذف الترخيص نهائيًا (سجل العميل ورقمه يبقيان).', 'success');
    await loadRecords();
  } catch (error) { toast(`فشل حذف الترخيص: ${error.message}`, 'error'); }
}

function openEditLicense(row) {
  $('editLicenseId').value = row.license_id;
  $('editLicenseKey').textContent = row.license_key;
  $('editMaxDevices').value = row.max_devices;
  $('editPlan').value = row.plan || 'pro';

  const isExpired = row.expires_at && new Date(row.expires_at).getTime() <= Date.now();
  $('editCurrentExpiration').textContent = row.expires_at
    ? `${formatDate(row.expires_at)}${isExpired ? ' (منتهي)' : ''}`
    : 'بدون انتهاء (Lifetime)';

  $('editDuration').value = '';
  message('editMessage');
  openModal('editModal');
}

async function saveLicenseEdit() {
  const id = $('editLicenseId').value;
  const maxDevices = Number($('editMaxDevices').value);
  const plan = $('editPlan').value.trim();
  const duration = $('editDuration').value;

  if (!Number.isInteger(maxDevices) || maxDevices < 1) {
    message('editMessage', 'عدد الأجهزة يجب أن يكون 1 أو أكثر.', 'error');
    return;
  }

  const body = { maxDevices, plan };
  if (duration) body.duration = duration;

  message('editMessage', 'جارٍ حفظ التعديلات...', 'info');

  try {
    await api(`/licenses/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    message('editMessage', 'تم حفظ التعديلات.', 'success');
    await loadRecords();
    setTimeout(() => closeModal('editModal'), 500);
  } catch (error) {
    message('editMessage', error.message, 'error');
  }
}

async function openDevices(row) {
  $('devicesTitle').textContent = `${row.license_key} — ${row.customer_name || 'بدون اسم'}`;
  $('devicesModal').dataset.licenseKey = rowKey(row);
  $('devicesTableBody').innerHTML = '<tr><td colspan="5">جارٍ التحميل...</td></tr>';
  message('devicesMessage');
  openModal('devicesModal');

  try {
    const data = await api(`/licenses/${row.license_id}/devices`);

    if (!data.devices?.length) {
      $('devicesTableBody').innerHTML = '<tr><td colspan="5">لا توجد أجهزة مسجلة.</td></tr>';
      return;
    }

    $('devicesTableBody').innerHTML = data.devices.map((device, index) => `
      <tr>
        <td>الجهاز #${index + 1}</td>
        <td>${formatDate(device.activated_at)}</td>
        <td>${formatDate(device.last_seen_at)}</td>
        <td>${device.deactivated_at
          ? '<span class="badge inactive">غير نشط</span>'
          : '<span class="badge active">نشط</span>'}</td>
        <td>${device.deactivated_at
          ? '-'
          : `<button class="danger" type="button" data-action="reset-device" data-id="${escapeHtml(device.activation_id)}">Reset</button>`}</td>
      </tr>`).join('');
  } catch (error) {
    message('devicesMessage', error.message, 'error');
  }
}

async function resetDevice(activationId) {
  if (!confirm('هل تريد عمل Reset لهذا الجهاز؟')) return;

  try {
    await api(`/licenses/${activationId}/reset-device`, { method: 'POST' });
    const row = findRow($('devicesModal').dataset.licenseKey);
    await loadRecords();
    if (row) await openDevices(findRow(rowKey(row)) || row);
    message('devicesMessage', 'تم عمل Reset للجهاز.', 'success');
  } catch (error) {
    message('devicesMessage', error.message, 'error');
  }
}

/* ------------------------------------------------------------------- export */

async function downloadExport(format, bodyOverride) {
  const scope = bodyOverride ? 'selected' : $('exportScope').value;
  let body;

  if (bodyOverride) {
    body = { format, ...bodyOverride };
  } else if (scope === 'selected') {
    const licenseIds = [];
    const customerIds = [];
    state.selected.forEach((key) => {
      if (key.startsWith('L:')) licenseIds.push(key.slice(2));
      else customerIds.push(key.slice(2));
    });
    if (!licenseIds.length && !customerIds.length) {
      toast('حدّد صفًا واحدًا على الأقل من الجدول أولًا.', 'error');
      return;
    }
    body = { format, scope, licenseIds, customerIds, filters: { sort: state.sort, dir: state.dir } };
  } else if (scope === 'all') {
    body = { format, scope, filters: { archived: $('archivedFilter').value, sort: state.sort, dir: state.dir } };
  } else {
    body = { format, scope: 'search', filters: currentFilters() };
  }

  try {
    const response = await fetch('/api/v1/admin/export', {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (response.status === 401) { logout(); throw new Error('انتهت جلسة الإدارة.'); }

    if (!response.ok) {
      let msg = `فشل التصدير (${response.status}).`;
      try { msg = (await response.json()).message || msg; } catch (_e) { /* keep default */ }
      throw new Error(msg);
    }

    const blob = await response.blob();
    const match = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = match ? match[1] : `licenses.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    toast(`تم التصدير: ${response.headers.get('X-Export-Rows') || '?'} سجل.`, 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ------------------------------------------------------------------- events */

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  message('loginMessage', 'جارٍ تسجيل الدخول...', 'info');
  try {
    await login($('username').value.trim(), $('password').value);
  } catch (error) {
    message('loginMessage', error.message, 'error');
  }
});

$('logoutBtn').addEventListener('click', logout);
$('refreshBtn').addEventListener('click', loadRecords);

$('searchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(reloadFromFirstPage, 300);
});
['statusFilter', 'productFilter', 'archivedFilter', 'incompleteFilter'].forEach((id) =>
  $(id).addEventListener('change', reloadFromFirstPage));

$('pageSize').addEventListener('change', () => {
  state.pageSize = Number($('pageSize').value);
  reloadFromFirstPage();
});
$('prevPage').addEventListener('click', () => { if (state.page > 1) { state.page -= 1; loadRecords(); } });
$('nextPage').addEventListener('click', () => { if (state.page < state.totalPages) { state.page += 1; loadRecords(); } });

document.querySelectorAll('th.sortable').forEach((th) =>
  th.addEventListener('click', () => {
    const column = th.dataset.sort;
    if (state.sort === column) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
    else { state.sort = column; state.dir = column === 'created_at' ? 'desc' : 'asc'; }
    reloadFromFirstPage();
  }));

$('selectAll').addEventListener('change', (event) => {
  state.rows.forEach((row) => {
    if (event.target.checked) state.selected.add(rowKey(row));
    else state.selected.delete(rowKey(row));
  });
  renderRows();
});

$('exportXlsxBtn').addEventListener('click', () => downloadExport('xlsx'));
$('exportCsvBtn').addEventListener('click', () => downloadExport('csv'));

$('createLicenseBtn').addEventListener('click', openCreateModal);
$('modeNames').addEventListener('click', () => { setCreateMode('names'); resetCreateKey(); });
$('modeCount').addEventListener('click', () => { setCreateMode('count'); resetCreateKey(); });
$('namesInput').addEventListener('input', updateNamesCount);
$('createLicenseForm').addEventListener('input', resetCreateKey);
$('createLicenseForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await submitCreate();
});
$('copyAllKeysBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('createResult').dataset.keys || '');
    toast('تم نسخ المفاتيح.', 'success');
  } catch (_e) { toast('تعذر النسخ.', 'error'); }
});
$('exportBatchBtn').addEventListener('click', () =>
  downloadExport('csv', { scope: 'selected', licenseIds: state.lastBatchLicenseIds, customerIds: [], filters: {} }));

$('customerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveCustomer();
});
$('archiveCustomerBtn').addEventListener('click', () => setArchived(true));
$('unarchiveCustomerBtn').addEventListener('click', () => setArchived(false));

$('editLicenseForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveLicenseEdit();
});

document.addEventListener('change', (event) => {
  const key = event.target.dataset && event.target.dataset.select;
  if (!key) return;
  if (event.target.checked) state.selected.add(key); else state.selected.delete(key);
  $('selectAll').checked = state.rows.length > 0 && state.rows.every((r) => state.selected.has(rowKey(r)));
});

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;

  const copyValue = target.dataset.copy;
  if (copyValue) {
    try {
      await navigator.clipboard.writeText(copyValue);
      const original = target.textContent;
      target.textContent = 'تم النسخ';
      setTimeout(() => { target.textContent = original; }, 1200);
    } catch (_e) { toast('تعذر نسخ المفتاح.', 'error'); }
    return;
  }

  const { action, key, id } = target.dataset;
  if (!action) return;

  if (action === 'reset-device') { await resetDevice(id); return; }

  const row = key ? findRow(key) : null;
  if (!row) return;

  if (action === 'customer') await openCustomer(row);
  else if (action === 'complete') openCompleteData(row);
  else if (action === 'devices') await openDevices(row);
  else if (action === 'edit') openEditLicense(row);
  else if (action === 'revoke') await revokeLicense(row);
  else if (action === 'reactivate') await reactivateLicense(row);
  else if (action === 'delete') await deleteLicense(row);
});

document.querySelectorAll('[data-close]').forEach((button) =>
  button.addEventListener('click', () => closeModal(button.dataset.close)));

/* ----------------------------------------------------------------- products */

state.products = [];
state.editingProduct = null;

function fillProductSelects() {
  const keepFilter = $('productFilter').value;
  const keepCreate = $('productSelect').value;
  const opts = state.products
    .map((p) => `<option value="${escapeHtml(p.product_id)}"${p.status === 'disabled' ? ' disabled' : ''}>${escapeHtml(p.name)} (${escapeHtml(p.product_id)})${p.status === 'disabled' ? ' — معطّل' : ''}</option>`)
    .join('');
  $('productFilter').innerHTML = `<option value="">كل البرامج</option>${state.products
    .map((p) => `<option value="${escapeHtml(p.product_id)}">${escapeHtml(p.name)}</option>`).join('')}`;
  $('productSelect').innerHTML = `<option value="">— اختر البرنامج —</option>${opts}`;
  $('productFilter').value = keepFilter;
  $('productSelect').value = keepCreate;
}

function renderProducts() {
  const body = $('productsTableBody');
  body.innerHTML = state.products.map((p) => `
    <tr>
      <td dir="ltr"><span class="key">${escapeHtml(p.product_id)}</span></td>
      <td><bdi>${escapeHtml(p.name)}</bdi></td>
      <td>${escapeHtml(p.description || '—')}</td>
      <td>${p.status === 'active' ? '<span class="badge active">نشط</span>' : '<span class="badge inactive">معطّل</span>'}</td>
      <td class="num">${escapeHtml(p.licenses)} (${escapeHtml(p.active_licenses)} نشط)</td>
      <td class="num">${escapeHtml(p.customers)}</td>
      <td class="num">${escapeHtml(p.devices)}</td>
      <td><div class="actions">
        <button class="secondary" type="button" data-paction="edit" data-pid="${escapeHtml(p.product_id)}">تعديل</button>
        <button class="${p.status === 'active' ? 'danger' : 'success'}" type="button" data-paction="toggle" data-pid="${escapeHtml(p.product_id)}">${p.status === 'active' ? 'تعطيل' : 'تفعيل'}</button>
      </div></td>
    </tr>`).join('') || '<tr><td colspan="8">لا توجد برامج.</td></tr>';
}

async function loadProducts() {
  try {
    const data = await api('/products');
    state.products = data.products;
    fillProductSelects();
    renderProducts();
    message('productsMessage');
  } catch (error) {
    message('productsMessage', error.message, 'error');
  }
}

function showTab(name) {
  const products = name === 'products';
  $('licensesPanel').classList.toggle('hidden', products);
  $('productsPanel').classList.toggle('hidden', !products);
  $('tabLicenses').classList.toggle('active', !products);
  $('tabProducts').classList.toggle('active', products);
  if (products) loadProducts();
}

function openProductModal(product) {
  state.editingProduct = product || null;
  message('productMessage');
  $('productModalTitle').textContent = product ? 'تعديل برنامج' : 'إضافة برنامج';
  $('productIdInput').value = product ? product.product_id : '';
  $('productIdInput').disabled = Boolean(product);
  $('productNameInput').value = product ? product.name : '';
  $('productDescInput').value = product ? product.description || '' : '';
  openModal('productModal');
}

async function saveProduct() {
  const payload = {
    name: $('productNameInput').value,
    description: $('productDescInput').value,
  };
  try {
    if (state.editingProduct) {
      await api(`/products/${encodeURIComponent(state.editingProduct.product_id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
    } else {
      await api('/products', { method: 'POST', body: JSON.stringify({ ...payload, productId: $('productIdInput').value.trim() }) });
    }
    closeModal('productModal');
    toast('تم حفظ البرنامج.', 'success');
    await loadProducts();
  } catch (error) {
    message('productMessage', error.message, 'error');
  }
}

async function toggleProduct(product) {
  const disabling = product.status === 'active';
  const text = disabling
    ? `تعطيل "${product.name}"؟ لن يمكن إنشاء تراخيص جديدة أو تفعيل أجهزة جديدة له. الأجهزة المفعّلة حاليًا تستمر في العمل.`
    : `إعادة تفعيل "${product.name}"؟`;
  if (!window.confirm(text)) return;
  try {
    await api(`/products/${encodeURIComponent(product.product_id)}`, { method: 'PATCH', body: JSON.stringify({ status: disabling ? 'disabled' : 'active' }) });
    await loadProducts();
  } catch (error) {
    message('productsMessage', error.message, 'error');
  }
}

$('tabLicenses').addEventListener('click', () => showTab('licenses'));
$('tabProducts').addEventListener('click', () => showTab('products'));
$('addProductBtn').addEventListener('click', () => openProductModal(null));
$('productForm').addEventListener('submit', async (event) => { event.preventDefault(); await saveProduct(); });
$('productsTableBody').addEventListener('click', (event) => {
  const b = event.target.closest('button[data-pid]');
  if (!b) return;
  const product = state.products.find((p) => p.product_id === b.dataset.pid);
  if (!product) return;
  if (b.dataset.paction === 'edit') openProductModal(product);
  else toggleProduct(product);
});

setCreateMode('names');

if (state.token) {
  showDashboard();
  loadProducts();
  loadRecords().catch(() => logout());
} else {
  showLogin();
}
