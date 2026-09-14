/**
 * DialForge current-user adapter.
 *
 * This is the product UI boundary for login/session/profile data. Today it
 * talks to the local product API; the server side can later swap its data
 * source to Supabase Auth + profile tables without changing page code.
 */

const DIALFORGE_AUTH_TOKEN_KEY = 'dialforgeAuthToken';
const DIALFORGE_CURRENT_USER_KEY = 'dialforgeCurrentUser';
const DIALFORGE_STATE_KEY = 'dialforgeState';

function normalizeCurrentUserPayload(payload) {
  const user = payload?.user || {};
  const organization = payload?.organization || user.organization || {};
  const displayName = user.display_name || user.displayName || user.full_name || user.name || '';
  const avatarUrl = user.avatar_url || user.avatarUrl || user.avatar || '';
  const orgName = organization.name || user.company || '';

  return {
    user: {
      id: user.id || '',
      email: user.email || '',
      displayName,
      name: displayName,
      fullName: user.full_name || user.fullName || displayName,
      role: user.role || '',
      avatarUrl,
      avatar: avatarUrl,
      company: orgName,
      tier: organization.plan || user.tier || 'starter'
    },
    organization: {
      id: organization.id || '',
      name: orgName,
      slug: organization.slug || '',
      plan: organization.plan || 'starter'
    }
  };
}

function persistCurrentUser(payload) {
  const normalized = normalizeCurrentUserPayload(payload);
  dialforgeApi.cacheData(DIALFORGE_CURRENT_USER_KEY, normalized);

  const existing = dialforgeApi.getCachedData(DIALFORGE_STATE_KEY) || {};
  dialforgeApi.cacheData(DIALFORGE_STATE_KEY, {
    ...existing,
    user: {
      ...(existing.user || {}),
      ...normalized.user
    },
    organization: {
      ...(existing.organization || {}),
      ...normalized.organization
    }
  });

  if (normalized.user.avatarUrl) {
    localStorage.setItem('dialforge-profile-picture', normalized.user.avatarUrl);
  } else {
    localStorage.removeItem('dialforge-profile-picture');
  }

  return normalized;
}

function getCachedCurrentUser() {
  const cached = dialforgeApi.getCachedData(DIALFORGE_CURRENT_USER_KEY);
  if (cached?.user) return normalizeCurrentUserPayload(cached);

  const legacyState = dialforgeApi.getCachedData(DIALFORGE_STATE_KEY);
  if (legacyState?.user) {
    return normalizeCurrentUserPayload({
      user: legacyState.user,
      organization: legacyState.organization || { name: legacyState.user.company }
    });
  }

  return null;
}

function initialsForName(name) {
  return String(name || 'DF')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || 'DF';
}

function avatarPlaceholderForUser(name) {
  const initials = initialsForName(name);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
      <rect width="160" height="160" rx="32" fill="#1A1B23"/>
      <circle cx="118" cy="36" r="46" fill="#FF7A1C" opacity="0.22"/>
      <circle cx="38" cy="128" r="56" fill="#9B6DFF" opacity="0.18"/>
      <text x="80" y="92" text-anchor="middle" font-family="Arial, sans-serif" font-size="48" font-weight="700" fill="#FFFFFF">${initials}</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

async function login(email, password) {
  const response = await dialforgeApi.fetch('/api/auth/login', {
    method: 'POST',
    body: { email, password },
    fallbackValue: null
  });

  if (!response?.token || !response?.user) {
    throw new Error(response?.error || 'Login failed');
  }

  localStorage.setItem(DIALFORGE_AUTH_TOKEN_KEY, response.token);
  return persistCurrentUser(response);
}

async function getCurrentUser(options = {}) {
  const { allowCached = true } = options;
  const response = await dialforgeApi.fetch('/api/me', {
    method: 'GET',
    fallbackValue: null
  });

  if (response?.user) {
    return persistCurrentUser(response);
  }

  if (allowCached) {
    return getCachedCurrentUser();
  }

  return null;
}

async function logout() {
  await dialforgeApi.fetch('/api/auth/logout', {
    method: 'POST',
    fallbackValue: { ok: true }
  });
  dialforgeApi.clearCache(DIALFORGE_CURRENT_USER_KEY);
  localStorage.removeItem(DIALFORGE_AUTH_TOKEN_KEY);
}

function applyCurrentUserToPage(current) {
  if (!current?.user) return;

  const { user, organization } = current;
  const name = user.displayName || user.name || user.email || 'DialForge User';
  const role = user.role || 'Team Member';
  const email = user.email || '';
  const company = organization?.name || user.company || 'DialForge';
  const tier = (organization?.plan || user.tier || 'starter').toUpperCase();
  const avatarUrl = user.avatarUrl || user.avatar || '';
  const displayAvatarUrl = avatarUrl || avatarPlaceholderForUser(name);

  const profileName = document.getElementById('profileName');
  if (profileName) profileName.textContent = name;

  const profileRole = document.getElementById('profileRole');
  if (profileRole) profileRole.textContent = `${role} - ${company}`;

  const profileEmail = document.getElementById('profileEmail');
  if (profileEmail) profileEmail.textContent = email;

  const profileTierBadge = document.getElementById('profileTierBadge');
  if (profileTierBadge) profileTierBadge.textContent = `${tier} TIER MEMBER`;

  const dashboardCompanyName = document.getElementById('dashboardCompanyName');
  if (dashboardCompanyName) dashboardCompanyName.textContent = company;

  const editProfileDisplayName = document.getElementById('editProfileDisplayName');
  if (editProfileDisplayName) editProfileDisplayName.value = name;

  const editProfileJobTitle = document.getElementById('editProfileJobTitle');
  if (editProfileJobTitle) editProfileJobTitle.value = role;

  const editProfileDepartment = document.getElementById('editProfileDepartment');
  if (editProfileDepartment) editProfileDepartment.value = company;

  [
    document.getElementById('profileAvatarImage'),
    document.getElementById('dashboardUserAvatar'),
    document.getElementById('activeCallUserAvatar')
  ].forEach((img) => {
    if (img) {
      img.src = displayAvatarUrl;
      img.alt = `${name} profile avatar`;
    }
  });
}

async function hydrateCurrentUserOnPage() {
  const current = await getCurrentUser({ allowCached: true });
  if (current) {
    applyCurrentUserToPage(current);
  }
  return current;
}

const currentUserAPI = {
  login,
  logout,
  getCurrentUser,
  getCachedCurrentUser,
  persistCurrentUser,
  applyCurrentUserToPage,
  hydrateCurrentUserOnPage,
  AUTH_TOKEN_KEY: DIALFORGE_AUTH_TOKEN_KEY,
  CURRENT_USER_KEY: DIALFORGE_CURRENT_USER_KEY
};

if (typeof window !== 'undefined') {
  window.currentUserAPI = currentUserAPI;
}
