# Arranger integration: blocking items

These items surfaced by preparing the first adapter integration. They belong here rather than in
the integration's own repository because each one is a question about Usher's model, a decision for
the developer alone, or an answer owed by an instance; none is waiting on adapter work. Per-instance
specifics belong in that integration's own repository, following the same split as the import
item.

Grouped by what each is blocked on, because that is what decides who can move it.

## Blocked on Usher's model

### 1. Saved-set identity, and the vocabulary that expresses it

A saved set resolves for the identity the server establishes for the request, never for one the
client supplies. That needs an identity source: the search service has none, and Usher supplies one.

The tiered shape to express: own sets by default, an administrator able to list across users and
filter by user id, and no reliance on a set identifier being unguessable. Two further parts of
the fix are adapter-side and already unblocked, but both change behaviour for existing
instances, so they are held for an instance decision rather than for design.

**This item is a cycle and should be recorded as one rather than left to resolve itself.** The
integration lists it as a prerequisite _for_ Usher, while its central fix depends _on_ Usher. The
order that breaks the cycle is Usher publishing the vocabulary first, since the adapter can gate
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
person may see, when they ask. A file has neither of those: it has whoever opens it,
whenever they open it. So enforcement did not get weaker at step 4. Enforcement of this kind does not
reach step 4 at all, because what it needs to run is not there. A file is protected by where it is
kept, which is a different mechanism, and no amount of correctness in step 2 improves it.

So fixing set identity is worth doing and does not deliver an end-to-end property. Saying that it
does would be worse than leaving it unfixed, because nobody checks a protection believed to hold.
See the ceiling on records taken out of a resource, in `.dev/design/permissions-model.md`.

### 2. The audit event shape has to exist before enforcement does

The event shape must be defined before any enforcement path emits, with the principal field present
and null where there is no authenticated principal. Populating it afterwards is a schema
migration rather than an addition, which is why this item's cost grows by waiting rather than
staying flat.

What an adapter cannot decide alone is the destination. Correlating an access decision across
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
grant that is not live puts nothing in the token, so those two arrive looking identical and no adapter can tell them
apart. See "A refusal carries no
exception, and expiry is announced rather than inferred" in `.dev/design/decisions.md`. A status code
is an implementation detail of the first case rather than the goal of it.

So the open question is whether the Bridge-to-adapter result grows to give the adapter an actionable
reason, and if so which reasons are safe to expose to a principal who may not hold the resource at
all.

## Blocked on a developer decision

### 4. Federation posture

Whether an instance holding grants should federate at all, given that a remote cannot be
compelled to enforce. Federation forwards the filter; a remote that ignores it applies nothing,
and does so indistinguishably from one that applied it and matched everything. Still described
rather than steered.

### 5. Nested-filter reconciliation

**Unreachable under the settled enforcement shape**, since the emitted filter is a single clause and
a single clause has no siblings to compose. Recorded because it returns with record-level narrowing,
which is what would reintroduce depth-two authorization fields.

Which mechanism owns filtering at aggregation depth two, and whether the composition is intended
as `should` or `must`. The record path is pinned as correct, with siblings composing as `must`,
verified by execution. The defect is on the aggregation path.

This is an adapter-side defect rather than Usher work, tracked here because an authorization
predicate composed as `should` where `must` was intended is an over-disclosure, which makes it a
correctness dependency of the enforcement contract rather than someone else's bug.

## Blocked on an instance's answer

### 6. Authorization-field nesting depth

**Not triggered by the first instance**, whose resource fields are flat and at depth one in both
catalogues. It stays a hard blocker for any instance whose key is deeper, which is what the
startup check below exists to catch.

A hard blocker rather than a sequencing item. If an instance's authorization field sits at depth
two or deeper, the adapter's filtered-aggregation path does not apply there and filtering falls
back to a disjunctive path, which for an authorization predicate is OR where AND was intended.
The application's own fixtures carry both shapes, so this is a live condition rather than a
hypothetical one.

Generalizable consequence, independent of any instance: **the adapter must establish the
authorization field's mapping shape at startup and refuse to enforce where it cannot**, on the
same reasoning as the `nested` mapping requirement for record-level narrowing. Usher cannot
require a mapping shape, so an instance that does not supply a conforming one is an instance
where this narrowing is unavailable, not one where it silently degrades.

### 7. IdP claim shape, and the version it depends on

The claim shape reaching the adapter's request context depends on the instance's target identity
provider version, not the one it runs now. Where an instance is several major versions
behind its target, that upgrade is a prerequisite of the authorization work rather than a
follow-up to it, because pinning a claim shape against the current version produces a contract
that expires on upgrade.

## Open, with no owner yet

### 8. Where an adapter learns that a principal is an administrator

Whether administrator status comes from Usher's own role, from adapter-side configuration, or from
the platform access model, and whether an administrator of the ushered application and an
administrator of Usher are the same principal at all. Bears directly on the bypass audit
requirement in item 2, since a bypass cannot be logged as such until its source is defined.
