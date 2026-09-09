# BRD traceability: iMS Data Portal UAC

Maps each requirement in the iMS Data Portal UAC business requirements document to what in this
design satisfies it. **The BRD is canonical and lives outside this repository**, maintained by the
iMS side as a working draft. Requirement text is deliberately not copied here: this file holds
identifiers and what answers them, so nothing drifts except the mapping itself.

Two uses: a decision can cite an identifier, and a reviewer can find the identifiers nothing cites.

Status values: **met** means the design answers it; **partial** means answered with a stated gap;
**open** means nothing in the design addresses it; **conflict** means the design contradicts it.

## Public data access

| ID | Status | What answers it |
|---|---|---|
| FR-01 | met | Open tier. Anonymous requests receive a token carrying open-tier grants, so unauthenticated browsing is governed by the same machinery as everything else |
| FR-02 | partial | Open tier covers the read path. Download is a second enforcement surface, and the flows name its owner: the file API validates on every request. Designing it is outstanding; deciding who owns it is not |
| FR-03 | met | Deny by default plus the existence-denial invariant |
| FR-04 | met, pending verification | Requires restricted data absent from aggregation counts. The disjunctive-composition defect needed an authorization field at depth two or greater; the settled filter is one positive clause on a flat depth-one field, so the condition is absent. Confirming it in practice is the conformance case per value-returning surface |

## Sharing controlled datasets

| ID | Status | What answers it |
|---|---|---|
| FR-05 | met | Categories assigned to a resource at submission; the submission flow creates the resource |
| FR-06 | met | `pending_grants` keyed by email address |
| FR-07 | met | Pending grant state machine, plus the invitation link that binds an existing account under a different address |
| FR-09 | partial | The flows put notification on the critical path in four places, so it is specified rather than absent. No mechanism is designed yet |
| FR-10 | partial | The data exists in `category_grants` with `granted_by`. The flows specify the presentation: sharer, share time, and acceptance timestamp on a "Shared with Me" page. Interface work, not started |
| FR-11 | met | Revocation, per-user `revoked_at`, push channel with poll fallback |
| FR-12 | met | Grants bind to a Keycloak subject and confer no delegation capability, so a consumer has nothing to forward |

## Consumer access

| ID | Status | What answers it |
|---|---|---|
| FR-13 | partial | Requires showing who shared each dataset. `granted_by` records it, and the flows specify what the page shows; the API surface exposing it does not exist |
| FR-14 | met | Enforcement at query time through the plugin |
| FR-15 | partial | Same download surface as FR-02, now with a named owner |
| FR-16 | met | Open tier |
| FR-17 | met | Deny by default |
| FR-18 | partial | Revocation propagates; removal from a portal page is portal work |
| FR-19 | partial | Marked nice-to-have in both documents. Same missing mechanism as FR-09, which the flows now specify |

## Steward management

| ID | Status | What answers it |
|---|---|---|
| FR-20 | met | Ownership cascade: the submitter becomes owner by default |
| FR-21 | decided | Requires multiple holders with equal authority. The single-owner rule moves to a non-empty set; see the ownership item in `.dev/roadmap.md`. Design work outstanding, conflict resolved |
| FR-22 | met | Adding a holder rather than transferring, which the set model supports. The flows settle the open sub-decision: no consent from existing holders is required |
| FR-23 | met | Removal is bounded by the non-empty-set invariant. The flows settle the open sub-decision: both peer removal and self-removal are supported, and the invariant is enforced at each |
| FR-24 | met | The no-owner invariant is the same rule stated from the other side |
| FR-25 | partial | Revocation is prompt within a bounded window rather than instantaneous. Whether "immediate" admits the propagation window needs confirming with the BA |

## Non-functional

| ID | Status | What answers it |
|---|---|---|
| NFR-01 | partial | Enforcement prevents data reaching the portal; the portal not exposing it is portal work |
| NFR-02 | met | Revocation applies to owners as to anyone else |
| NFR-04 | met, pending verification | Same reasoning as FR-04. Level 1 hiding being non-negotiable is why the verification case is required rather than optional |
| NFR-05 | met | Anonymous tokens are cached and the open path adds one positive clause |
| NFR-06 | met | Audit events for grant and revocation, dual channel |
| NFR-07 | met | EGO is replaced rather than integrated |

## Resolved: FR-21 and ownership

The requirements call for several holders of resource authority per dataset with equal rights, naming the real case: a principal investigator holds legal authority while submitters do the work, so all of them need it. The design required exactly one owner and built three mechanisms on that singularity.

**Decided in the requirements' favour.** Ownership becomes a non-empty set, which FR-24 already states from the other side. The cascade seeds a set rather than resolving to one holder, the invariant blocks removal of the last holder rather than any holder, and last-holder promotion is retired because the invariant now prevents the case it repaired. Two sub-decisions remain open, recorded at FR-22 and FR-23: whether adding a holder requires existing holders' consent, and whether a holder may remove a peer or only themselves.

## Conflicts raised by the user flows

Four were raised and all four are resolved. Recorded in full in
[uac-flows-traceability.md](uac-flows-traceability.md).

**Virtual cohort sharing: not required for MVP.** The flow ships with its study-based route only,
so record-level narrowing stays post-MVP with no route quietly depending on it.

**Admin authority: the persona name was the confusion.** "Data Admin" in the flows means system
administrator. The roles administering access to data are the Owner and the Custodian. A system
administrator sees users, their grants, resource metadata and audit logs, and does not read records.
One sub-question stays open: whether a system administrator may grant data access as an override.

**Submitter access breadth: deployment policy, not an Usher rule.** Submitters in iMS are also
granted ownership, which is a project requirement rather than something Usher encodes.

**Invitation email binding: resolved against the flows.** The invited address is a placeholder held
until the grant attaches to a Keycloak subject, and the magic link binds it to whichever account the
recipient confirms with. Registering under a different address activates the grant.

## Resolved: FR-04, NFR-04 and the aggregation path

Both require restricted data absent from aggregation counts, with Level 1 hiding listed as
non-negotiable. They were recorded as conflicts against a known defect that composes an
authorization filter disjunctively.

**The defect's triggering condition is absent under the settled enforcement shape.** It applies
where an authorization field sits at nesting depth two or greater. The emitted filter is a single
positive containment clause on the field naming a resource, which is flat and at depth one in both
of the first deployment's catalogues. A single clause also has no siblings, so the composition
question does not arise rather than being answered favourably.

**Two conditions hold it there, both already required.** The plugin establishes the field's mapping
shape at startup and refuses to enforce where it cannot. And record-level narrowing stays post-MVP:
a per-record category field is precisely what would place an authorization field deep enough for the
defect to return, which is worth knowing as a constraint on that future work rather than a
coincidence.

**What remains is verification, not design.** A value-returning surface can discard the filter
altogether, which is invisible to mapping depth and to configuration, and was found once in practice
by comparing counts rather than by reading code. The conformance case per value-returning surface is
what closes that, and it is why these read as met pending verification rather than simply met.

## Withdrawn

**FR-08** no longer appears in the requirement list and its subject now sits under Out of Scope. Any design text answering it as a live requirement is answering something withdrawn.

## Terminology

The BRD maps **Data Steward to the resource owner role**, and that usage is the one already in
front of stakeholders. This design's separate role, authority over one data category across every
resource held by a community representative with no data access of its own, is therefore named
**Custodian**. The section heading above keeps the BRD's own wording.

The rename is complete in this repository and in the onboarding document. The BRD is maintained
outside this repository and still reads Steward, so the two vocabularies agree in meaning but not
yet in wording.
