const $ = (selector, element = document) => element.querySelector(selector);
let customerSearchTimer;
let claimCustomerSearchTimer;
let claimCustomerSearchSequence = 0;
let adminToastTimer;

function notifyAdmin(message, type = 'success') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `show ${type}`;
  clearTimeout(adminToastTimer);
  adminToastTimer = setTimeout(() => { toast.className = ''; }, 3000);
}

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

function resetRewardForm() {
  $('#rewardForm').reset();
  $('#rewardId').value = '';
  $('#rewardFormTitle').textContent = 'Tambah reward';
  $('#cancelRewardEdit').classList.add('hidden');
  $('#rewardFormError').textContent = '';
  updateRewardDiscountField();
}

function updateRewardDiscountField() {
  const isDiscount = $('#rewardType').value === 'discount';
  $('#rewardDiscountField').classList.toggle('hidden', !isDiscount);
  $('#rewardDiscountAmount').required = isDiscount;
  if (!isDiscount) $('#rewardDiscountAmount').value = '';
}

function editReward(reward) {
  $('#rewardId').value = reward.id;
  $('#rewardType').value = reward.type;
  $('#rewardName').value = reward.name;
  $('#rewardDescription').value = reward.description;
  $('#rewardPointsCost').value = reward.points_cost;
  $('#rewardDiscountAmount').value = reward.discount_amount || '';
  $('#rewardFormTitle').textContent = 'Edit reward';
  $('#cancelRewardEdit').classList.remove('hidden');
  $('#rewardFormError').textContent = '';
  updateRewardDiscountField();
  $('#rewardForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    cell.colSpan = 7;
    row.append(cell);
    rows.append(row);
    return;
  }
  customers.forEach(customer => {
    const row = document.createElement('tr');
    [
      customer.name,
      customer.email,
      customer.phone,
      new Date(Number(customer.joined)).toLocaleDateString('id-ID', { dateStyle: 'medium' }),
      `Rp${Number(customer.total_spend).toLocaleString('id-ID')}`,
      Number(customer.points_balance).toLocaleString('id-ID')
    ].forEach(value => row.append(setText(document.createElement('td'), value)));
    row.append(setText(document.createElement('td'), customer.tier_name || 'Bronze'));
    rows.append(row);
  });
}

function updateSpendCustomerOptions(customers) {
  ['#spendCustomer', '#baselineCustomer'].forEach(selector => {
    const select = $(selector);
    const previous = select.value;
    select.replaceChildren(new Option('Pilih pelanggan', ''));
    customers.forEach(customer => {
      select.add(new Option(`${customer.name} · ${customer.phone}`, customer.member_id));
    });
    if (customers.some(customer => customer.member_id === previous)) select.value = previous;
  });
}

function updateClaimOptions(customers, promos) {
  const promoSelect = $('#claimPromo');
  const previousPromo = promoSelect.value;
  promoSelect.replaceChildren();

  const choosePromo = new Option('Pilih promo yang berlaku', '');
  choosePromo.disabled = true;
  choosePromo.selected = true;
  promoSelect.append(choosePromo);
  promos.filter(promo => promo.active && isPromoCurrent(promo)).forEach(promo => {
    promoSelect.add(new Option(`${promo.title} · ${promo.label}`, String(promo.id)));
  });
  if ([...promoSelect.options].some(option => option.value === previousPromo)) {
    promoSelect.value = previousPromo;
  }
  $('#claimForm button[type="submit"]').disabled = !$('#claimCustomer').value || !promos.some(
    promo => promo.active && isPromoCurrent(promo)
  );

  ['#adjustCustomer', '#redeemCustomer'].forEach(selector => {
    const select = $(selector);
    const previous = select.value;
    select.replaceChildren(new Option('Pilih pelanggan', ''));
    select.options[0].disabled = true;
    select.options[0].selected = true;
    customers.forEach(customer => {
      select.add(new Option(`${customer.name} · ${customer.email} · ${Number(customer.points_balance).toLocaleString('id-ID')} poin`, customer.member_id));
    });
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  });
}

function updateClaimSubmitState() {
  $('#claimForm button[type="submit"]').disabled = !$('#claimCustomer').value || !$('#claimPromo').value;
}

function clearClaimCustomerSelection() {
  claimCustomerSearchSequence += 1;
  $('#claimCustomer').value = '';
  $('#claimCustomerSelection').textContent = '';
  $('#claimCustomerResults').replaceChildren();
  $('#claimCustomerResults').classList.add('hidden');
  $('#claimCustomerSearch').setAttribute('aria-expanded', 'false');
  updateClaimSubmitState();
}

function selectClaimCustomer(customer) {
  clearTimeout(claimCustomerSearchTimer);
  claimCustomerSearchSequence += 1;
  $('#claimCustomer').value = customer.member_id;
  $('#claimCustomerSearch').value = `${customer.name} · ${customer.phone}`;
  $('#claimCustomerSelection').textContent = `Member dipilih: ${customer.name} · ${customer.phone}`;
  $('#claimCustomerResults').replaceChildren();
  $('#claimCustomerResults').classList.add('hidden');
  $('#claimCustomerSearch').setAttribute('aria-expanded', 'false');
  $('#claimError').textContent = '';
  updateClaimSubmitState();
}

function renderClaimCustomerResults(customers, search) {
  const results = $('#claimCustomerResults');
  results.replaceChildren();
  if (!customers.length) {
    const empty = setText(document.createElement('p'), `Pelanggan dengan nama, nomor, atau email “${search}” tidak ditemukan.`);
    empty.className = 'claim-customer-empty';
    results.append(empty);
  } else {
    customers.forEach(customer => {
      const option = createAdminButton(
        `${customer.name} · ${customer.phone} · ${customer.email}`,
        'claim-customer-option',
        () => selectClaimCustomer(customer)
      );
      option.setAttribute('role', 'option');
      results.append(option);
    });
  }
  results.classList.remove('hidden');
  $('#claimCustomerSearch').setAttribute('aria-expanded', 'true');
}

async function searchClaimCustomers() {
  const search = $('#claimCustomerSearch').value.trim();
  const requestId = ++claimCustomerSearchSequence;
  if (search.length < 2) {
    $('#claimCustomerResults').replaceChildren();
    $('#claimCustomerResults').classList.add('hidden');
    $('#claimCustomerSearch').setAttribute('aria-expanded', 'false');
    return;
  }
  try {
    const customers = await adminRequest(`/api/admin/claim-customers?q=${encodeURIComponent(search)}`);
    if (requestId !== claimCustomerSearchSequence) return;
    renderClaimCustomerResults(customers, search);
  } catch (error) {
    if (requestId === claimCustomerSearchSequence) $('#claimError').textContent = error.message;
  }
}

function updateRewardOptions(rewards) {
  const select = $('#redeemReward');
  const previous = select.value;
  select.replaceChildren(new Option('Pilih reward', ''));
  select.options[0].disabled = true;
  select.options[0].selected = true;
  rewards.filter(reward => reward.active).forEach(reward => {
    const discount = reward.type === 'discount'
      ? ` · Diskon Rp${Number(reward.discount_amount).toLocaleString('id-ID')}`
      : '';
    select.add(new Option(`${reward.name} · ${Number(reward.points_cost).toLocaleString('id-ID')} poin${discount}`, String(reward.id)));
  });
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
}

function renderRewards(rewards) {
  const list = $('#rewardList');
  list.replaceChildren();
  if (!rewards.length) {
    list.append(setText(document.createElement('p'), 'Belum ada reward. Tambahkan reward baru.'));
    updateRewardOptions(rewards);
    return;
  }
  rewards.forEach(reward => {
    const card = document.createElement('article');
    card.className = 'admin-promo-item';
    const details = document.createElement('div');
    const title = setText(document.createElement('strong'), reward.name);
    const kind = reward.type === 'free_drink' ? 'Minuman gratis' : reward.type === 'discount' ? 'Diskon' : 'Reward khusus';
    const meta = setText(document.createElement('p'), `${kind} · ${Number(reward.points_cost).toLocaleString('id-ID')} poin`);
    const description = setText(
      document.createElement('p'),
      reward.type === 'discount'
        ? `Diskon Rp${Number(reward.discount_amount).toLocaleString('id-ID')}${reward.description ? ` · ${reward.description}` : ''}`
        : reward.description
    );
    const status = setText(document.createElement('span'), reward.active ? 'Aktif' : 'Nonaktif');
    status.className = `admin-status ${reward.active ? 'is-active' : ''}`;
    details.append(title, meta, description, status);
    const actions = document.createElement('div');
    actions.className = 'admin-promo-actions';
    actions.append(
      createAdminButton('Edit', 'btn btn-ghost', () => editReward(reward)),
      createAdminButton(reward.active ? 'Nonaktifkan' : 'Aktifkan', 'btn btn-ghost', async () => {
        try {
          await adminRequest(`/api/admin/rewards/${reward.id}/active`, {
            method: 'PATCH',
            body: JSON.stringify({ active: !reward.active })
          });
          await loadDashboard();
          $('#rewardError').textContent = '';
        } catch (error) {
          $('#rewardError').textContent = error.message;
        }
      }),
      createAdminButton('Hapus', 'btn btn-ghost danger', async () => {
        if (!window.confirm(`Hapus reward "${reward.name}"?`)) return;
        try {
          await adminRequest(`/api/admin/rewards/${reward.id}`, { method: 'DELETE' });
          resetRewardForm();
          await loadDashboard();
          $('#rewardError').textContent = '';
        } catch (error) {
          $('#rewardError').textContent = error.message;
        }
      })
    );
    card.append(details, actions);
    list.append(card);
  });
  updateRewardOptions(rewards);
}

function renderTiers(tiers) {
  const list = $('#tierList');
  list.replaceChildren();
  tiers.forEach(tier => {
    const card = document.createElement('article');
    card.className = 'admin-promo-item';
    const details = document.createElement('div');
    details.append(
      setText(document.createElement('strong'), tier.name),
      setText(document.createElement('p'), `Mulai dari Rp${Number(tier.min_spend).toLocaleString('id-ID')}`),
      setText(document.createElement('p'), `${Number(tier.member_count)} pelanggan`),
    );
    card.append(details);
    list.append(card);
  });
  const silver = tiers.find(tier => tier.name === 'Silver');
  const gold = tiers.find(tier => tier.name === 'Gold');
  if (silver && gold) {
    $('#silverMinSpend').value = silver.min_spend;
    $('#goldMinSpend').value = gold.min_spend;
  }
}

function renderClaims(claims) {
  const rows = $('#claimRows');
  rows.replaceChildren();
  if (!claims.length) {
    const row = document.createElement('tr');
    const cell = setText(document.createElement('td'), 'Belum ada klaim yang dicatat.');
    cell.colSpan = 3;
    row.append(cell);
    rows.append(row);
    return;
  }
  claims.forEach(claim => {
    const row = document.createElement('tr');
    [
      new Date(claim.claimed_at).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }),
      claim.customer_name,
      claim.promo_title
    ].forEach(value => row.append(setText(document.createElement('td'), value)));
    rows.append(row);
  });
}

function renderPointsTransactions(transactions) {
  const rows = $('#pointTransactionRows');
  rows.replaceChildren();
  if (!transactions.length) {
    const row = document.createElement('tr');
    const cell = setText(document.createElement('td'), 'Belum ada transaksi poin.');
    cell.colSpan = 4;
    row.append(cell);
    rows.append(row);
    return;
  }
  transactions.forEach(transaction => {
    const row = document.createElement('tr');
    const points = setText(
      document.createElement('td'),
      `${Number(transaction.points_delta) > 0 ? '+' : ''}${Number(transaction.points_delta).toLocaleString('id-ID')}`
    );
    points.className = Number(transaction.points_delta) > 0 ? 'points-earned' : 'points-spent';
    [
      new Date(Number(transaction.created_at)).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }),
      transaction.customer_name || 'Pelanggan dihapus',
      transaction.description
    ].forEach(value => row.append(setText(document.createElement('td'), value)));
    row.append(points);
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
  const [promoResult, customerResult, claimResult, analyticsResult, tiersResult, rewardsResult, pointsResult] = await Promise.allSettled([
    adminRequest('/api/admin/promos'),
    adminRequest('/api/admin/customers'),
    adminRequest('/api/admin/claims'),
    adminRequest('/api/admin/analytics'),
    adminRequest('/api/admin/tiers'),
    adminRequest('/api/admin/rewards'),
    adminRequest('/api/admin/points/transactions')
  ]);
  const customers = customerResult.status === 'fulfilled' ? customerResult.value : [];
  const promos = promoResult.status === 'fulfilled' ? promoResult.value : [];
  if (customerResult.status === 'fulfilled') updateSpendCustomerOptions(customers);
  updateClaimOptions(customers, promos);
  if (tiersResult.status === 'fulfilled') {
    renderTiers(tiersResult.value);
    $('#tierError').textContent = '';
  } else {
    $('#tierError').textContent = tiersResult.reason.message;
  }
  if (rewardsResult.status === 'fulfilled') {
    renderRewards(rewardsResult.value);
    $('#rewardError').textContent = '';
  } else {
    $('#rewardError').textContent = rewardsResult.reason.message;
  }
  if (pointsResult.status === 'fulfilled') {
    renderPointsTransactions(pointsResult.value);
    $('#pointTransactionsError').textContent = '';
  } else {
    $('#pointTransactionsError').textContent = pointsResult.reason.message;
  }
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

$('#tierSettingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const error = $('#tierFormError');
  const button = $('#tierSettingsForm button[type="submit"]');
  button.disabled = true;
  error.textContent = '';
  try {
    await adminRequest('/api/admin/tiers/settings', {
      method: 'POST',
      body: JSON.stringify({
        silver_min_spend: Number($('#silverMinSpend').value),
        gold_min_spend: Number($('#goldMinSpend').value)
      })
    });
    await loadDashboard();
    notifyAdmin('Ambang tier berhasil disimpan dan tier pelanggan diperbarui.');
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    button.disabled = false;
  }
});

$('#spendForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#spendForm button[type="submit"]');
  button.disabled = true;
  $('#spendError').textContent = '';
  try {
    const result = await adminRequest('/api/admin/spend/record', {
      method: 'POST',
      body: JSON.stringify({
        member_id: $('#spendCustomer').value,
        amount: Number($('#spendAmount').value),
        description: $('#spendDescription').value
      })
    });
    $('#spendForm').reset();
    await loadDashboard();
    notifyAdmin(`Transaksi dicatat. Total belanja Rp${Number(result.total_spend).toLocaleString('id-ID')} · Tier ${result.tier || 'Bronze'}.`);
  } catch (error) {
    $('#spendError').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('#spendBaselineForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#spendBaselineForm button[type="submit"]');
  button.disabled = true;
  $('#baselineError').textContent = '';
  try {
    const result = await adminRequest('/api/admin/spend/baseline', {
      method: 'POST',
      body: JSON.stringify({
        member_id: $('#baselineCustomer').value,
        amount: Number($('#baselineAmount').value)
      })
    });
    $('#baselineAmount').value = '';
    await loadDashboard();
    notifyAdmin(`Total historis disimpan: Rp${Number(result.total_spend).toLocaleString('id-ID')} · Tier ${result.tier || 'Bronze'}.`);
  } catch (error) {
    $('#baselineError').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('#rewardForm').addEventListener('submit', async event => {
  event.preventDefault();
  const error = $('#rewardFormError');
  const button = $('#rewardForm button[type="submit"]');
  const id = $('#rewardId').value;
  const type = $('#rewardType').value;
  button.disabled = true;
  error.textContent = '';
  try {
    await adminRequest(id ? `/api/admin/rewards/${id}` : '/api/admin/rewards', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify({
        type,
        name: $('#rewardName').value,
        description: $('#rewardDescription').value,
        points_cost: Number($('#rewardPointsCost').value),
        discount_amount: type === 'discount' ? Number($('#rewardDiscountAmount').value) : 0
      })
    });
    resetRewardForm();
    await loadDashboard();
    notifyAdmin('Reward berhasil disimpan.');
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    button.disabled = false;
  }
});

$('#adjustPointsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const error = $('#adjustPointsError');
  const button = $('#adjustPointsForm button[type="submit"]');
  button.disabled = true;
  error.textContent = '';
  try {
    const result = await adminRequest('/api/admin/points/adjust', {
      method: 'POST',
      body: JSON.stringify({
        member_id: $('#adjustCustomer').value,
        action: $('#adjustAction').value,
        points: Number($('#adjustPoints').value),
        reason: $('#adjustReason').value
      })
    });
    $('#adjustPoints').value = '';
    $('#adjustReason').value = '';
    await loadDashboard();
    notifyAdmin(`Saldo poin diperbarui menjadi ${Number(result.points_balance).toLocaleString('id-ID')}.`);
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    button.disabled = false;
  }
});

$('#redeemRewardForm').addEventListener('submit', async event => {
  event.preventDefault();
  const error = $('#redeemRewardError');
  const button = $('#redeemRewardForm button[type="submit"]');
  const rewardName = $('#redeemReward').selectedOptions[0]?.textContent || 'reward ini';
  if (!window.confirm(`Tukarkan poin pelanggan untuk ${rewardName}?`)) return;
  button.disabled = true;
  error.textContent = '';
  try {
    const result = await adminRequest('/api/admin/rewards/redeem', {
      method: 'POST',
      body: JSON.stringify({
        member_id: $('#redeemCustomer').value,
        reward_id: Number($('#redeemReward').value)
      })
    });
    await loadDashboard();
    notifyAdmin(`${Number(result.points_spent).toLocaleString('id-ID')} poin berhasil ditukarkan.`);
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    button.disabled = false;
  }
});

$('#rewardType').addEventListener('change', updateRewardDiscountField);
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
    $('#claimCustomer').value = '';
    $('#claimCustomerSearch').value = '';
    $('#claimCustomerSelection').textContent = '';
    $('#claimCustomerResults').replaceChildren();
    $('#claimCustomerResults').classList.add('hidden');
    $('#claimCustomerSearch').setAttribute('aria-expanded', 'false');
    claimCustomerSearchSequence += 1;
    $('#claimPromo').selectedIndex = 0;
    await loadDashboard();
  } catch (error) {
    $('#claimError').textContent = error.message;
  } finally {
    updateClaimSubmitState();
  }
});

$('#claimCustomerSearch').addEventListener('input', () => {
  clearClaimCustomerSelection();
  clearTimeout(claimCustomerSearchTimer);
  claimCustomerSearchTimer = setTimeout(searchClaimCustomers, 250);
});

$('#claimCustomerSearch').addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    $('#claimCustomerResults').classList.add('hidden');
    $('#claimCustomerSearch').setAttribute('aria-expanded', 'false');
  }
});

['#claimCustomerSearch', '#claimPromo'].forEach(selector => {
  $(selector).addEventListener('change', () => {
    updateClaimSubmitState();
  });
});

$('#customerSearch').addEventListener('input', () => {
  clearTimeout(customerSearchTimer);
  customerSearchTimer = setTimeout(loadCustomers, 250);
});

$('#cancelPromoEdit').addEventListener('click', resetPromoForm);
$('#cancelRewardEdit').addEventListener('click', resetRewardForm);
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
