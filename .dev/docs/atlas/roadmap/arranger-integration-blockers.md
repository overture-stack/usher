# Arranger integration: blocking items

Eleven items surfaced by preparing the first plugin integration. They are recorded here rather
than in the integration's own repository because each one is a question about Usher's model, a
decision only the developer can take, or an answer an instance owes; none is waiting on plugin
work. Per-instance specifics belong in that integration's own repository, following the same
split the migration item already uses.

Grouped by what each is blocked on, because that is what decides who can move it.

## Blocked on Usher's model

### 1. Saved-set identity, and the vocabulary that expresses it

The first application resolves saved sets with the requesting user's identity supplied as a query
argument, so the client asserts who it is and any principal can name any user. Correcting it needs
an identity source the search service does not have, which is what Usher supplies.

The tiered shape to express: own sets by default, an administrator able to list across users and
filter by user id, and no reliance on a set identifier being unguessable. Two further parts of
the fix are plugin-side and already unblocked, but both change behaviour for existing
instances, so they are held for an instance decision rather than for design.

**This item is a cycle and should be recorded as one rather than left to resolve itself.** The
integration lists it as a prerequisite *for* Usher, while its central fix depends *on* Usher. The
order that breaks the cycle is Usher publishing the vocabulary first, since the plugin can gate
and cap without it but cannot scope per principal without it.

**A constraint that bounds what any of this achieves.** Scoping sets per principal does not follow the
records out of the search service. Walked through:

1. A researcher assembles a saved set, which is a list of the records they picked.
2. They ask for it, and the search service turns that list into actual records. This is the step
   that checks what they are allowed to see, against the grants they hold at that moment.
3. They export the result to a file.
4. That file is now reachable by whoever can reach where it was put: a shared drive, an attachment,
   a link. Nothing runs step 2 again.

**Step 2 is a check on a request. A file is not a request.** The check works out what one named
person may see, at the moment they ask. A file has neither of those: it has whoever opens it,
whenever they open it. So enforcement did not get weaker at step 4. Enforcement of this kind does not
reach step 4 at all, because what it needs to run is not there. A file is protected by where it is
kept, which is a different mechanism, and no amount of correctness in step 2 improves it.

So fixing set identity is worth doing and does not deliver an end-to-end property. Saying that it
does would be worse than leaving it unfixed, because a protection believed to hold is one nobody
checks. See the ceiling on records taken out of a resource, in
`.dev/design/permissions-model.md`.

### 2. The audit event shape has to exist before enforcement does

The event shape must be defined before any enforcement path emits, with the principal field present
and null where there is no authenticated principal. Populating it afterwards is a schema
migration rather than an addition, which is why this item's cost grows by waiting rather than
staying flat.

What a plugin cannot decide alone is the destination. Correlating an access decision across
two systems requires the principal identifier to match whatever Usher aggregates on, so the
correlation key is part of the contract and not an implementation choice. Denial events and
administrator-bypass events both need somewhere to land, and a bypass that produces no audit
trail is not an acceptable production state.

The events and their common fields are in `.dev/design/audit-events.md`; what is missing there is
the cross-system correlation key and the pre-enforcement ordering requirement.

### 3. Widening the enforcement seam

Deny is already expressible, and an empty result set is structurally ambiguous between "no such
resource" and "no access to it", which is the property to keep rather than the one to fix.

What the current signature cannot carry, and should, is the difference between an empty result and a
refusal for a principal who holds a live grant. That one is worth carrying and is detectable, since a
live grant is in the token.

The difference it must not try to carry is between a stranger and the holder of a lapsed grant. A
grant that is not live puts nothing in the token, so those two arrive looking identical, and an
earlier version of this item asked for a distinction no plugin can make. See "A refusal carries no
exception, and expiry is announced rather than inferred" in `.dev/design/decisions.md`. A status code
is an implementation detail of the first case rather than the goal of it.

So the open question is whether the bridge-to-plugin result grows a reason the plugin may act on,
and if so which reasons are safe to expose to a principal who may not hold the resource at all.

### 4. An unconfigured resource value fails closed on records and open on artifacts

**Resolved in the design.** The value is refused at the moment data is assembled rather than filtered at query time, because a filter cannot ask whether a value is absent from a list it was never given. See "The two permissive failures are closed" in `.dev/design/decisions.md`. The analysis below is kept because the asymmetry it describes is what makes the resolution necessary.

The sharpest hazard found, and it is a defect in the ceiling mechanism rather than in the plugin.

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

Whether an instance holding grants should federate at all, given that a remote cannot be
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

## Blocked on an instance's answer

### 7. Authorization-field nesting depth

**Not triggered by the first instance**, whose resource fields are flat and at depth one in both
catalogues. It stays a hard blocker for any instance whose key is deeper, which is what the
startup check below exists to catch.

A hard blocker rather than a sequencing item. If an instance's authorization field sits at depth
two or deeper, the plugin's filtered-aggregation path does not apply there and filtering falls
back to a disjunctive path, which for an authorization predicate is OR where AND was intended.
The application's own fixtures carry both shapes, so this is a live condition rather than a
hypothetical one.

Generalizable consequence, independent of any instance: **the plugin must establish the
authorization field's mapping shape at startup and refuse to enforce where it cannot**, on the
same reasoning as the `nested` mapping requirement for record-level narrowing. Usher cannot
require a mapping shape, so an instance that does not supply a conforming one is an instance
where this narrowing is unavailable, not one where it silently degrades.

### 8. IdP claim shape, and the version it depends on

The claim shape reaching the plugin's request context depends on the identity provider version a
instance upgrades to, not the one it runs now. Where an instance is several major versions
behind its target, that upgrade is a prerequisite of the authorization work rather than a
follow-up to it, because pinning a claim shape against the current version produces a contract
that expires on upgrade.

## Open, with no owner yet

### 9. Anonymous access and "no restriction configured" compile to the same value

**Resolved in the design.** Neither state may render to an absent filter; both render to an explicit positive `in`, which is the only fail-closed encoding available. See "The two permissive failures are closed" in `.dev/design/decisions.md`.

Two different states rendered identically, and the documented pattern for an
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
the platform access model, and whether an administrator of the ushered application and an
administrator of Usher are the same principal at all. Bears directly on the bypass audit
requirement in item 2, since a bypass cannot be logged as such until its source is defined.
