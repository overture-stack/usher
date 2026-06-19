# Access Management UI

_Status: not started. This document captures known requirements and open questions._

---

## Concept

The access management UI is Usher's **PAP (Policy Administration Point)** layer: the interface
through which administrators manage who can access what, without requiring Keycloak admin access
or any IdP-level configuration.

Target audience: data access administrators and resource coordinators. The UI presents
domain-specific language configurable per deployment (in an iMS deployment, "resources" appear
as "studies"; "memberships" appear as "study enrolments").

---

## Known scope

- **Resource management:** register and describe resources available in Usher.
- **Role management:** define the roles available for assignment (e.g. curator, member).
- **Data category management:** define data categories and assign them to resources.
- **Membership management:** assign users to resources with a role; view and revoke memberships.
- **Category grant management:** grant or revoke user access to specific data categories within a
  resource (exposed as a checklist within the membership editor).
- **Revocation controls:** trigger emergency revocation for a user, all users of a resource, or
  platform-wide (global revocation requires explicit confirmation).
- **Audit log:** record of all access decisions, permission changes, and revocation events. Scope,
  retention policy, and queryability are not yet designed.

---

## Open questions

### Domain label configurability

How are domain-specific labels (study vs resource, enrolment vs membership) configured? At deploy
time via environment variables, via a UI settings page, or via a configuration file? The answer
affects how multi-tenant or multi-domain deployments are supported.

### User search and identity resolution

The UI needs to let admins find users by name or email to assign memberships. This requires
querying the IdP's user directory. How does Usher integrate with the IdP's user search API, and
what happens when a user exists in Usher's policy store but not (or no longer) in the IdP?

### Audit log design

Where is the audit log stored? Options: Usher's own database (queryable from the UI), an
external logging service (shipped via structured log output), or both. What is the required
retention period (this may be governed by data governance policy per deployment). Should the
log be queryable through the UI, or export-only?

### Request and approval workflows

Should the UI support a workflow where a user requests access to a resource or category grant,
and an admin approves or denies? This is relevant for DACO-style gated access (ethics-review-
required). Not in current scope but should be considered in the UI architecture so it can be
added without a full redesign.

### Multi-tenancy

Can one Usher deployment serve multiple independent organizations, each with their own resources,
roles, and administrators? If so, the UI needs tenant isolation and per-tenant admin roles. If
not, each organization deploys its own Usher instance.
