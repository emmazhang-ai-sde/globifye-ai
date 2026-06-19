### Schema Tables

| Table              | Key Fields                                                                                                                                     | Written When                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `organizations`    | `id`, `name`, `created_at`                                                                                                                     | On SuperAdmin signup                |
| `users`            | `id` (UUID), `organization_id`, `email`, `role`, `is_active`                                                                                   | On signup / invite accepted         |
| `invites`          | `organization_id`, `invited_by`, `email`, `role`, `token`, `status`                                                                            | When admin sends invite             |
| `phone_numbers`    | `organization_id`, `did_number`, `is_active`, `assigned_at`                                                                                    | When org is created                 |
| `contacts`         | `organization_id`, `apollo_id`, `hubspot_id`, `name`, `email`, `phone`, `company`                                                              | When call is initiated              |
| `recordings`       | `id`, `organization_id`, `recorded_by`, `contact_id`, `did_number`, `caller_number`, `audio_url`, `status`, `duration_seconds`, `sip_provider` | Call starts / ends                  |
| `transcript`       | `recording_id`, `speaker`, `content_raw`, `content_clean`, `sentence_start_sec`, `sequence_index`                                              | Real-time, per sentence during call |
| `analysis`         | `recording_id`, `summary`, `key_topics` (JSON), `objection_analysis` (JSON), `what_went_well` (JSON)                                           | After button click                  |
| `topics`           | `recording_id`, `analysis_id`, `name`, `start_time`, `sequence_index`                                                                          | After button click                  |
| `gpu_jobs`         | `organization_id`, `recording_id`, `job_type`, `status`, `compute_units`, `cost`                                                               | After each AI job completes         |
| `crm_integrations` | `organization_id`, `provider`, `access_token`, `refresh_token`, `token_expires_at`, `is_active`                                                | When SuperAdmin connects a CRM      |
| `crm_sync_log`     | `recording_id`, `organization_id`, `provider`, `external_record_id`, `sync_type`, `status`, `error_message`, `synced_at`                       | After each CRM push attempt         |
| `webhooks`         | `organization_id`, `event_type`, `target_url`, `secret`, `is_active`                                                                           | When org configures Zapier          |
| `subscriptions`    | `organization_id`, `plan_type`, `status`, `gpu_quota`, `renewal_date`                                                                          | On org signup / plan change         |
| `transactions`     | `transaction_key` (unique), `organization_id`, `amount`, `currency`, `status`                                                                  | Payment gateway webhook             |
| `payment_logs`     | `transaction_key`, `organization_id`, `event_type`, `raw_payload` (JSON)                                                                       | Every gateway event received        |
| `api_keys`         | `organization_id`, `created_by`, `key_hash`, `label`, `is_active`                                                                              | When SuperAdmin generates key       |