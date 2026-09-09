# RABAC alignment: defining the role-permission stage

Usher's permissions model is a role and attribute hybrid, which is a named pattern rather than a
local invention: RABAC, role-centric attribute-based access control
([Jin, Sandhu and Krishnan, MMM-ACNS 2012](https://www.profsandhu.com/confrnc/misconf/mmm-acns12-rabac-paper.pdf)).
Reading the source model against what was designed here shows the gap precisely, and shows that it
is one gap rather than the several separate open items it has been recorded as.

## What RABAC specifies

RABAC extends RBAC with a **permission filtering policy** and evaluates an access in two stages.
It adds user, object and session attributes, and preserves RBAC's role hierarchies, user-role
assignments and role-permission relationships rather than replacing them.

| Stage | Question | Usher today |
|---|---|---|
| 1. Role check | Does this user hold a role carrying this permission at all? | **Not implemented.** Roles carry no permission set |
| 2. Permission filtering | Do the attributes permit exercising it on this particular object? | **Implemented**, as category grants |

Access requires both stages to pass. Usher built the second and skipped the first.

That is the whole finding. The category machinery is a well developed permission filtering policy.
The role-to-permission assignment that the filter is supposed to be filtering was never defined, so
the token carries a `role` label that nothing consumes, because no plugin has anything to consult
it against.

## Three consequences, currently live

**The token carries a role name where it should carry a resolved permission set.** The model states
that a user may hold multiple roles in one resource, that roles are coarse labels rather than a
hierarchy, and that effective permissions are the union across every membership, with the
computation engine required to consult all of them rather than the highest-priority one. The token
schema has a single `role` string. There is nowhere for a union to go, so whatever the engine
computes is flattened to one of three values on the way out.

**A role-to-permission table inside a plugin would put policy in the enforcement layer.** The
architecture requires that applications make no policy decisions. Deciding what `member` permits is
a policy decision, so a plugin holding that mapping holds policy. In RABAC the role check is
evaluated where the roles live, which here is the controller.

**`public` is a permission set wearing a role's clothes.** The token schema documents it as
equivalent to the minimum read capability with no management actions, which is a permission set
written in prose because there is no field to put it in. The missing field is already showing
through the design.

## The correction: resolve roles to permissions at issuance

Carry the resolved permissions in the token rather than the role name that produced them. **Paired
with the category they apply to, not as an independent list.**

    "COHORT_A": [ { "open":       ["view", "download"] },
                  { "controlled": ["view"] } ]

This follows from the architecture already in place rather than changing it. Usher is the decision
point, so resolving what a role permits belongs there. Plugins become mechanical, testing whether
the permission list contains the action. The union problem dissolves, because a union of roles
becomes a union of permission sets computed before issuance. Role explosion stays solved, which is
the point of adopting RABAC in the first place: a new capability adds a permission, never a role.
And a deployment can define its own roles without every plugin having to learn them.

**The permission vocabulary must be platform-fixed, and this is the one place the pattern does not
follow categories.** Categories are deliberately deployment-defined and opaque to Usher, because
only a plugin's own configuration gives them meaning. Permissions are the opposite: both the
controller and every plugin must agree on what `download` means, so the vocabulary is defined once
at the platform level. Starting set to settle: `read`, `download`, `create`, `update`, `delete`.

**The two axes are conceptually distinct but must not be carried independently.** An earlier
version of this document proposed exactly that, a `permissions` list beside a `categories` list, and
it is less expressive than both RABAC and the requirement it was meant to serve. Two independent
lists imply their full cross-product: every permission applying to every category. The source model
does not work that way. Each permission in RABAC carries its own filtering condition, and the paper
states directly that distinct operations may be permitted under different constraints, so a filter
attached to reading need not be the filter attached to writing.

The concrete case this project already asked for and the orthogonal shape cannot express: read on
one category, read and upload on another, within the same resource. Pairing the capability with the
category expresses it; two lists cannot.

What remains true is that a capability and a category answer different questions, and someone may
hold a capability on a resource's open portion while reaching none of its restricted records. That is
preserved by pairing, since open content is itself a category: holding `download` on `open` and only
`view` on `controlled` says exactly that. No resource-level slot is needed, and adding one would
reintroduce the baseline that additive rendering exists to do without.

Whether the originating role name travels alongside the permissions is a separate and smaller
question. It is not needed for enforcement, and audit events are emitted by the controller, which
knows the role already, so the default should be to leave it out rather than to carry two
representations that can disagree.

## What this closes or reshapes

| Item | Effect |
|---|---|
| Role capabilities (open item) | Becomes concrete: define the permission vocabulary, then the role-to-permission assignment. It stops being an open-ended question about what roles mean |
| The create/read/update/delete gap | Closed by the same work: these are stage one's permissions |
| Single `role` field against union semantics | Resolved. The contradiction exists only because roles are carried instead of permissions |
| `public` synthetic role | Becomes a permission set, and stops needing a prose exception in the token schema |
| Write versus read access | Informed but not settled. A submitter holds `create`; whether that implies read, and scoped to what, remains the separate decision |

## What it does not solve

**Provenance scoping.** Restricting a submitter to the records they submitted is an object-identity
question, not a permission question. It still needs either a two-level resource relationship or
record-level enforcement.

**Session attributes.** RABAC includes them and Usher uses none. The time-limited admin self-grant
is the closest thing to a session-scoped constraint here, and it is handled in the admin model
rather than in the token. Not needed for MVP; worth knowing the source model has the concept if a
time-of-day or connection-origin constraint is ever wanted.

**Role hierarchies.** RABAC preserves them from NIST RBAC. Usher deliberately does not have them,
treating roles as a flat set whose effective permissions are a union. That is a considered
deviation rather than an oversight, and it survives this change intact: a union of permission sets
is well defined without any hierarchy to resolve.
