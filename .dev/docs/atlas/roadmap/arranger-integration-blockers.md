# Arranger integration: blocking items

Eleven items surfaced by preparing the first plugin integration. They are recorded here rather
than in the integration's own repository because each one is a question about Usher's model, a
decision only the developer can take, or an answer a deployment owes; none is waiting on plugin
work. Per-deployment specifics belong in that integration's own repository, following the same
split the migration item already uses.

Grouped by what each is blocked on, because that is what decides who can move it.

## Blocked on Usher's model

### 1. Saved-set identity, and the vocabulary that expresses it

The first adopter resolves saved sets with the requesting user's identity supplied as a query
argument, so the client asserts who it is and any caller can name any user. Correcting it needs
an identity source the search service does not have, which is what Usher supplies.

The tiered shape to express: own sets by default, an administrator able to list across users and
filter by user id, and no reliance on a set identifier being unguessable. Two further parts of
the fix are plugin-side and already unblocked, but both change behaviour for existing
deployments, so they are held for a deployment decision rather than for design.

**This item is a cycle and should be recorded as one rather than left to resolve itself.** The
integration lists it as a prerequisite *for* Usher, while its central fix depends *on* Usher. The
order that breaks the cycle is Usher publishing the vocabulary first, since the plugin can gate
and cap without it but cannot scope per principal without it.

**A constraint that bounds what any of this buys.** A consumer that materializes a set into a
durable artifact creates a new access boundary that inherits nothing from the one the set was
resolved under. Per-principal scoping of sets therefore cannot deliver an end-to-end property on
its own, and claiming it would be the stronger error. See the derived-artifact ceiling in
`.dev/design/permissions-model.md`.

### 2. The audit event shape has to exist before enforcement does

The event shape must be defined before any enforcement path emits, with the subject field present
and null where there is no authenticated principal. Populating it afterwards is a schema
migration rather than an addition, which is why this item's cost grows by waiting rather than
staying flat.

What a plugin cannot decide alone is the destination. Correlating an authorization decision across
two systems requires the subject identifier to match whatever Usher aggregates on, so the
correlation key is part of the contract and not an implementation choice. Denial events and
administrator-bypass events both need somewhere to land, and a bypass that produces no audit
trail is not an acceptable production state.

Event catalogue and common fields are in `.dev/design/audit-events.md`; what is missing there is
the cross-system correlation key and the pre-enforcement ordering requirement.

### 3. Widening the enforcement seam

Deny is already expressible, and an empty result set is structurally ambiguous between "no such
resource" and "no access to it", which is the property to keep rather than the one to fix.

What the current signature cannot carry is the difference between a requester with **no
relationship** to a resource and one holding a **lapsed or insufficient** grant. Ambiguity buys
nothing in the second case and costs support load, which is the calibration already recorded in
`.dev/design/permissions-model.md`: ambiguous outward, precise inward. A status code is an
implementation detail of the second case rather than the goal of it.

So the open question is whether the bridge-to-plugin result grows a reason the plugin may act on,
and if so which reasons are safe to expose to a requester who may not hold the resource at all.

### 4. An unconfigured resource value fails closed on records and open on artifacts

The sharpest live hazard, and it is a defect in the ceiling mechanism rather than in the plugin.

One unconfigured value, two opposite outcomes:

| Where the value appears | Mechanism | Direction |
|---|---|---|
| In a record's resource field | Excluded by the positive `in` clause, which lists only configured resources | Fails **closed** |
| In a derived artifact's provenance | Absent from the complement, which is computed as configured resources minus held resources, so the ceiling clause does not exclude the artifact | Fails **open** |

The design already states that over-inclusion of the complement is harmless and under-inclusion is
not. An unconfigured value is precisely under-inclusion, arriving through the config rather than
through a computation error, which is why the stated rule did not catch it.

**The reason this is dangerous beyond its severity:** an implementer who has verified that records
carrying an unconfigured value are invisible has verified nothing about artifacts, and now has
positive reason to believe the opposite of what is true. The plugin's fixture pins the ceiling
clause's polarity; the unmapped case needs a conformance case, since a unit test written against
the mechanism cannot see a value the mechanism was never given.

## Blocked on a developer decision

### 5. Federation posture

Whether a deployment holding grants should federate at all, given that a remote cannot be
compelled to enforce. Federation forwards the filter; a remote that ignores it applies nothing,
and does so indistinguishably from one that applied it and matched everything. Still described
rather than steered.

### 6. Nested-filter reconciliation

**Unreachable under the settled enforcement shape**, since the emitted filter is a single clause and
a single clause has no siblings to compose. Recorded because it returns with record-level narrowing,
which is what would reintroduce depth-two authorization fields.

Which mechanism owns filtering at aggregation depth two, and whether the composition is intended
as `should` or `must`. The record path is pinned as correct, with siblings composing as `must`,
verified by execution. The defect is on the aggregation path.

This is a plugin-side defect rather than Usher work, tracked here because an authorization
predicate composed as `should` where `must` was intended is an over-disclosure, which makes it a
correctness dependency of the enforcement contract rather than someone else's bug.

## Blocked on a deployment's answer

### 7. Authorization-field nesting depth

**Not triggered by the first deployment**, whose resource keys are flat and at depth one in both
catalogues. It stays a hard blocker for any deployment whose key is deeper, which is what the
startup check below exists to catch.

A hard blocker rather than a sequencing item. If a deployment's authorization field sits at depth
two or deeper, the plugin's filtered-aggregation path does not apply there and filtering falls
back to a disjunctive path, which for an authorization predicate is OR where AND was intended.
The adopter's own fixtures carry both shapes, so this is a live condition rather than a
hypothetical one.

Generalizable consequence, independent of any deployment: **the plugin must establish the
authorization field's mapping shape at startup and refuse to enforce where it cannot**, on the
same reasoning as the `nested` mapping requirement for record-level narrowing. Usher cannot
require a mapping shape, so a deployment that does not supply a conforming one is a deployment
where this narrowing is unavailable, not one where it silently degrades.

### 8. IdP claim shape, and the version it depends on

The claim shape reaching the plugin's request context depends on the identity provider version a
deployment upgrades to, not the one it runs now. Where a deployment is several major versions
behind its target, that upgrade is a prerequisite of the authorization work rather than a
follow-up to it, because pinning a claim shape against the current version produces a contract
that expires on upgrade.

## Open, with no owner yet

### 9. Anonymous access and "no restriction configured" compile to the same value

Two different states currently render identically, and the documented pattern for an
unauthenticated request returns no filter at all. No filter is not a restrictive default: it is
the allow-everything case, which is the same empty-combination hazard already recorded in
`.dev/design/decisions.md` arriving through a different door.

Whatever encoding is chosen, an unauthenticated request and a request against an unrestricted
resource have to be distinguishable, and neither may render to an absent filter.

### 10. Category-to-field mapping format

Whatever shape is chosen must make the empty and missing cases either unrepresentable or loud. A
field name plus a match value can be validated at startup against the live mapping; an arbitrary
query fragment cannot, because validating it means evaluating it. This is a decision about what
can be checked before serving traffic, not a preference about expressiveness.

### 11. Where a plugin learns that a principal is an administrator

Whether administrator status comes from Usher's own role, from plugin-side configuration, or from
the platform access model, and whether an administrator of the adopting application and an
administrator of Usher are the same principal at all. Bears directly on the bypass audit
requirement in item 2, since a bypass cannot be logged as such until its source is defined.
