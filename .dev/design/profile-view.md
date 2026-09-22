# Profile view

_Status: not started. This document captures scope, the one constraint that shapes it, and the open
questions. Written to be taken to the applications that already have a profile, rather than
specified over them._

---

## Concept

The surface where a person acts on their own access, as against the
[management UI](management-ui.md), where someone acts on other people's. The two are separated by
audience rather than by function: a person with no administrative standing at all still has a
profile, and an administrator's profile is about their own access rather than their authority over
anyone else's.

Both Stage and iMS portal-ui already have a profile view, and the intent is one implementation
serving both. Stage's is the more developed and covers part of this scope already, so the useful
order is to read theirs first and specify only what is missing.

---

## The constraint that shapes everything here

**A decrypted Usher token never leaves the service that decrypted it.** See
[decisions.md](decisions.md) § Decrypted permissions never leave the service that decrypted them.

That has a consequence this surface cannot design around. A profile view is built from permissions,
so it needs a server side holding a bridge, and a browser calling the controller directly cannot host
it. That holds even though what the view shows is something the person could work out from what they
can already reach.

The payload and a view built from it are different things. The payload carries structure, shape and
resource identifiers that the rendering never shows; the view carries a list a person recognizes.
Sending the payload because the rendering would be harmless is the mistake the decision exists to
prevent.

**What that means per application today.** Stage has a server side and can host a bridge. Portal-ui
is the same framework and can host one, and is simply not set up to today. So the gap between them is
configuration rather than architecture, and the work carries across rather than being invented twice:
Stage proves the pattern, portal-ui adopts it. Until portal-ui is set up, this surface is available
where a server side is already running.

**It does not block data access.** Enforcement lives in the service holding the data, so a
browser-only application still shows correctly filtered results. What it cannot do is show a person
their own policy state.

---

## Scope

### In, for MVP

- **See the permissions I hold.** Which resources, which categories within them, and what each lets
  me do. Rendered from the payload, and positive only: what someone lacks is not shown, because the
  absence of a grant is what discloses that restricted data exists at all.
- **API tokens.** Create and revoke the long-lived credential used for programmatic access, notably
  Score. See the open question below: the current path issues these through a Keycloak plugin rather
  than through Usher, and whether that stays true is undecided.

### Out, deliberately, and post-MVP

- **Rescinding my own permissions.** Every revocation path in the design today is initiated by a
  custodian or an administrator. A grantee giving up access puts a new actor on that verb, which needs an
  audit event of its own and raises whether a permission held through a group can be given up
  individually at all.
- **Self-deletion, or requesting it.** Blocked behind the erasure question in
  [to-discuss.md](to-discuss.md), where the right to erasure meets an append-only audit log and no
  resolution is chosen.

### Not here at all

- **Deleting someone else's account** belongs to the management UI. It is an administrator acting on
  another person, which is the other side of this document's boundary.
- **Granting or revoking for others**, for the same reason.

---

## Open questions

- **Where the read comes from.** A profile view needs the person's own permissions, and the Usher
  token issued to a data service is addressed to that service. Either the profile's own bridge
  performs an exchange for its own audience, or the controller grows a read endpoint for a principal's
  own state. The first reuses the exchange and gets audience separation at no extra cost; the other opens a
  second read path into the policy store and would need its own authorization basis.
- **What an API token resolves to.** The current path issues one through a Keycloak plugin, which
  makes it an IdP credential that Score presents like any other, and the exchange then works
  unchanged. That is the cheaper answer and it keeps Usher out of credential issuance. What needs
  confirming is the lifetime: [../docs/phase-1.md](../docs/phase-1.md) records that API tokens open a
  much longer window than the five-minute Usher token, which is the window revocation depends on.
- **Whether a rendered view is a per-application concern or a shared contract.** If both applications
  render from the same payload, the positive-only rule has to hold in both, and a rule two codebases
  enforce separately is one that a codebase will eventually stop enforcing. A shared component, or a
  controller-side rendering, would make it structural. The neighbouring surface has already answered
  this for itself: the management UI ships as a package from this repository that portals mount. That
  is the same argument reaching the same place, so the burden here is on showing why this surface
  differs rather than on justifying a shared component. See [management-ui.md](management-ui.md).
- **What the view says when the controller is unreachable.** The open tier is still served during an
  outage, so a person may be looking at a reduced result set elsewhere in the application. Whether
  the profile reports that state, and how, is part of the same notification question recorded in
  [security-workflow.md](security-workflow.md).

---

## Prior art to read before specifying

Stage's existing profile covers the API token part, and its NextAuth session handling is the closer
model for where a bridge would sit. The convergent finding from comparing both applications, that the
session-validity check is client-side in each, matters here: under Usher that check stops governing
data access, since the data service revalidates, but it still governs what the profile shows, and a
profile that trusts a browser-side check will show stale state after a revocation.
