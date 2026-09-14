/**
 * DialForge Active Call API Integration Layer
 * 
 * This file provides Active Call-specific API functionality.
 * It uses the universal API infrastructure from dialforgeApi.js and adds
 * Active Call-specific logic such as:
 * - HubSpot contact search when call connects
 * - Contact enrichment for CRM panel display
 * - Saving/syncing contact and CRM notes to HubSpot
 * - Support ticket creation (future integration point)
 * 
 * Dependencies:
 * - dialforgeApi.js (universal API infrastructure)
 * 
 * Responsibilities:
 * - Wrap universal API calls for Active Call use cases
 * - Search for HubSpot contact information when call connects
 * - Prepare contact data for CRM panel display
 * - Handle contact save/update operations
 * - Handle CRM notes synchronization
 * - Support ticket creation
 * 
 * NOT Responsible for:
 * - DOM manipulation or UI updates (Active Call HTML handles this)
 * - General API infrastructure (dialforgeApi.js handles this)
 * - Transcript or call recording logic
 */

// ============================================================================
// CACHE KEY DEFINITIONS
// ============================================================================

const ACTIVE_CALL_CACHE_KEYS = {
  HUBSPOT_CONTACT: 'ac_hubspot_contact',
  CURRENT_CONTACT: 'ac_current_contact'
};

const SIP_DEMO_API_PREFIX = '/sip-demo';

async function fetchSipDemo(endpoint, options = {}) {
  return dialforgeApi.fetch(`${SIP_DEMO_API_PREFIX}${endpoint}`, {
    fallbackValue: options.fallbackValue ?? null,
    ...options
  });
}

// ============================================================================
// SIP HANDOFF / CALL ROOM INTEGRATION
// ============================================================================

async function getSipCallRoom() {
  return fetchSipDemo('/api/call-room', {
    fallbackValue: { active: false, room: null }
  });
}

async function acceptSipHandoff() {
  return fetchSipDemo('/api/handoff/accept', {
    method: 'POST',
    fallbackValue: null
  });
}

async function resumeSipAI(handbackNote = '') {
  return fetchSipDemo('/api/handoff/resume-ai', {
    method: 'POST',
    body: { handback_note: handbackNote },
    fallbackValue: null
  });
}

async function reportSipHandoffFailure(status, reason = '') {
  return fetchSipDemo('/api/handoff/failure', {
    method: 'POST',
    body: { status, reason },
    fallbackValue: null
  });
}

async function hangupSipCall() {
  return fetchSipDemo('/api/hangup', {
    method: 'POST',
    fallbackValue: null
  });
}

// ============================================================================
// HUBSPOT CONTACT SEARCH
// ============================================================================

/**
 * Search for a contact in HubSpot using call participant information
 * 
 * Endpoint: POST /api/hubspot/contacts/search
 * 
 * Purpose: When a call connects, automatically search HubSpot for the caller
 * to enrich the CRM panel with contact information.
 * 
 * Search Priority:
 * 1. Phone number (primary)
 * 2. Email address (secondary)
 * 
 * Returns: Contact object from HubSpot or null if not found
 * 
 * @param {Object} contact - Contact from Active Call
 * @param {string} contact.name - Contact name
 * @param {string} contact.number - Phone number (preferred search field)
 * @param {string} contact.email - Email address (fallback search field)
 * @param {string} contact.company - Company name
 * @returns {Promise<Object|null>} - HubSpot contact object or null
 */
async function searchHubSpotContactForCall(contact) {
  if (!contact) {
    console.warn('[Active Call API] No contact provided for HubSpot search');
    return null;
  }

  // Determine search fields: prefer phone, fallback to email
  const phone = contact.number || '';
  const email = contact.email || '';

  if (!phone && !email) {
    console.warn('[Active Call API] Contact has no phone or email for HubSpot search');
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
      const hubspotContact = response.contact || response.result || response;
      
      if (hubspotContact && typeof hubspotContact === 'object' && hubspotContact.id) {
        // Valid contact found
        console.log('[Active Call API] HubSpot contact found:', hubspotContact);
        return hubspotContact;
      }
    }

    // No contact found or invalid response
    console.warn('[Active Call API] No HubSpot contact found for:', { phone, email });
    return null;
  } catch (error) {
    console.error('[Active Call API] Error searching HubSpot:', error);
    return null;
  }
}

// ============================================================================
// CONTACT DATA ENRICHMENT FOR DISPLAY
// ============================================================================

/**
 * Enrich contact data with HubSpot information for CRM panel display
 * 
 * Merges Active Call contact data with HubSpot contact details.
 * If HubSpot search fails or returns no contact, returns enriched data
 * with original contact information intact.
 * 
 * @param {Object} contact - Contact from Active Call
 * @param {Object|null} hubspotContact - Contact from HubSpot search (may be null)
 * @returns {Object} - Enriched contact data for CRM panel
 */
function enrichContactForDisplay(contact, hubspotContact) {
  if (!contact) {
    return null;
  }

  // Start with Active Call contact as base
  const enrichedContact = {
    // Core identification
    name: contact.name || '',
    number: contact.number || '',
    email: contact.email || '',
    
    // Organization info
    company: contact.company || '',
    jobTitle: contact.jobTitle || '',
    
    // Call-related fields
    location: contact.location || contact.company || '',
    avatar: contact.avatar || '',
    dealValue: contact.dealValue || '',
    pipelineStage: contact.pipelineStage || '',
    
    // Track if this came from HubSpot enrichment
    isEnriched: false,
    sourceContactId: contact.hubspotId || null
  };

  // If HubSpot contact found, merge/override with HubSpot data
  if (hubspotContact) {
    enrichedContact.isEnriched = true;
    
    // Merge HubSpot fields (these override contact fields)
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
 * Execute workflow when a call connects
 * 
 * This is the main integration point that orchestrates:
 * 1. Searching HubSpot for contact information
 * 2. Enriching the contact with HubSpot data
 * 3. Preparing the contact for CRM panel display
 * 
 * The workflow is non-blocking: if HubSpot search fails, the call
 * continues with the original contact data.
 * 
 * @param {Object} contact - Contact from Active Call
 * @returns {Promise<Object>} - Enriched contact data ready for CRM panel
 */
async function onCallConnected(contact) {
  if (!contact) {
    console.error('[Active Call API] No contact data provided');
    return null;
  }

  try {
    // Search HubSpot for contact information
    const hubspotContact = await searchHubSpotContactForCall(contact);
    
    // Enrich contact data with HubSpot information
    const enrichedContact = enrichContactForDisplay(contact, hubspotContact);
    
    // Log enrichment result
    if (hubspotContact) {
      console.log('[Active Call API] Contact enriched with HubSpot data');
    } else {
      console.log('[Active Call API] Contact using local data (HubSpot not available)');
    }
    
    return enrichedContact;
  } catch (error) {
    console.error('[Active Call API] Error in onCallConnected:', error);
    // Fall back to basic contact data
    return enrichContactForDisplay(contact, null);
  }
}

// ============================================================================
// HUBSPOT CONTACT SAVE/UPDATE
// ============================================================================

/**
 * Save or update contact information in HubSpot
 * 
 * Endpoint: POST /api/hubspot/contacts
 * 
 * Purpose: When an agent saves contact details (either from editing or post-call),
 * synchronize the changes with HubSpot.
 * 
 * @param {Object} contact - Contact data to save
 * @param {string} contact.hubspotId - HubSpot contact ID (if updating existing)
 * @param {string} contact.name - Contact name
 * @param {string} contact.email - Contact email
 * @param {string} contact.number - Contact phone
 * @param {string} contact.company - Company name
 * @param {string} contact.jobTitle - Job title
 * @returns {Promise<Object>} - Result from HubSpot
 */
async function saveContactToHubSpot(contact) {
  if (!contact) {
    console.warn('[Active Call API] No contact data provided for save');
    return null;
  }

  try {
    // Build request body with contact fields
    const contactData = {
      id: contact.hubspotId || undefined,
      name: contact.name || '',
      email: contact.email || '',
      phone: contact.number || '',
      company: contact.company || '',
      jobTitle: contact.jobTitle || ''
    };

    // Remove undefined fields
    Object.keys(contactData).forEach(key => {
      if (contactData[key] === undefined) {
        delete contactData[key];
      }
    });

    // Make the API request
    const response = await dialforgeApi.fetch('/api/hubspot/contacts', {
      method: 'POST',
      body: contactData,
      fallbackValue: null
    });

    if (response) {
      console.log('[Active Call API] Contact saved to HubSpot:', response);
      return response;
    } else {
      console.warn('[Active Call API] No response from HubSpot contact save');
      return null;
    }
  } catch (error) {
    console.error('[Active Call API] Error saving contact to HubSpot:', error);
    return null;
  }
}

// ============================================================================
// POST-CALL CRM NOTES SYNCHRONIZATION
// ============================================================================

/**
 * Save CRM notes to HubSpot
 * 
 * Endpoint: POST /api/hubspot/contacts
 * 
 * Purpose: When an agent saves post-call CRM notes, synchronize them
 * with the contact record in HubSpot.
 * 
 * @param {Object} data - Notes and contact data
 * @param {string} data.hubspotId - HubSpot contact ID
 * @param {string} data.notes - CRM notes text
 * @param {string} data.noteType - Type of note (general, objection, followup, crm, etc.)
 * @param {Object} data.contact - Full contact object
 * @returns {Promise<Object>} - Result from HubSpot
 */
async function saveCrmNotesToHubSpot(data) {
  if (!data) {
    console.warn('[Active Call API] No CRM notes data provided');
    return null;
  }

  try {
    // Build request body combining contact and notes
    const requestBody = {
      id: data.hubspotId || data.contact?.hubspotId,
      notes: data.notes || '',
      noteType: data.noteType || 'general',
      // Include contact details for context
      name: data.contact?.name,
      email: data.contact?.email,
      phone: data.contact?.number,
      company: data.contact?.company,
      jobTitle: data.contact?.jobTitle
    };

    // Remove undefined fields
    Object.keys(requestBody).forEach(key => {
      if (requestBody[key] === undefined || requestBody[key] === '') {
        delete requestBody[key];
      }
    });

    // Make the API request
    const response = await dialforgeApi.fetch('/api/hubspot/contacts', {
      method: 'POST',
      body: requestBody,
      fallbackValue: null
    });

    if (response) {
      console.log('[Active Call API] CRM notes saved to HubSpot:', response);
      return response;
    } else {
      console.warn('[Active Call API] No response from HubSpot notes save');
      return null;
    }
  } catch (error) {
    console.error('[Active Call API] Error saving CRM notes to HubSpot:', error);
    return null;
  }
}

// ============================================================================
// ZENDESK SUPPORT TICKET CREATION
// ============================================================================

/**
 * Create a support ticket in Zendesk
 * 
 * Endpoint: POST /api/zendesk/tickets
 * 
 * Purpose: When an agent creates a support ticket during or after a call,
 * send the ticket data to Zendesk.
 * 
 * @param {Object} ticketData - Ticket information
 * @param {string} ticketData.subject - Ticket subject
 * @param {string} ticketData.description - Ticket description/issue
 * @param {string} ticketData.priority - Ticket priority (low, normal, high, urgent)
 * @param {Object} ticketData.contact - Contact information
 * @param {string} ticketData.contact.name - Requester name
 * @param {string} ticketData.contact.email - Requester email
 * @param {string} ticketData.contact.hubspotId - HubSpot contact ID (optional)
 * @returns {Promise<Object>} - Result from Zendesk
 */
async function createSupportTicket(ticketData) {
  if (!ticketData) {
    console.warn('[Active Call API] No ticket data provided');
    return null;
  }

  try {
    // Build request body for Zendesk ticket
    const requestBody = {
      subject: ticketData.subject || 'New Support Request',
      description: ticketData.description || '',
      priority: ticketData.priority || 'normal',
      requester: {
        name: ticketData.contact?.name || '',
        email: ticketData.contact?.email || ''
      },
      // Additional context
      ...(ticketData.contact?.hubspotId && { hubspotContactId: ticketData.contact.hubspotId }),
      ...(ticketData.contact?.company && { company: ticketData.contact.company })
    };

    // Make the API request
    const response = await dialforgeApi.fetch('/api/zendesk/tickets', {
      method: 'POST',
      body: requestBody,
      fallbackValue: null
    });

    if (response) {
      console.log('[Active Call API] Support ticket created in Zendesk:', response);
      return response;
    } else {
      console.warn('[Active Call API] No response from Zendesk ticket creation');
      return null;
    }
  } catch (error) {
    console.error('[Active Call API] Error creating support ticket:', error);
    return null;
  }
}

// ============================================================================
// EXPORTS / GLOBAL NAMESPACE
// ============================================================================

/**
 * Expose Active Call API utilities globally
 * 
 * Usage:
 *   const enrichedContact = await activeCallAPI.onCallConnected(contact);
 *   const hubspotContact = await activeCallAPI.searchHubSpotContactForCall(contact);
 *   await activeCallAPI.saveContactToHubSpot(contact);
 *   await activeCallAPI.saveCrmNotesToHubSpot(notesData);
 *   await activeCallAPI.createSupportTicket(ticketData);
 */
const activeCallAPI = {
  // SIP demo / AI-human handoff workflow
  getSipCallRoom,
  acceptSipHandoff,
  resumeSipAI,
  reportSipHandoffFailure,
  hangupSipCall,

  // Main workflow
  onCallConnected,
  
  // Individual functions
  searchHubSpotContactForCall,
  enrichContactForDisplay,
  saveContactToHubSpot,
  saveCrmNotesToHubSpot,
  createSupportTicket,
  
  // Cache key references
  cacheKeys: ACTIVE_CALL_CACHE_KEYS
};

// Make globally accessible
if (typeof window !== 'undefined') {
  window.activeCallAPI = activeCallAPI;
}
