async function customerRequest(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return readCustomerResponse(response);
}

async function readCustomerResponse(response) {
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || 'Pendaftaran gagal. Silakan coba lagi.');
  }

  return result;
}

async function createCustomer(name, email, phone, password, consent) {
  const result = await customerRequest('/api/customers', { name, email, phone, password, consent });
  saveUser(result);
  return result;
}

async function loginCustomer(email, password) {
  const response = await fetch('/api/customer/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const result = await readCustomerResponse(response);
  saveUser(result);
  return result;
}

async function requestPasswordReset(email) {
  const response = await fetch('/api/customer/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
  return readCustomerResponse(response);
}

async function resetCustomerPassword(token, password) {
  const response = await fetch('/api/customer/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password })
  });
  return readCustomerResponse(response);
}

async function getCustomerSession() {
  const response = await fetch('/api/customer/session', { credentials: 'same-origin' });
  return readCustomerResponse(response);
}

async function getCustomerLoyalty() {
  const response = await fetch('/api/customer/loyalty', { credentials: 'same-origin' });
  return readCustomerResponse(response);
}

async function logoutCustomer() {
  const response = await fetch('/api/customer/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    credentials: 'same-origin'
  });
  return readCustomerResponse(response);
}
