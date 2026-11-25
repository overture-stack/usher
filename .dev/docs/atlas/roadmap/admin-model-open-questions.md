# Admin model: open questions

Three items must be resolved before the admin API is implemented. See `.dev/design/admin-model.md`.

## Must resolve before v1

**Self-grant compensating controls.** Step-up authentication (MFA re-prompt) and resource owner notification are linked: if step-up is deferred to v1+, owner notification is required for v1. Both cannot be deferred simultaneously. Notification requires infrastructure design.

**Self-grant peer revocability.** Self-grants are standard grants; any platform admin can revoke any grant, including a peer's active self-grant. Decide whether to restrict self-grant revocation to the creator or leave it open to all platform admins.

**Break-glass procedure (open).** If all platform admins are unavailable, no role assignment at the identity provider recovers access, since administrator status is Usher's own record and no identity provider role grants it. Once the design settles how an administrator is restored, a standard operating procedure (SOP) must name who may restore one, and how.

## Can trail v1

- Self-grant step-up authentication (NIST SP 800-63B recommended; see compensating controls above)
- Audit event schema formalization (minimum fields defined in `admin-model.md`; formal schema TBD)
- Multi-tenancy admin scope
