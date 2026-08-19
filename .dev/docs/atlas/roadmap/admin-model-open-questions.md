# Admin model: open questions

Three items must be resolved before the admin API is implemented. See `.dev/design/admin-model.md`.

## Must resolve before v1

**Self-grant compensating controls.** Step-up authentication (MFA re-prompt) and resource owner notification are linked: if step-up is deferred to v1+, owner notification is required for v1. Both cannot be deferred simultaneously. Notification requires infrastructure design.

**Self-grant peer revocability.** Self-grants are standard grants; any platform admin can revoke any grant, including a peer's active self-grant. Decide whether to restrict self-grant revocation to the creator or leave it open to all platform admins.

**Break-glass procedure.** If all platform admins are unavailable, recovery goes through the IdP (Keycloak). The deployment runbook must document who is authorized to perform IdP-level role assignment and what audit trail is expected from the IdP layer.

## Can trail v1

- Self-grant step-up authentication (NIST SP 800-63B recommended; see compensating controls above)
- Audit event schema formalization (minimum fields defined in `admin-model.md`; formal schema TBD)
- Multi-tenancy admin scope
