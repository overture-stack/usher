# Audit Events

All events are emitted as structured JSON log entries. Every entry includes these common fields
regardless of event type:

| Field        | Description                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------- |
| `event_type` | Event identifier from the table below                                                        |
| `timestamp`  | Unix integer (seconds); ISO 8601 string also acceptable                                      |
| `actor_id`   | Identity of the user or service that triggered the event; `null` for automated system events |
| `source_ip`  | Origin IP for API-initiated events; omit for system-generated events                         |

**Constraints:** Log entries must never contain the grants token payload, raw bearer tokens, or
health record identifiers. See [security-threat-model.md](security-threat-model.md) § A09.

**Log levels:** the severity column maps directly to log levels: `info` is routine (nothing to
see here), `warning` is anomalous and worth reviewing, `critical` demands immediate attention.

---

## Scope

Usher logs the **policy plane**: who holds what grants, and when that changes. It has no
visibility into whether a token was used, what query was run, or what records were returned.
Access decisions happen at the plugin/enforcement layer in each consuming application (Arranger,
Stage, etc.) and are that application's logging responsibility.

A complete audit trail for a health data access event requires correlating two log sources:
Usher (permission in place) and the consuming app (permission exercised). Neither alone is
sufficient for full forensic reconstruction. See [plugin-integration.md](plugin-integration.md)
for the access-decision logging requirements consuming apps must implement.

---

## Events

| Event type                    | Description                                                                                | Actor              | Affected entity            | Additional required fields                                                    | Severity   |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ------------------ | -------------------------- | ----------------------------------------------------------------------------- | ---------- |
| `auth.token.exchange.success` | Grants token successfully issued to a user                                                 | User               | Grants token               | `user_id`, `token_ttl`, `grant_count` (number of grants in token, not values) | `info`     |
| `auth.token.exchange.failure` | Grants token exchange rejected                                                             | User               | n/a                        | `user_id`, `reason`                                                           | `warning`  |
| `grant.approve`               | Category grant approved for a user                                                         | Steward            | User + category + resource | `steward_id`, `grantee_id`, `resource_id`, `category`, `grant_id`             | `info`     |
| `grant.revoke`                | Category grant revoked                                                                     | Steward or admin   | User + category + resource | `actor_id`, `grantee_id`, `resource_id`, `category`, `grant_id`, `reason`     | `info`     |
| `grant.bulk_operation`        | Grant operations by a single actor exceed the configured threshold within a rolling window | Steward or admin   | Multiple                   | `actor_id`, `operation_count`, `window_seconds`                               | `warning`  |
| `identity.revoke`             | User identity flagged as compromised; all active grants revoked                            | Admin              | User                       | `admin_id`, `revoked_user_id`, `scope`                                        | `critical` |
| `resource.register`           | Study or cohort registered                                                                 | Admin or submitter | Resource                   | `actor_id`, `resource_id`, `field_name`, `field_value`, `initial_owner_id`    | `info`     |
| `ownership.transfer`          | Resource ownership transferred                                                             | Owner or admin     | Resource                   | `actor_id`, `from_owner_id`, `to_owner_id`, `resource_id`                     | `info`     |
| `ownership.auto_promote`      | Last remaining steward automatically promoted to owner                                     | System             | Resource                   | `resource_id`, `new_owner_id`, `trigger_event_type`                           | `warning`  |
| `resource.orphaned`           | Resource has no owner; admin notified                                                      | System             | Resource                   | `resource_id`, `last_owner_id`, `trigger_event_type`                          | `critical` |
| `resource.visibility.change`  | Resource hidden or restored due to ownership state                                         | System or admin    | Resource                   | `actor_id`, `resource_id`, `from_state`, `to_state`, `reason`                 | `warning`  |
| `stewardship.assign`          | Steward role assigned to a user for a category within a resource                           | Owner or admin     | User + category + resource | `actor_id`, `steward_id`, `resource_id`, `category`                           | `info`     |
| `stewardship.remove`          | Steward role removed from a user                                                           | Owner or admin     | User + category + resource | `actor_id`, `steward_id`, `resource_id`, `category`                           | `info`     |
| `admin.override`              | Admin performed an action that bypasses a deployment config restriction                    | Admin              | Varies                     | `admin_id`, `operation`, `config_bypassed`, `resource_id`                     | `critical` |
| `revocation.mode.change`      | Revocation channel mode changed (normal / uncertain / suspended)                           | System             | All active sessions        | `from_mode`, `to_mode`, `reason`                                              | `critical` |

---

## Open items

- Retention period per severity level: not yet defined. Health data contexts may impose statutory
  minimum retention. See [security-threat-model.md](security-threat-model.md) § A09.
- Alerting SLAs per severity level: not yet defined.
- Bulk grant operation threshold: configurable; default value not yet decided.
