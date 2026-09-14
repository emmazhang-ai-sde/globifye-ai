/**
 * DialForge Universal API Infrastructure Layer
 * 
 * This file provides reusable API functionality for all DialForge pages.
 * It serves as a central hub for backend communication and should be used
 * by feature-specific modules (e.g., dashboardAPI.js, contactsAPI.js, etc.)
 * 
 * Responsibilities:
 * - Centralized API base URL configuration
 * - Universal fetch() wrapper with consistent error handling
 * - Network failure and backend unavailability handling
 * - HTTP error handling (400, 401, 403, 404, 500, etc.)
 * - Response parsing and validation
 * - Generic data normalization/transformation
 * - Reusable fallback mechanism using localStorage
 * 
 * NOT Responsible for:
 * - Dashboard-specific UI updates
 * - Dashboard-specific data transformations
 * - Dashboard-specific localStorage keys (unless architectural)
 * - Feature-specific presentation logic
 */

// ============================================================================
// API CONFIGURATION
// ============================================================================

/**
 * Centralized API base URL
 * 
 * If the project has an existing API configuration elsewhere, this constant
 * should be updated to reference it instead of hardcoding the URL.
 * 
 * To change the API endpoint, update this single location.
 */
const DIALFORGE_API_BASE_URL = 'http://localhost:8000';
const DIALFORGE_API_AUTH_TOKEN_KEY = 'dialforgeAuthToken';

// ============================================================================
// UNIVERSAL FETCH WRAPPER
// ============================================================================

/**
 * Universal fetch wrapper for all DialForge API requests
 * 
 * This wrapper handles:
 * - Building full API URLs
 * - Making the fetch request
 * - Checking for HTTP errors
 * - Parsing JSON responses
 * - Network/backend failure handling
 * - Fallback to localStorage when backend unavailable
 * 
 * @param {string} endpoint - API endpoint path (e.g., '/api/status', '/api/hubspot/contacts')
 * @param {Object} options - Configuration options
 * @param {string} options.method - HTTP method (default: 'GET')
 * @param {Object} options.body - Request body (for POST/PUT/etc)
 * @param {Object} options.headers - Additional headers
 * @param {string} options.fallbackKey - localStorage key to use if backend unavailable
 * @param {*} options.fallbackValue - Fallback value if no cache exists
 * 
 * @returns {Promise<Object>} - Parsed response data or fallback data
 * @throws {Error} - If request fails and no fallback available
 * 
 * Usage:
 *   const data = await dialforgeApiFetch('/api/hubspot/contacts', {
 *     fallbackKey: 'df_contacts'
 *   });
 */
async function dialforgeApiFetch(endpoint, options = {}) {
  const {
    method = 'GET',
    body = null,
    headers = {},
    fallbackKey = null,
    fallbackValue = []
  } = options;

  // Build full API URL
  const url = `${DIALFORGE_API_BASE_URL}${endpoint}`;
  const authToken = getDialforgeAuthToken();
  const requestHeaders = {
    'Content-Type': 'application/json',
    ...(authToken && { Authorization: `Bearer ${authToken}` }),
    ...headers
  };

  try {
    // Make the fetch request
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      ...(body && { body: JSON.stringify(body) })
    });

    // Handle HTTP errors
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Parse and return response
    const data = await response.json();
    return data;
  } catch (error) {
    // Log the error
    console.warn(
      `[DialForge API] Request failed: ${endpoint}`,
      error.message
    );

    // Attempt to use fallback data from localStorage
    if (fallbackKey) {
      try {
        const cachedData = localStorage.getItem(fallbackKey);
        if (cachedData) {
          console.warn(
            `[DialForge API] Using cached data for: ${endpoint}`
          );
          return JSON.parse(cachedData);
        }
      } catch (storageError) {
        console.error(`[DialForge API] Error reading fallback cache:`, storageError);
      }
    }

    // Return fallback value if no cache available
    console.warn(
      `[DialForge API] No fallback cache available for: ${endpoint}, using default`
    );
    return fallbackValue;
  }
}

function getDialforgeAuthToken() {
  try {
    return localStorage.getItem(DIALFORGE_API_AUTH_TOKEN_KEY);
  } catch (error) {
    console.warn('[DialForge API] Could not read auth token:', error.message);
    return null;
  }
}

// ============================================================================
// GENERIC RESPONSE PARSING
// ============================================================================

/**
 * Safely extract array data from various response formats
 * 
 * Handles responses like:
 * - { "contacts": [...] }
 * - { "results": [...] }
 * - [...]
 * 
 * @param {Object} response - API response object
 * @param {string} primaryKey - Primary key to look for (e.g., 'contacts')
 * @param {string} fallbackKey - Fallback key if primary not found (e.g., 'results')
 * @returns {Array} - Extracted array or empty array if not found
 */
function dialforgeExtractArray(response, primaryKey, fallbackKey = 'results') {
  if (!response) return [];
  if (Array.isArray(response)) return response;
  if (response[primaryKey] && Array.isArray(response[primaryKey])) {
    return response[primaryKey];
  }
  if (fallbackKey && response[fallbackKey] && Array.isArray(response[fallbackKey])) {
    return response[fallbackKey];
  }
  return [];
}

// ============================================================================
// GENERIC DATA NORMALIZATION
// ============================================================================

/**
 * Convert API response field names to camelCase
 * 
 * Transforms:
 * { "first_name": "John", "last_name": "Smith" }
 * Into:
 * { "firstName": "John", "lastName": "Smith" }
 * 
 * @param {string} snakeCase - Snake case string (e.g., 'first_name')
 * @returns {string} - Camel case string (e.g., 'firstName')
 */
function dialforgeSnakeToCamel(snakeCase) {
  return snakeCase.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
}

/**
 * Normalize API response object by converting field names
 * 
 * @param {Object} obj - Object to normalize
 * @param {Array<string>} fields - Fields to convert from snake_case to camelCase
 * @returns {Object} - Normalized object
 */
function dialforgeNormalizeObject(obj, fields = []) {
  if (!obj || typeof obj !== 'object') return obj;

  const normalized = { ...obj };
  
  fields.forEach(snakeField => {
    if (snakeField in normalized) {
      const camelField = dialforgeSnakeToCamel(snakeField);
      normalized[camelField] = normalized[snakeField];
      delete normalized[snakeField];
    }
  });

  return normalized;
}

/**
 * Normalize array of objects by converting field names
 * 
 * @param {Array<Object>} arr - Array of objects to normalize
 * @param {Array<string>} fields - Fields to convert from snake_case to camelCase
 * @returns {Array<Object>} - Array of normalized objects
 */
function dialforgeNormalizeArray(arr, fields = []) {
  if (!Array.isArray(arr)) return [];
  return arr.map(item => dialforgeNormalizeObject(item, fields));
}

// ============================================================================
// CACHE MANAGEMENT
// ============================================================================

/**
 * Cache data to localStorage
 * 
 * @param {string} key - localStorage key
 * @param {*} data - Data to cache
 * @returns {boolean} - True if successful, false if error
 */
function dialforgeCacheData(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
    return true;
  } catch (error) {
    console.error(`[DialForge API] Error caching data for key "${key}":`, error);
    return false;
  }
}

/**
 * Retrieve cached data from localStorage
 * 
 * @param {string} key - localStorage key
 * @returns {*} - Cached data or null if not found or error
 */
function dialforgeGetCachedData(key) {
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error(`[DialForge API] Error retrieving cached data for key "${key}":`, error);
    return null;
  }
}

/**
 * Clear cached data from localStorage
 * 
 * @param {string} key - localStorage key
 * @returns {boolean} - True if successful, false if error
 */
function dialforgeClearCache(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch (error) {
    console.error(`[DialForge API] Error clearing cache for key "${key}":`, error);
    return false;
  }
}

// ============================================================================
// EXPORTS / GLOBAL NAMESPACE
// ============================================================================

/**
 * Expose API utilities globally for use by other DialForge modules
 * 
 * Usage:
 *   dialforgeApi.fetch('/api/status')
 *   dialforgeApi.extractArray(response, 'contacts')
 *   dialforgeApi.normalizeObject(obj, ['first_name', 'last_name'])
 *   dialforgeApi.cacheData('my_key', data)
 *   dialforgeApi.getCachedData('my_key')
 *   dialforgeApi.clearCache('my_key')
 */
const dialforgeApi = {
  // Configuration
  BASE_URL: DIALFORGE_API_BASE_URL,
  AUTH_TOKEN_KEY: DIALFORGE_API_AUTH_TOKEN_KEY,

  // Universal fetch wrapper
  fetch: dialforgeApiFetch,
  getAuthToken: getDialforgeAuthToken,

  // Response parsing
  extractArray: dialforgeExtractArray,

  // Data normalization
  snakeToCamel: dialforgeSnakeToCamel,
  normalizeObject: dialforgeNormalizeObject,
  normalizeArray: dialforgeNormalizeArray,

  // Cache management
  cacheData: dialforgeCacheData,
  getCachedData: dialforgeGetCachedData,
  clearCache: dialforgeClearCache
};

// Make globally accessible
if (typeof window !== 'undefined') {
  window.dialforgeApi = dialforgeApi;
}
