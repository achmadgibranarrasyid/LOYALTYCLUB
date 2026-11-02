const $ = (selector, element = document) => element.querySelector(selector);
let customerSearchTimer;

async function adminRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    },
    credentials: 'same-origin'
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw new Error(result.error || 'Permintaan gagal. Silakan coba lagi.');
  }
  return result;
}

function showLogin() {
  $('#adminLoginPanel').classList.remove('hidden');
  $('#adminDashboard').classList.add('hidden');
  $('#adminLogout').classList.add('hidden');
}

function showDashboard() {
  $('#adminLoginPanel').classList.add('hidden');
  $('#adminDashboard').classList.remove('hidden');
  $('#adminLogout').classList.remove('hidden');
}

function setText(element, value) {
  element.textContent = value;
  return element;
}

function createAdminButton(label, className, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}

function resetPromoForm() {
  $('#promoForm').reset();
  $('#promoId').value = '';
  $('#promoStartsOn').value = '';
  $('#promoEndsOn').value = '';
  $('#promoFormTitle').textContent = 'Tambah promo';
  $('#cancelPromoEdit').classList.add('hidden');
  $('#promoFormError').textContent = '';
}

function editPromo(promo) {
  $('#promoId').value = promo.id;
  $('#promoCategory').value = promo.category;
  $('#promoLabel').value = promo.label;
  $('#promoTitle').value = promo.title;
  $('#promoDescription').value = promo.description;
  $('#promoPriceOld').value = promo.price_old;
  $('#promoPriceNew').value = promo.price_new;
  $('#promoStartsOn').value = promo.starts_on || '';
  $('#promoEndsOn').value = promo.ends_on || '';
  $('#promoFormTitle').textContent = 'Edit promo';
  $('#cancelPromoEdit').classList.remove('hidden');
  $('#promoFormError').textContent = '';
  $('#promoForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderPromos(promos) {
  const list = $('#promoList');
  list.replaceChildren();
  $('#promoCount').textContent = promos.length;
  $('#activePromoCount').textContent = promos.filter(
    promo => promo.active && isPromoCurrent(promo)
  ).length;

  if (!promos.length) {
    list.append(setText(document.createElement('p'), 'Belum ada promo. Tambahkan promo baru.'));
    return;
  }

  promos.forEach(promo => {
    const card = document.createElement('article');
    card.className = 'admin-promo-item';
    const details = document.createElement('div');
    const title = setText(document.createElement('strong'), promo.title);
    const meta = setText(document.createElement('p'), `${promo.label} · ${promo.category === 'bundling' ? 'Bundling' : 'Diskon'}`);
    const description = setText(document.createElement('p'), promo.description);
    const current = isPromoCurrent(promo);
    const statusText = !promo.active ? 'Nonaktif' : !current ? 'Di luar masa berlaku' : 'Aktif';
    const status = setText(document.createElement('span'), statusText);
    status.className = `admin-status ${promo.active && current ? 'is-active' : ''}`;
    const validity = setText(
      document.createElement('p'),
      `Berlaku: ${promo.starts_on || 'sekarang'} – ${promo.ends_on || 'seterusnya'}`
    );
    details.append(title, meta, description, validity, status);

    const actions = document.createElement('div');
    actions.className = 'admin-promo-actions';
    actions.append(
      createAdminButton('Edit', 'btn btn-ghost', () => editPromo(promo)),
      createAdminButton(promo.active ? 'Nonaktifkan' : 'Aktifkan', 'btn btn-ghost', async () => {
        try {
          await adminRequest(`/api/admin/promos/${promo.id}/active`, {
            method: 'PATCH',
            body: JSON.stringify({ active: !promo.active })
          });
          await loadDashboard();
          $('#promoError').textContent = '';
        } catch (error) {
          $('#promoError').textContent = error.message;
        }
      }),
      createAdminButton('Hapus', 'btn btn-ghost danger', async () => {
        if (!window.confirm(`Hapus promo "${promo.title}"?`)) return;
        try {
          await adminRequest(`/api/admin/promos/${promo.id}`, { method: 'DELETE' });
          resetPromoForm();
          await loadDashboard();
          $('#promoError').textContent = '';
        } catch (error) {
          $('#promoError').textContent = error.message;
        }
      })
    );
    card.append(details, actions);
    list.append(card);
  });
}

function isPromoCurrent(promo) {
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return (!promo.starts_on || promo.starts_on <= date) && (!promo.ends_on || promo.ends_on >= date);
}

function renderCustomers(customers, search = '') {
  $('#customerCount').textContent = customers.length;
  const rows = $('#customerRows');
  rows.replaceChildren();
  if (!customers.length) {
    const row = document.createElement('tr');
    const cell = setText(
      document.createElement('td'),
      search ? 'Tidak ada pelanggan yang cocok dengan pencarian.' : 'Belum ada pelanggan terdaftar.'
    );
    cell.colSpan = 5;
    row.append(cell);
    rows.append(row);
    return;
  }
  customers.forEach(customer => {
    const row = document.createElement('tr');
    [
      customer.member_id,
      customer.name,
      customer.email,
      customer.phone,
      new Date(customer.joined).toLocaleDateString('id-ID', { dateStyle: 'medium' })
    ].forEach(value => row.append(setText(document.createElement('td'), value)));
    rows.append(row);
  });
}

function updateClaimOptions(customers, promos) {
  const customerSelect = $('#claimCustomer');
  const promoSelect = $('#claimPromo');
  const previousCustomer = customerSelect.value;
  const previousPromo = promoSelect.value;
  customerSelect.replaceChildren();
  promoSelect.replaceChildren();

  const chooseCustomer = new Option('Pilih pelanggan', '');
  const choosePromo = new Option('Pilih promo yang berlaku', '');
  chooseCustomer.disabled = true;
  choosePromo.disabled = true;
  chooseCustomer.selected = true;
  choosePromo.selected = true;
  customerSelect.append(chooseCustomer);
  promoSelect.append(choosePromo);
  customers.forEach(customer => {
    customerSelect.add(new Option(`${customer.name} · ${customer.member_id}`, customer.member_id));
  });
  promos.filter(promo => promo.active && isPromoCurrent(promo)).forEach(promo => {
    promoSelect.add(new Option(`${promo.title} · ${promo.label}`, String(promo.id)));
  });
  if ([...customerSelect.options].some(option => option.value === previousCustomer)) {
    customerSelect.value = previousCustomer;
  }
  if ([...promoSelect.options].some(option => option.value === previousPromo)) {
    promoSelect.value = previousPromo;
  }
  $('#claimForm button[type="submit"]').disabled = customers.length === 0 || !promos.some(
    promo => promo.active && isPromoCurrent(promo)
  );
}

function renderClaims(claims) {
  const rows = $('#claimRows');
  rows.replaceChildren();
  if (!claims.length) {
    const row = document.createElement('tr');
    const cell = setText(document.createElement('td'), 'Belum ada klaim yang dicatat.');
    cell.colSpan = 4;
    row.append(cell);
    rows.append(row);
    return;
  }
  claims.forEach(claim => {
    const row = document.createElement('tr');
    [
      new Date(claim.claimed_at).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }),
      claim.customer_name,
      claim.member_id,
      claim.promo_title
    ].forEach(value => row.append(setText(document.createElement('td'), value)));
    rows.append(row);
  });
}

function renderAnalytics(analytics) {
  $('#claimCount').textContent = analytics.total_claims;
  $('#claimWeekCount').textContent = analytics.last_7_days;
  const chart = $('#claimChart');
  chart.replaceChildren();
  const maxCount = Math.max(1, ...analytics.daily.map(day => day.count));
  analytics.daily.forEach(day => {
    const column = document.createElement('div');
    column.className = 'claim-chart-column';
    const count = setText(document.createElement('span'), day.count);
    count.className = 'claim-chart-count';
    const track = document.createElement('div');
    track.className = 'claim-chart-track';
    const bar = document.createElement('div');
    bar.className = 'claim-chart-bar';
    bar.style.height = `${Math.max(4, day.count / maxCount * 100)}%`;
    track.append(bar);
    const label = setText(
      document.createElement('span'),
      new Date(`${day.date}T12:00:00`).toLocaleDateString('id-ID', { weekday: 'short' })
    );
    label.className = 'claim-chart-label';
    column.append(count, track, label);
    chart.append(column);
  });
  const top = $('#topPromos');
  top.replaceChildren();
  top.append(setText(document.createElement('strong'), 'Promo paling sering diklaim'));
  if (!analytics.top_promos.length) {
    top.append(setText(document.createElement('p'), 'Belum ada klaim.'));
    return;
  }
  const list = document.createElement('ol');
  analytics.top_promos.forEach(promo => {
    const item = document.createElement('li');
    item.append(setText(document.createElement('span'), promo.title));
    item.append(setText(document.createElement('strong'), promo.count));
    list.append(item);
  });
  top.append(list);
}

async function loadCustomers() {
  const search = $('#customerSearch').value.trim();
  const query = search ? `?q=${encodeURIComponent(search)}` : '';
  try {
    const customers = await adminRequest(`/api/admin/customers${query}`);
    renderCustomers(customers, search);
    $('#customerError').textContent = '';
    $('#exportCustomers').href = `/api/admin/customers.csv${query}`;
  } catch (error) {
    $('#customerError').textContent = error.message;
  }
}

async function loadDashboard() {
  const search = $('#customerSearch').value.trim();
  const customerQuery = search ? `?q=${encodeURIComponent(search)}` : '';
  const [promoResult, customerResult, claimResult, analyticsResult] = await Promise.allSettled([
    adminRequest('/api/admin/promos'),
    adminRequest('/api/admin/customers'),
    adminRequest('/api/admin/claims'),
    adminRequest('/api/admin/analytics')
  ]);
  const customers = customerResult.status === 'fulfilled' ? customerResult.value : [];
  const promos = promoResult.status === 'fulfilled' ? promoResult.value : [];
  updateClaimOptions(customers, promos);
  if (promoResult.status === 'fulfilled') {
    renderPromos(promos);
    $('#promoError').textContent = '';
  } else {
    $('#promoError').textContent = promoResult.reason.message;
  }
  if (customerResult.status === 'fulfilled') {
    const filteredCustomers = search
      ? await adminRequest(`/api/admin/customers${customerQuery}`).catch(error => {
        $('#customerError').textContent = error.message;
        return null;
      })
      : customers;
    if (filteredCustomers) renderCustomers(filteredCustomers, search);
    if (filteredCustomers) $('#exportCustomers').href = `/api/admin/customers.csv${customerQuery}`;
    $('#customerError').textContent = '';
  } else {
    $('#customerError').textContent = customerResult.reason.message;
  }
  if (claimResult.status === 'fulfilled') {
    renderClaims(claimResult.value);
    $('#claimError').textContent = '';
  } else {
    $('#claimError').textContent = claimResult.reason.message;
  }
  if (analyticsResult.status === 'fulfilled') {
    renderAnalytics(analyticsResult.value);
  } else {
    $('#claimError').textContent = analyticsResult.reason.message;
  }
}

$('#adminLoginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const error = $('#adminLoginError');
  const button = $('#adminLoginForm button[type="submit"]');
  button.disabled = true;
  error.textContent = '';
  try {
    await adminRequest('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({
        username: $('#adminUsername').value.trim(),
        password: $('#adminPassword').value
      })
    });
    $('#adminPassword').value = '';
    showDashboard();
    await loadDashboard();
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    button.disabled = false;
  }
});

$('#promoForm').addEventListener('submit', async event => {
  event.preventDefault();
  const error = $('#promoFormError');
  const button = $('#promoForm button[type="submit"]');
  const id = $('#promoId').value;
  const payload = {
    category: $('#promoCategory').value,
    label: $('#promoLabel').value,
    title: $('#promoTitle').value,
    description: $('#promoDescription').value,
    price_old: $('#promoPriceOld').value,
    price_new: $('#promoPriceNew').value,
    starts_on: $('#promoStartsOn').value,
    ends_on: $('#promoEndsOn').value
  };
  button.disabled = true;
  error.textContent = '';
  try {
    await adminRequest(id ? `/api/admin/promos/${id}` : '/api/admin/promos', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });
    resetPromoForm();
    await loadDashboard();
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    button.disabled = false;
  }
});

$('#claimForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#claimForm button[type="submit"]');
  button.disabled = true;
  $('#claimError').textContent = '';
  try {
    await adminRequest('/api/admin/claims', {
      method: 'POST',
      body: JSON.stringify({
        member_id: $('#claimCustomer').value,
        promo_id: Number($('#claimPromo').value)
      })
    });
    $('#claimCustomer').selectedIndex = 0;
    $('#claimPromo').selectedIndex = 0;
    await loadDashboard();
  } catch (error) {
    $('#claimError').textContent = error.message;
  } finally {
    button.disabled = !$('#claimCustomer').value || !$('#claimPromo').value;
  }
});

['#claimCustomer', '#claimPromo'].forEach(selector => {
  $(selector).addEventListener('change', () => {
    $('#claimForm button[type="submit"]').disabled = !$('#claimCustomer').value || !$('#claimPromo').value;
  });
});

$('#customerSearch').addEventListener('input', () => {
  clearTimeout(customerSearchTimer);
  customerSearchTimer = setTimeout(loadCustomers, 250);
});

$('#cancelPromoEdit').addEventListener('click', resetPromoForm);
$('#newPromo').addEventListener('click', () => {
  resetPromoForm();
  $('#promoForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
$('#refreshDashboard').addEventListener('click', async () => {
  try {
    await loadDashboard();
  } catch (error) {
    $('#customerError').textContent = error.message;
  }
});
$('#adminLogout').addEventListener('click', async () => {
  try {
    await adminRequest('/api/admin/logout', { method: 'POST', body: '{}' });
    showLogin();
  } catch (error) {
    $('#adminLoginError').textContent = error.message;
  }
});

adminRequest('/api/admin/session')
  .then(async session => {
    if (!session.authenticated) return;
    showDashboard();
    await loadDashboard();
  })
  .catch(error => {
    $('#adminLoginError').textContent = error.message;
  });
