/**
 * DialForge Dashboard API Integration Layer
 * 
 * This file provides Dashboard-specific API functionality.
 * It uses the universal API infrastructure from dialforgeApi.js and adds
 * Dashboard-specific logic such as:
 * - Fetching Dashboard-specific data
 * - Dashboard-specific error handling
 * - Dashboard-specific data transformations
 * - Dashboard-specific localStorage keys
 * 
 * Dependencies:
 * - dialforgeApi.js (universal API infrastructure)
 * 
 * Responsibilities:
 * - Wrap universal API calls for Dashboard use cases
 * - Dashboard-specific data transformations
 * - Dashboard-specific fallback handling
 * - Dashboard-specific caching strategy
 * 
 * NOT Responsible for:
 * - DOM manipulation or UI updates (Dashboard.html handles this)
 * - General API infrastructure (dialforgeApi.js handles this)
 * - Data transformation for other DialForge pages
 */

// ============================================================================
// CACHE KEY DEFINITIONS
// ============================================================================

const DASHBOARD_CACHE_KEYS = {
  CONTACTS: 'df_contacts',
  TICKETS: 'df_tickets',
  STATUS: 'df_api_status'
};

// ============================================================================
// API STATUS
// ============================================================================

/**
 * Fetch API/system status
 * 
 * Endpoint: GET /api/status
 * 
 * Purpose: Determine whether the backend API is available and functioning.
 * Used by the Dashboard to display system health indicator.
 * 
 * Returns:
 * - { status: 'available' } if backend is up
 * - { status: 'unavailable' } if backend is down (fallback value)
 * 
 * @returns {Promise<Object>} - Status object with 'status' property
 */
async function fetchDashboardStatus() {
  const response = await dialforgeApi.fetch('/api/status', {
    fallbackKey: DASHBOARD_CACHE_KEYS.STATUS,
    fallbackValue: { status: 'unavailable' }
  });

  return response || { status: 'unavailable' };
}

// ============================================================================
// HUBSPOT CONTACTS
// ============================================================================

/**
 * Fetch HubSpot contacts from backend
 * 
 * Endpoint: GET /api/hubspot/contacts
 * 
 * Purpose: Retrieve contact information from HubSpot integration.
 * Used by Dashboard to display:
 * - Total contact count
 * - Recent contacts
 * - Contact-related metrics
 * 
 * Response Format (handled generically by dialforgeApi):
 * - { "contacts": [...] } or
 * - { "results": [...] }
 * 
 * @returns {Promise<Array>} - Array of contact objects
 */
async function fetchDashboardContacts() {
  // Fetch from backend with fallback to localStorage
  const response = await dialforgeApi.fetch('/api/hubspot/contacts', {
    fallbackKey: DASHBOARD_CACHE_KEYS.CONTACTS,
    fallbackValue: []
  });

  // Extract array from response (handles multiple response formats)
  const contacts = dialforgeApi.extractArray(response, 'contacts', 'results');

  // Cache the contacts for offline use
  if (Array.isArray(contacts) && contacts.length > 0) {
    dialforgeApi.cacheData(DASHBOARD_CACHE_KEYS.CONTACTS, contacts);
  }

  return contacts;
}

// ============================================================================
// ZENDESK TICKETS
// ============================================================================

/**
 * Fetch Zendesk support tickets from backend
 * 
 * Endpoint: GET /api/zendesk/tickets
 * 
 * Purpose: Retrieve support ticket information from Zendesk integration.
 * Used by Dashboard to display:
 * - Open ticket count
 * - Total ticket count
 * - Recent tickets
 * - Ticket-related metrics
 * 
 * Response Format (handled generically by dialforgeApi):
 * - { "tickets": [...] } or
 * - { "results": [...] }
 * 
 * @returns {Promise<Array>} - Array of ticket objects
 */
async function fetchDashboardTickets() {
  // Fetch from backend with fallback to localStorage
  const response = await dialforgeApi.fetch('/api/zendesk/tickets', {
    fallbackKey: DASHBOARD_CACHE_KEYS.TICKETS,
    fallbackValue: []
  });

  // Extract array from response (handles multiple response formats)
  const tickets = dialforgeApi.extractArray(response, 'tickets', 'results');

  // Cache the tickets for offline use
  if (Array.isArray(tickets) && tickets.length > 0) {
    dialforgeApi.cacheData(DASHBOARD_CACHE_KEYS.TICKETS, tickets);
  }

  return tickets;
}

// ============================================================================
// DASHBOARD DATA TRANSFORMATIONS
// ============================================================================

/**
 * Count open tickets from ticket array
 * 
 * Counts tickets with open/new/pending status (case-insensitive).
 * Used internally by Dashboard to determine open ticket count.
 * 
 * @param {Array} tickets - Array of ticket objects
 * @returns {number} - Count of open tickets
 */
function countOpenTickets(tickets) {
  if (!Array.isArray(tickets)) return 0;

  return tickets.filter(ticket => {
    const status = (ticket.status || '').toLowerCase();
    return status === 'open' || status === 'new' || status === 'pending';
  }).length;
}

/**
 * Transform tickets data for Dashboard display
 * 
 * Adds computed properties to ticket data for Dashboard metrics.
 * 
 * @param {Array} tickets - Array of ticket objects
 * @returns {Object} - Transformed data with counts and metadata
 */
function transformTicketsForDashboard(tickets) {
  if (!Array.isArray(tickets)) {
    return {
      all: 0,
      open: 0,
      tickets: []
    };
  }

  return {
    all: tickets.length,
    open: countOpenTickets(tickets),
    tickets: tickets
  };
}

/**
 * Transform contacts data for Dashboard display
 * 
 * Adds computed properties to contact data for Dashboard metrics.
 * 
 * @param {Array} contacts - Array of contact objects
 * @returns {Object} - Transformed data with counts and metadata
 */
function transformContactsForDashboard(contacts) {
  if (!Array.isArray(contacts)) {
    return {
      total: 0,
      contacts: []
    };
  }

  return {
    total: contacts.length,
    contacts: contacts
  };
}

// ============================================================================
// ORCHESTRATION: LOAD ALL DASHBOARD DATA
// ============================================================================

/**
 * Load all Dashboard API data
 * 
 * Fetches API status, contacts, and tickets in parallel.
 * Handles errors gracefully with fallback to localStorage.
 * 
 * Returns an object with three properties:
 * - status: System/API status
 * - contacts: Contact data with transformations
 * - tickets: Ticket data with transformations
 * 
 * This function orchestrates the API calls but does NOT update the DOM.
 * DOM updates should be handled by Dashboard.html.
 * 
 * Usage:
 *   const dashboardData = await dashboardAPI.loadDashboardData();
 *   updateDashboardUI(dashboardData);
 * 
 * @returns {Promise<Object>} - Dashboard data object
 */
async function loadDashboardData() {
  try {
    // Fetch all data in parallel
    const [statusResponse, contactsArray, ticketsArray] = await Promise.all([
      fetchDashboardStatus(),
      fetchDashboardContacts(),
      fetchDashboardTickets()
    ]);

    // Determine API availability
    const isApiAvailable = statusResponse && 
      (statusResponse.status === 'available' || statusResponse.status === 'ok');

    // Transform data for Dashboard display
    const contactsData = transformContactsForDashboard(contactsArray);
    const ticketsData = transformTicketsForDashboard(ticketsArray);

    // Return structured data for Dashboard UI
    return {
      isApiAvailable,
      status: statusResponse,
      contacts: contactsData,
      tickets: ticketsData,
      timestamp: new Date()
    };
  } catch (error) {
    // Log error but don't throw - Dashboard should still render
    console.error('[Dashboard API] Error loading dashboard data:', error);

    // Return fallback data structure
    return {
      isApiAvailable: false,
      status: { status: 'unavailable' },
      contacts: { total: 0, contacts: [] },
      tickets: { all: 0, open: 0, tickets: [] },
      timestamp: new Date(),
      error: error.message
    };
  }
}

// ============================================================================
// EXPORTS / GLOBAL NAMESPACE
// ============================================================================

/**
 * Expose Dashboard API utilities globally
 * 
 * Usage:
 *   dashboardAPI.loadDashboardData()
 *   dashboardAPI.fetchStatus()
 *   dashboardAPI.fetchContacts()
 *   dashboardAPI.fetchTickets()
 */
const dashboardAPI = {
  // Main orchestration
  loadDashboardData,

  // Individual endpoint functions
  fetchStatus: fetchDashboardStatus,
  fetchContacts: fetchDashboardContacts,
  fetchTickets: fetchDashboardTickets,

  // Data transformations
  transformContactsForDashboard,
  transformTicketsForDashboard,
  countOpenTickets,

  // Cache key references (for Dashboard UI to use if needed)
  cacheKeys: DASHBOARD_CACHE_KEYS
};

// Make globally accessible
if (typeof window !== 'undefined') {
  window.dashboardAPI = dashboardAPI;
}
