/**
 * DialForge Power Dialer API Integration Layer
 * 
 * This file provides Power Dialer-specific API functionality.
 * It uses the universal API infrastructure from dialforgeApi.js and adds
 * Power Dialer-specific logic such as:
 * - HubSpot contact search during call connection
 * - Contact data enrichment for the Active Call workflow
 * 
 * Dependencies:
 * - dialforgeApi.js (universal API infrastructure)
 * 
 * Responsibilities:
 * - Wrap universal API calls for Power Dialer use cases
 * - Search for HubSpot contact information during call connection
 * - Prepare contact data for Active Call transition
 * - Handle fallback when HubSpot is unavailable
 * 
 * NOT Responsible for:
 * - DOM manipulation or UI updates (Power Dialer.html handles this)
 * - General API infrastructure (dialforgeApi.js handles this)
 * - Active Call implementation
 */

// ============================================================================
// CACHE KEY DEFINITIONS
// ============================================================================

const POWER_DIALER_CACHE_KEYS = {
  HUBSPOT_CONTACT: 'pd_hubspot_contact',
  SEARCH_HISTORY: 'pd_search_history'
};

// ============================================================================
// HUBSPOT CONTACT SEARCH
// ============================================================================

/**
 * Search for a contact in HubSpot by phone number or email
 * 
 * Endpoint: POST /api/hubspot/contacts/search
 * 
 * Purpose: When a prospect is connected to in Power Dialer, search HubSpot
 * for matching contact information to enrich the Active Call workflow.
 * 
 * Search Priority:
 * 1. Phone number (primary)
 * 2. Email address (secondary)
 * 
 * Returns: Contact object from HubSpot or null if not found
 * 
 * @param {Object} prospect - Prospect from Power Dialer queue
 * @param {string} prospect.name - Prospect name
 * @param {string} prospect.phone - Phone number (preferred search field)
 * @param {string} prospect.email - Email address (fallback search field)
 * @param {string} prospect.company - Company name
 * @returns {Promise<Object|null>} - HubSpot contact object or null
 */
async function searchHubSpotContact(prospect) {
  if (!prospect) {
    console.warn('[Power Dialer API] No prospect provided for HubSpot search');
    return null;
  }

  // Determine search field: prefer phone, fallback to email
  const phone = prospect.phone || '';
  const email = prospect.email || '';

  if (!phone && !email) {
    console.warn('[Power Dialer API] Prospect has no phone or email for HubSpot search');
    return null;
  }

  try {
    // Build search request body with available fields
    const searchBody = {};
    if (phone) searchBody.phone = phone;
    if (email) searchBody.email = email;

    // Make the API request
    const response = await dialforgeApi.fetch('/api/hubspot/contacts/search', {
      method: 'POST',
      body: searchBody,
      fallbackValue: null
    });

    // Extract contact from response (handle multiple possible formats)
    if (response) {
      // Response might be { contact: {...} } or { result: {...} } or {...}
      const contact = response.contact || response.result || response;
      
      if (contact && typeof contact === 'object' && contact.id) {
        // Valid contact found
        console.log('[Power Dialer API] HubSpot contact found:', contact);
        return contact;
      }
    }

    // No contact found or invalid response
    console.warn('[Power Dialer API] No HubSpot contact found for:', { phone, email });
    return null;
  } catch (error) {
    console.error('[Power Dialer API] Error searching HubSpot:', error);
    return null;
  }
}

// ============================================================================
// CONTACT DATA ENRICHMENT
// ============================================================================

/**
 * Enrich prospect data with HubSpot contact information
 * 
 * Merges Power Dialer prospect data with HubSpot contact details.
 * If HubSpot search fails or returns no contact, returns enriched data
 * with original prospect information intact.
 * 
 * @param {Object} prospect - Prospect from Power Dialer queue
 * @param {Object|null} hubspotContact - Contact from HubSpot search (may be null)
 * @returns {Object} - Enriched contact data for Active Call
 */
function enrichContactData(prospect, hubspotContact) {
  if (!prospect) {
    return null;
  }

  // Start with Power Dialer prospect as base
  const enrichedContact = {
    // Core identification
    name: prospect.name || '',
    number: prospect.phone || '',
    email: prospect.email || '',
    
    // Organization info
    company: prospect.company || '',
    jobTitle: prospect.title || '',
    
    // Call-related fields
    location: prospect.company || '',
    avatar: prospect.avatar || '',
    dealValue: prospect.dealValue || '',
    pipelineStage: prospect.pipelineStage || '',
    
    // Track if this came from HubSpot enrichment
    isEnriched: false,
    sourceProspectId: prospect.id || null
  };

  // If HubSpot contact found, merge/override with HubSpot data
  if (hubspotContact) {
    enrichedContact.isEnriched = true;
    
    // Merge HubSpot fields (these override prospect fields)
    if (hubspotContact.name) enrichedContact.name = hubspotContact.name;
    if (hubspotContact.phone) enrichedContact.number = hubspotContact.phone;
    if (hubspotContact.email) enrichedContact.email = hubspotContact.email;
    if (hubspotContact.company) enrichedContact.company = hubspotContact.company;
    if (hubspotContact.jobTitle) enrichedContact.jobTitle = hubspotContact.jobTitle;
    if (hubspotContact.title) enrichedContact.jobTitle = hubspotContact.title;
    
    // Store HubSpot ID for future operations
    if (hubspotContact.id) enrichedContact.hubspotId = hubspotContact.id;
    
    // Store full HubSpot contact for reference
    if (hubspotContact) enrichedContact.hubspotContact = hubspotContact;
  }

  return enrichedContact;
}

// ============================================================================
// CALL CONNECTED WORKFLOW
// ============================================================================

/**
 * Execute the complete workflow when a prospect is marked as connected
 * 
 * This is the main integration point that orchestrates:
 * 1. Searching HubSpot for contact information
 * 2. Enriching the prospect with HubSpot data
 * 3. Preparing the contact for Active Call transition
 * 
 * The workflow is non-blocking: if HubSpot search fails, the call
 * continues with the original prospect data.
 * 
 * @param {Object} prospect - Prospect from Power Dialer queue
 * @returns {Promise<Object>} - Enriched contact data ready for Active Call
 */
async function onProspectConnected(prospect) {
  if (!prospect) {
    console.error('[Power Dialer API] No prospect data provided');
    return null;
  }

  try {
    // Search HubSpot for contact information
    const hubspotContact = await searchHubSpotContact(prospect);
    
    // Enrich prospect data with HubSpot information
    const enrichedContact = enrichContactData(prospect, hubspotContact);
    
    // Log enrichment result
    if (hubspotContact) {
      console.log('[Power Dialer API] Prospect enriched with HubSpot data');
    } else {
      console.log('[Power Dialer API] Prospect using local data (HubSpot not available)');
    }
    
    return enrichedContact;
  } catch (error) {
    console.error('[Power Dialer API] Error in onProspectConnected:', error);
    // Fall back to basic prospect data
    return enrichContactData(prospect, null);
  }
}

// ============================================================================
// EXPORTS / GLOBAL NAMESPACE
// ============================================================================

/**
 * Expose Power Dialer API utilities globally
 * 
 * Usage:
 *   const enrichedContact = await powerDialerAPI.onProspectConnected(prospect);
 *   const contact = await powerDialerAPI.searchHubSpotContact(prospect);
 */
const powerDialerAPI = {
  // Main workflow
  onProspectConnected,
  
  // Individual functions
  searchHubSpotContact,
  enrichContactData,
  
  // Cache key references
  cacheKeys: POWER_DIALER_CACHE_KEYS
};

// Make globally accessible
if (typeof window !== 'undefined') {
  window.powerDialerAPI = powerDialerAPI;
}
