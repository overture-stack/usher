# Session Log

Brief record of what was done each session, key decisions made, and open threads.
Not a changelog; that is git. Captures context and decisions that do not live in code.
Newest first.

---

## 2026-06-22

Applied design review feedback and brought branch changes into local docs; also added Keycloak
Terraform operator roadmap item and corrected sessions.md format to lean style.

- `.dev/design/admin-model.md`: new file; self-grant endpoint technically enforces TTL and flag (not convention); self-grant/notification compensating controls explicitly coupled (cannot both defer to v1+); peer revocability flagged as pre-ship decision; GET /admin/users replaced with resource-scoped member lookup; structured audit event schema table added; Keycloak Terraform operator noted in bootstrap section
- `.dev/design/permissions-model.md`, `.dev/design/concepts.md`: cross-references to admin-model.md added
- `.dev/design/README.md`: admin-model.md added to coverage table; four new "Decisions needed before implementation" rows
- `.dev/roadmap.md`: "Admin model: open questions" section added; Keycloak Terraform operator item added under Deployment architecture

---

## 2026-06-20

Documented the admin model covering OIDC-first identification, role taxonomy, bootstrap,
self-grant flow, service accounts, and audit integrity.

- `.dev/design/admin-model.md`: new document (produced in web chat; applied to local tree); OIDC-first identification (no platform_admins table), bootstrap delegated to IdP, self-grant TTL mandatory, service account hybrid auth model, audit log INSERT-only + out-of-band stdout controls, OPA deferred
- `.dev/design/permissions-model.md`, `.dev/design/concepts.md`: cross-references to admin-model.md
- `.dev/design/README.md`: admin-model.md added to coverage table; open questions registered
- `.dev/roadmap.md`: admin model resolved items and open questions recorded

---

## 2026-06-19

**Done:**

- Closed two open design questions in `permissions-model.md`:
    - Existence disclosure: "discoverable-but-inaccessible" mode will not be introduced at any
      version; existence is denied along with access, unconditionally.
    - Admin listing vs. data access: PAP admins can enumerate all resources platform-wide for
      operational purposes, but that does not extend to reading, downloading, or sharing data.
      Any such action requires an explicit logged grant through the permissions system.

- Updated `permissions-model.md` with additions from the AuthZ Framework and iMS UAC
  Requirements document reviews:
    - `user_groups` and `group_category_grants` added to the core entity list (design gap noted;
      covers group memberships, group category grants, and Keycloak group sync as an option).
    - New section "Grant composition and visibility semantics": defines the visibility rule
      (record visible if user holds grants for ALL its tagged categories), the multi-category
      composition table, the category-to-field mapping pattern, and a note on write permissions
      for Lyric.
    - New section "OCAP compliance considerations": explains OCAP and data sovereignty, maps
      the generic model's alignment points (granular categories, deny-by-default, rapid
      revocation, audit trail), identifies data stewardship as the key new capability OCAP
      requires (delegated category admin without global admin rights), and clarifies that
      OCAP compliance is a deployment/configuration concern, not a code change.
    - New section "Private data sharing, resource ownership, and embargo": documents the iMS
      primary use case (private by default, peer-to-peer sharing via named grants independent
      of group membership), the no-system-wide-private-access principle (PAP admins manage
      grants but hold no implicit data access; separation of duties is a hard requirement),
      resource ownership as the submitter-scoped variant of data stewardship, embargo as a
      `private` category_grant with `expires_at`, and visibility of private records (full
      denial is v1; discoverable-but-inaccessible is a future option).
    - New open questions: multi-category intersection access (OCAP-sensitive), user groups
      design detail, write permissions (Lyric, deferred), data stewardship scoping, embargo
      scheduling (background job for sessions-less release), record existence visibility.
- Updated status note in `permissions-model.md` to reflect current coverage.
- Added "The permissions model entities" section to `concepts.md`, covering resources, roles,
  memberships, data categories, category grants, and user groups. Includes a table clarifying
  the three "membership" entities (`user_group_members`, `memberships`, `group_memberships`)
  and the distinction between belonging to a group (administration) vs belonging to a resource
  (access).
- Introduced "cohort" as the Overture-context term for a resource in both `concepts.md` and
  `permissions-model.md`. Documented the venn-diagram overlap model (a record can belong to
  multiple cohorts simultaneously) and the contrast with Song/Lyric's silo-per-study approach.
  Added "Overlapping cohort access semantics" (OR vs AND membership composition) to Open
  questions in `permissions-model.md`.
- Fixed duplicate `2026-06-19` date entries in `sessions.md` (both entries merged into one).
- Removed double-dash punctuation from all Usher `.dev/` documents (full cleanup across
  concepts.md, permissions-model.md, security-workflow.md, security-threat-model.md, roadmap.md,
  tech-debt.md, sessions.md, README.md, plugin-integration.md, management-ui.md).
- Rewrote `design/README.md` as a navigation guide: added recommended reading order by reader type
  (new to Usher, security reviewer, permissions model reviewer, PEP plugin implementer); updated
  the permissions-model status description to reflect current coverage; added "Decisions needed
  before implementation" table mapping unresolved open questions to the document they live in and
  what they block.
- Created root `README.md` for the Usher project: status callout (design phase, no implementation),
  Overture platform context, link to Design Index, related software table, support and
  contributions, funding acknowledgement.
- Updated `roadmap.md`: removed "Expiry and renewal design" from the "Complete permissions model"
  still-needed list (resolved June 18); added four new items: overlapping cohort access semantics,
  multi-category intersection (OCAP-sensitive), user groups design detail, and data stewardship
  scoping.

**Decisions:**

- OCAP compliance is a deployment/configuration concern, not a code change in Usher's core model.
- Data stewardship (category-scoped admin delegation) is a required capability for OCAP
  deployments and must be designed before the management UI begins.
- Multi-category intersection question is explicitly unresolved; flagged for deliberate decision
  with OCAP practitioners before implementation.
- Peer-to-peer sharing is a priority capability; group membership is not a prerequisite for
  receiving a direct grant on a specific resource.
- No system-wide "see all private" access, including for PAP admins. Hard design requirement,
  not a policy convention.
- Default visibility in iMS: public vs. private is set at submission time by the submitter;
  Lyric assigns the category at ingest; Usher's deny-by-default applies once set.
- Embargo maps to a `private` category_grant with `expires_at`; scheduled release without
  active sessions is an open sub-question requiring a background job.
- "Cohort" adopted as the Overture-context domain term for what Usher calls a resource.

---

## 2026-06-18

**Done:**

- Added two new sections to `concepts.md`:
    - "Data access tiers": Open/Registered/Controlled model, mapped to Usher mechanisms
      (no constraint token / membership grants uncategorized access / explicit category_grant
      required). The data category model now has a named conceptual home.
    - "GA4GH Passports and federated identity": explains what Passports are (a JWT claim
      format, not a new protocol), the Visa types relevant to Overture (ControlledAccessGrants
      maps to category_grants), the three ecosystem roles (Visa Issuer, Passport Broker,
      Clearinghouse), and how Usher plays the Clearinghouse role via Keycloak. Covers the
      grant-expiry-triggers-revocation decision, local-admin-can-revoke-external-grant decision,
      and REMS as the optional Visa Issuer for Overture's own approval workflows.
- Updated `permissions-model.md`:
    - Documented the two grant origins (internal vs external/Passport-sourced) on category_grants,
      including the `granted_by` auditability requirement.
    - Resolved the "Expiry and renewal" open question: grant expiry triggers `revoked_at`, same
      path as manual revocation.

**Decisions:**

- GA4GH Passport Visa expiry triggers Usher's `revoked_at` revocation mechanism; consistent
  with manual revocation, no special-case path.
- Local administrators can revoke grants that originated from external Passport Visas; local
  policy can restrict access downward but cannot grant beyond what the Visa covers.
- The three-tier access model (Open/Registered/Controlled) is adopted as the organizing framework
  for Usher's permissions model.

---

## 2026-06-17

**Done:**

- Created `.dev/design/` folder with six design documents: `README.md` (coverage index),
  `concepts.md` (vocabulary reference), `security-workflow.md` (specced), `permissions-model.md`
  (in progress), `plugin-integration.md` (stub), `management-ui.md` (stub).
- Created `.dev/design/security-threat-model.md`: full OWASP Top 10:2025 mapping with addressed
  vs. open gap analysis per category; PHR sensitivity framing.
- Created devctx scaffolding: `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`,
  `DEVELOPMENT.md`, `.dev/roadmap.md`, `.dev/tech-debt.md`, `.dev/sessions.md` (this file).

**Decisions:**

- JWE (encrypted JWT, RFC 7516) for constraint tokens, not plain signed JWS. Rationale: token
  holders must not be able to read their own access constraints; local plugin validation requires
  self-contained tokens without per-request Usher calls.
- Fail-secure on revocation channel disruption: if a plugin cannot confirm revocation status
  within the grace period (default 60s), sessions are suspended and requests return 503. An
  adversary blocking revocation signals gains nothing.
- Per-user `revoked_at` timestamp for revocation, not a per-token blocklist. Scales to arbitrary
  issuance volume; the `generatedAt` claim already embedded in every token is the anchor.
- Push (SSE/WebSocket) + poll (`GET /revocations?since=<ts>`) dual channel for revocation
  propagation. Push for speed; poll as the reliability fallback. Worst-case propagation = poll
  interval, not TTL.
- Hybrid role + attribute model: roles for coarse capability; data category grants for
  contextual scope. Prevents role proliferation while supporting fine-grained access (e.g.
  indigenous data requiring explicit grant regardless of role or membership).
- Model-agnostic design: `resource`, `membership`, `category` in the service core. Domain-specific
  labels (study, patient) belong only in the management UI layer.
- Deny by default: data category access requires an explicit `category_grant`; membership alone
  is not sufficient.
- 503 (service temporarily unavailable) on revocation-uncertain mode, not 401 (unauthenticated)
  or 200. Suspended sessions resume without re-authentication when connectivity is restored.

**Open threads:**

- JWE algorithm selection (AES-256-GCM + RSA-OAEP or ECDH-ES): not yet decided.
- Permissions model: field-level restriction implementation approach (options A-D analysed; choice
  deferred), role capability definitions, multiple-roles-per-user question, category grant scope.
- Plugin integration: API contract, key distribution and rotation strategy, constraint payload
  schema and versioning.
- Database schema design: physical schema, indexes, integrity controls, encryption at rest.
- IdP unavailability handling: what Usher does when the IdP cannot validate a bearer token
  (should be fail-secure: reject the exchange; but not yet specced).
