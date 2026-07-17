# DialForge — Security and Compliance

## Certifications
- **SOC 2 Type II** — audited controls for security, availability, and confidentiality; report available under NDA.
- **GDPR** — data processing agreement available; supports data-subject access and deletion requests.
- **HIPAA** — available as a configuration for healthcare customers, under a Business Associate Agreement (BAA).

## Data handling
- Encryption in transit (TLS) and at rest.
- Call audio and transcripts are stored in the customer's tenant and are not used to train shared models.
- Configurable data retention, including short-retention and redaction options.

## PII protection
Sensitive fields (for example payment card or government ID numbers) can be redacted from transcripts. The agent is instructed never to request card numbers or passwords by voice.

## Access control
Role-based access for team members (Enterprise), SSO / SAML for enterprise identity providers, and audit logs of who accessed what.

## Reliability
Redundant infrastructure with health monitoring on the call path. If the agent cannot handle a call, it fails safe to a human handoff or callback capture rather than continuing blindly.

## Responsible use
DialForge answers only from the customer's knowledge base and uses the fallback line plus human handoff when it does not know, which limits the risk of confidently wrong answers. Calls can be disclosed as AI-assisted where regulations require.
