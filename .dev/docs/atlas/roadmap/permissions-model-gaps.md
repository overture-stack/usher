# Permissions model: open items

Seven open items before the permissions model is complete and the core service can be implemented. See `.dev/design/permissions-model.md`.

- **Role permission definitions.** What specific actions does each role permit beyond resource access?
- **Field-level restriction implementation approach.** Options A-D analyzed; recommendation: start with A, extend to C. Formal choice not yet committed.
- **Overlapping cohort access.** If a record belongs to cohorts A and B and the user holds a grant in A only, do they see it? (any or all; see `permissions-model.md` open questions)
- **User groups design.** Keycloak sync or PAP-only? Composition when groups overlap? Revocation when a user is removed from a group? Entities are placeholders; design not yet done.
- **Custodianship scoping.** custodianship.hold permission data model: OCAP prerequisite; must be designed before management UI work begins. See `permissions-model.md` OCAP section.
- **Custodian notification design.** When tightening changes reduce access for existing members, affected users must be notified. Notification mechanism not yet designed. Blocks category change propagation in the management UI.
- **Category change propagation UI.** The management UI must surface a pre-grant flow (grant affected users before tightening takes effect) and the set of affected users derivable from the audit entry. See `permissions-model.md` "Category change propagation".
