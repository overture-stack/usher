# UAC user flows: what they settle and what they contradict

Maps the iMS Data Portal UAC user flow specifications to this design. **The flows document is
canonical and lives outside this repository** as a live document maintained by the iMS side; the
copy read for this analysis was last updated 2026-07-24. Flow text is deliberately not reproduced
here, only identifiers and what follows from them.

Companion to [brd-traceability.md](brd-traceability.md). The requirements say what the system must
do; the flows say what a person does, step by step, and are therefore more specific in exactly the
places a requirement can stay vague.

## Vocabulary

The flows use **Data Steward** for resource-scoped management authority: a Steward owns datasets,
shares them, revokes access, and adds other Stewards. That is this design's **Owner**. It is not
this design's **Custodian**, which holds one category across resources and no data access of
its own. The two documents agree in meaning and differ in wording; see the terminology section of
[brd-traceability.md](brd-traceability.md).

The flows also say **constraint token** where this design says **Usher token**.

## What the flows settle

| Question                                            | Was                 | Flows say                                                                        |
| --------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------- |
| Does adding an owner need existing owners' consent? | Open (FR-22)        | No. A Steward adds another by email with no consent step (4.5)                   |
| May an owner remove a peer, or only themselves?     | Open (FR-23)        | Both. Peer removal is its own flow (4.6); self-removal is another (4.7)          |
| Where is the non-empty-owner invariant enforced?    | Unstated            | At both removal paths: self-removal (4.7) and admin removal of a submitter (5.3) |
| Which component enforces download?                  | Open (FR-02, FR-15) | The file API, on every request, independently of the search path                 |

**The invariant's wording is already drafted.** Flow 4.7 blocks the sole Steward from removing
themselves and tells them to add another first. This is the non-empty-set rule arrived at
independently from the requirements side, which is corroboration rather than coincidence.

**Download is a second enforcement path, and the first does not cover it.** The cross-persona table
puts token validation on every file request and blocks direct URL access at the API layer. So the
adapter covers search and something else covers files. Ownership of that is settled; the work is
to design it rather than to decide who owns it.

**Notification is core, not a nice-to-have.** The flows put email on the critical path in at least
four places: sharing with an existing user, sharing with an unregistered address, declining an
invitation, and registration invitation. Only revocation and steward-removal notices are marked
nice-to-have. No mechanism is designed for any of it yet, tracked as FR-09 in
[brd-traceability.md](brd-traceability.md), and a design that omits notification does not deliver
these flows.

**Revocation notices are misclassified, though the reclassification does not bite at MVP.** The
flows mark them nice-to-have. Usher's refusal decision makes them the only thing that tells a
researcher their access ended, because an application cannot distinguish a lapsed approval from a
stranger and no exception to the existence-denying refusal is possible. See the refusal decision in
[../design/decisions.md](../design/decisions.md). The notices are deliberately post-MVP, so for the
first release the flows' classification and this design agree by accident: neither ships them. They
diverge the moment either side builds notification, and the flows' own reasoning for
nice-to-have does not survive that point, so it is worth settling with the author rather than
discovering later.

## What the flows contradicted, and how each resolved

### Sharing a virtual cohort is a predicate-scoped grant

Flow 4.1 offers two sharing routes. The first shares by study and matches the MVP resource model
exactly. The second lets a user build a virtual cohort on the Explore Data page and share that.

A cohort built from Explore Data filters is a query. Sharing it is a grant scoped to a predicate
rather than to a resource, which is the permission recorded here as SQON-scoped grants.

**It is not blocked by the index shapes that block category-based record narrowing.** A cohort
assembled from portal facets is a predicate over descriptive fields the records already carry, so it
needs no per-record category field and no `nested` mapping, and it would compile on both catalogues
today.

Its real difficulties are elsewhere and are about meaning rather than mechanism. **A shared cohort
reintroduces the snapshot problem** that study-level sharing was chosen to avoid: a query is a
description, not a set, so what a recipient reaches changes as records arrive. Whether a share means
the rows matching then or the rows matching now is a governance question with no default answer.
Beyond that, a predicate has to be stored per grant, and a principal holding many such grants
composes into a correspondingly large filter.

**Resolved: not required for MVP.** Sharing a virtual cohort is wanted but not immediate, so the
flow ships with Option 1 only. Record-level narrowing therefore stays post-MVP consistently across
the requirements, the flows and this design, with no route left that quietly depends on it.

### Admin authority points two ways

|                                        | Flows                                                                                 | This design                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Can an admin share?                    | No. Sharing is exclusively the Steward's (5.6)                                        | Yes. An Admin can act as owner through the standard grant flow |
| How does an admin see restricted data? | A configured view-all permission; visibility is platform-level, not grant-based (5.5) | No standing access. Self-grant, explicit, time-limited, logged |

**Resolved, and the persona name is the source of the confusion.** "Data Admin" in the flows means
**system administrator**. The roles that administer access to data are the Owner and the Custodian,
so those are the data administrators, and the flows' persona is not one of them.

A system administrator sees users and the grants they hold, resource metadata, and audit logs, and
does not read the records inside a resource. Open data is the only thing they read, and they read it
as anyone does. Flow 5.5 as written gives that persona all restricted data, which is the one part of
it that does not hold.

A system administrator does hold a self-grant path to data, needing no grant in MVP and
requiring it once community custodianship exists. That is about reaching data, not distributing it,
so flow 5.6 stands: sharing remains exclusively for the roles that administer access to data. See the admin-authority decision
in [../design/decisions.md](../design/decisions.md).

### Submitter access is broader in the flows than intended here

Flow 3.3 gives a new submitter to an existing study management rights over the whole study,
explicitly including datasets other submitters contributed earlier. The intent recorded in this
project is narrower: a submitter reaches what they submitted, plus whatever they are separately
granted, and submitters do not see each other's data by default.

**Resolved: this is instance policy, not an Usher rule.** Submitters in iMS are also granted
ownership, and that correlation is a project requirement rather than something Usher should encode.
The flows are therefore correct about iMS and must not become correct about Usher: the cascade is a
policy the submission flow supplies, with Usher providing the mechanism. See the ownership-policy
decision in [../design/decisions.md](../design/decisions.md).

### The invitation email binding

The cross-persona table says a grant stays pending when the invited person registers under a
different address, because the grant is tied to the invited address.

**Resolved against the flows.** The invited address is a placeholder held only until the grant can
attach to a Keycloak subject, and the magic link performs that attachment against whichever account
the recipient confirms with. Registering under a different address activates the grant rather than
leaving it pending. This follows from the existing decision that Keycloak subjects are the primary
identifier and email serves access invitations only, so the flows' rule is the one that changes.

Worth raising with the author, since a recipient who registers under a different address currently
gets no access at all under the specified behaviour, which reads as a support burden rather than an
intended security property.

## Inconsistencies inside the flows themselves

Worth raising with the author, since they cannot be resolved from this side.

**The unit of ownership reads inconsistently, though the model behind it is settled.** Flow 4.5
grants Steward permissions "scoped to this study, not just a dataset". Flow 4.7 checks whether
someone is the sole Steward "of this dataset". Flow 5.3 checks for sole Stewardship "of any dataset
within the study". Flow 5.2 makes a submitter "a Steward of the submitted dataset".

**Resolved on the model side: the resource is the study.** In iMS the whole data lake is split by
study, which is that project's label for its high-level cohorts, and "dataset" is used loosely at
several levels below it. The two are not interchangeable, so the flows' wording is imprecise rather
than describing a second granularity.

If per-dataset grants within a study are ever wanted, that is a narrower resource field rather than a
record-level feature: the filter stays a positive clause over fields the data already carries, and
no mapping change or new classification field is involved. Cheap, and reachable without redesign.

**The Public and Controlled filter has no field behind it.** Flow 2.5 adds an access-level filter to
the Explore Data pages. Neither iMS catalogue carries a field that can drive it: the clinical index's
access field holds the same value on every record, and the environmental catalogue has no equivalent.
The filter is satisfiable from the resources a viewer holds grants for, which is Usher-side data
rather than index data, so the portal needs it from an API rather than from a facet.

## Status of the personas against this design

**Read this against the flows, not against the near-term build.** The flows describe portal-ui and
are the requirement; the first integration is Stage, and the two are different lists. Notification,
the "Shared with Me" surface and the sharing interface are portal-ui's and arrive with iMS, so a row
below that depends on one of them is not thereby blocking the first integration. See the Stage-first
scoping in [phase-1.md](phase-1.md).

| Persona                           | Deliverable under MVP as designed                                                                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unauthenticated user (1.1 to 1.4) | Yes. Open tier, existence denial, and pending-grant activation on registration are all designed                                                                                               |
| Data consumer (2.1 to 2.10)       | Mostly. Depends on notification and on the "Shared with Me" API, neither designed                                                                                                             |
| Data submitter (3.1 to 3.4)       | Yes for 3.1, 3.2 and 3.4. Flow 3.3 depends on the access-breadth disagreement above                                                                                                           |
| Data steward (4.1 to 4.10)        | Option 1 of 4.1 yes; Option 2 is post-MVP. The rest are management-interface work, not started                                                                                                |
| Data admin (5.1 to 5.6)           | The admin authority question is answered above: 5.6 stands and 5.5 holds except for giving that persona all restricted data. What remains is management-interface work, which has not started |
