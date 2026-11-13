/**
 * API Service Layer - Business Logic
 * All API calls and data transformations happen here,
 * separated from UI components
 */

const API_BASE = '/api';

// Helper function for API calls
async function apiCall(endpoint, options = {}) {
  const token = localStorage.getItem('token');
  const csrf = localStorage.getItem('csrf');

  const headers = {
    'Content-Type': 'application/json',
    ...(token && { 'Authorization': `Bearer ${token}` }),
    ...(csrf && { 'X-CSRF-Token': csrf }),
    ...options.headers,
  };

  const config = {
    ...options,
    headers,
  };

  if (options.body && typeof options.body === 'object') {
    config.body = JSON.stringify(options.body);
  }

  const response = await fetch(`${API_BASE}${endpoint}`, config);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

// ============ Authentication API ============

export async function register(userData) {
  const data = await apiCall('/register', {
    method: 'POST',
    body: userData,
  });

  // Store tokens if provided
  if (data.token) {
    localStorage.setItem('token', data.token);
    localStorage.setItem('csrf', data.csrf);
  }

  return data;
}

export async function login(email, password) {
  const data = await apiCall('/login', {
    method: 'POST',
    body: { email, password },
  });

  // Store tokens
  localStorage.setItem('token', data.token);
  localStorage.setItem('csrf', data.csrf);

  return data.user;
}

export async function logout() {
  try {
    await apiCall('/logout', { method: 'POST' });
  } finally {
    localStorage.removeItem('token');
    localStorage.removeItem('csrf');
  }
}

export async function verifyEmail(email, code) {
  return await apiCall('/verify-email', {
    method: 'POST',
    body: { email, code },
  });
}

export async function resendVerificationCode(email) {
  return await apiCall('/resend-verification', {
    method: 'POST',
    body: { email },
  });
}

// ============ User/State API ============

export async function fetchState() {
  return await apiCall('/state');
}

export async function updateProfile(profileData) {
  return await apiCall('/profile', {
    method: 'PATCH',
    body: profileData,
  });
}

// ============ Shipment API ============

export async function createShipment(shipmentData) {
  return await apiCall('/shipments', {
    method: 'POST',
    body: shipmentData,
  });
}

export async function updateShipment(shipmentId, action, data) {
  return await apiCall(`/shipments/${shipmentId}/${action}`, {
    method: 'POST',
    body: data,
  });
}

export async function getShipment(shipmentId) {
  return await apiCall(`/shipments/${shipmentId}`);
}

// ============ Driver-specific API ============

export async function updateTruck(truckData) {
  return await apiCall('/driver/truck', {
    method: 'PATCH',
    body: truckData,
  });
}

// ============ Admin-specific API ============

export async function approveDriver(driverId) {
  return await apiCall(`/admin/drivers/${driverId}/approve`, {
    method: 'POST',
  });
}

export async function getAllUsers() {
  return await apiCall('/admin/users');
}

// Export a default object for easier imports
export default {
  register,
  login,
  logout,
  verifyEmail,
  resendVerificationCode,
  fetchState,
  updateProfile,
  createShipment,
  updateShipment,
  getShipment,
  updateTruck,
  approveDriver,
  getAllUsers,
};
