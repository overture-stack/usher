# Audit Events

All events are emitted as structured JSON, following the **CloudEvents** specification so that one
shape works as a log line today and as a message on a broker later, without translation.

## The envelope

Every entry from every Overture service carries the same context attributes. These are CloudEvents'
own, and their names are fixed by that specification, which restricts attribute names to lower-case
letters and digits. That is why none of them carry an underscore.

| Attribute     | Required | Description                                                              |
| ------------- | -------- | ------------------------------------------------------------------------ |
| `specversion` | yes      | The CloudEvents version this entry conforms to                           |
| `id`          | yes      | Identifies this entry, unique per source                                 |
| `source`      | yes      | Which deployment emitted it, as a URI reference. One per deployment, never per replica |
| `type`        | yes      | What happened, from the table below, carrying the `bio.overture.` prefix  |
| `time`        | yes here | When it happened. RFC 3339, UTC with `Z`, seconds always present          |
| `dataschema`  | optional | Names which definition of `data` applies, where one is published         |

`source` is what makes a complete audit trail possible: a health data access event needs Usher's
entry correlated with the consuming application's, and each says where it came from without anyone
parsing a name to find out.

**`time` is narrowed twice beyond requiring it**, and only one of the two narrowings restates the
standard rather than tightening it. **UTC with
the `Z` designator, never a numeric offset**: RFC 3339 permits `+05:00`, so this is a real narrowing.
A corpus carrying mixed offsets cannot be ordered without resolving every entry first, and
cross-service ordering is the whole purpose of a correlated trail. Two records written minutes apart
can appear a day apart when each writer picks its own frame, and neither value looks wrong on
inspection. **Seconds always present**, which RFC 3339's `full-time` already requires, written down
because truncating to minutes is an ordinary formatting convenience elsewhere and would collapse the
ordering of everything inside one minute. Fractional seconds are permitted and not required.

## The payload

Everything else lives in `data`, where the CloudEvents restriction on names does not apply and
**property names are camelCase**, matching the Usher token's `generatedAt` rather than the policy
store's columns: `data` is JSON on the wire, and nothing about it is a database identifier. **Each
entity defines its own property names.** The `token` entity has `tokenTtl` and `grantCount`; the
`grant` entity has none of those. A reader who knows the entity knows what the payload can contain,
and `dataschema` names the definition where one is published.

These properties recur across entities:

| Property    | Applies to | Description                                                            |
| ----------- | ---------- | ----------------------------------------------------------------------- |
| `actorId`  | all        | Who triggered it, as the identity provider's `sub`. `null` where `actorType` says there is nobody |
| `sourceIp` | API-initiated events | Origin IP; omit for system-generated events                   |
| `result`    | actions only | `succeeded`, `denied` (the actor lacked authority), or `failed`         |
| `actorType` | all        | `human`, `serviceAccount`, `anonymous` or `system`. Not derivable from `actorId`, whose format is the same for the first two and absent for the last two, and alerting needs to tell them apart |

**`actorId` carries the identity provider's `sub`, which is what makes it correlate.** A correlation
key has to be producible by every service that correlates on it, and `sub` is the only identifier
every ushered application holds, since the Usher token carries it. Usher's `users.id` satisfies this
because it holds the subject itself rather than a surrogate, recorded under user identifier
discipline in `permissions-model.md`. Had it been an internal surrogate instead, no other service
could have produced it and `actorId` would correlate with nothing.

That it holds by design rather than by coincidence is the part worth recording, because the two look
identical right up until someone changes one of them.

**`actorId` is always derived from the token by whichever service emits the event, and is never
taken from the request.** Stating it because a neighbouring field elsewhere on the platform is the
opposite: Arranger's `saveSet` mutation takes a `userId` argument supplied by the client and persists
it as the set's owner. That field and this one are not two names for one thing. They have opposite
trust properties, and the mistake a shared name would invite is reading a client-asserted value as an
audit identity. Different names because different provenance, and neither is renamed into the other.

**`actorType` has four values because `actorId` has two ways of being absent**, and they are not the
same fact. A system-triggered event has nobody behind it. An anonymous request has somebody behind it
whose identity was never established, since an unauthenticated request still receives a token so that
open access is audited like everything else. Collapsing both into a null `actorId` under a type that
claims a person loses the distinction in the direction that misleads: an empty identifier paired with
`human` reads as a known person whose id failed to record. Asserting the absence also keeps anonymous
access countable, which is what answers how much open access a deployment actually serves.

**Every replica of one Usher deployment emits the same `source`, and instance attribution goes in
`data`.** The spec makes `source` + `id` the uniqueness key that deduplication depends on, and says a
source may include more than one producer, so a source is the context an event happened in rather
than the process that emitted it. Usher is planned as stateless replicas sharing one policy database.
Giving each replica its own source would put one logical occurrence under two keys, and deduplication
would not catch it. Which replica served a request is still worth recording; it belongs beside the
other domain detail, where it does not enter the key.

**`system` is not an afterthought value, and the first event on the platform is likely to be one.** A
catalogue-load check runs on nothing a principal did, so the first structured event an ushered
application emits carries `actorType: system` and no `actorId` at all. That is worth having rather
than awkward: the envelope gets exercised from the beginning on the case with no actor, so absence
handling has to be right before anything carrying a real principal is ever emitted. The usual order
is the reverse, a shape designed around the populated case with absence bolted on by whoever first
hits it, which is how an empty string ends up where a null belongs.

## Alerting happens through recording, and four events already work that way

Usher does not hold alerting rules or send notifications. It emits events rich enough that rules can
be written against them elsewhere, and severity is what lets a destination route on an event without
parsing its payload. That is the separation the envelope exists for, and it is also what A09 asks
for once its name changed from monitoring to alerting: recording that nobody evaluates is the failure
the category describes.

**Most conditions are rules over the stream and belong downstream.** Repeated denials for one
principal, a spike in grants to one resource, access at an unusual hour: all of those are visible in
what is already recorded, and encoding them here would put policy in the wrong service and freeze it
at release time.

**A condition only Usher can see becomes an event of its own type**, and that is the whole of the
in-process detection. Four exist:

| Event | What it detects | Why it cannot be a downstream rule |
|---|---|---|
| `grant.rateExceeded` | one actor's grant operations crossing a threshold in a rolling window | the count is shared state across instances, so no single event stream carries it |
| `grant.unguarded` | a grant taking effect with no custodian to approve it | requires knowing the category had no custodian at that moment |
| `resource.orphaned` | a resource left with no owner | a state reached by a deletion elsewhere, not an action anyone performed |
| `revocationChannel.modeChange` | the channel going quiet and the bridge raising | the absence of events, which no rule over present events can see |

**The last one is the general case worth stating: silence.** Every other condition is a pattern in
what arrived, and a downstream rule can find it. A channel that stops carries no event to match, so
something has to notice that nothing came, and only the component expecting it can.

**What this leaves genuinely undefined is operational rather than structural.** Severity is assigned
per event and routes without payload parsing, the conditions above are detected and emitted, and the
rules over the stream are a deployment's to write. What is missing is the response commitment per
severity, which is an operations question and is recorded in the open items below.

## The shape of a type

    bio.overture.<entity>.<action>

    bio.overture.grant.creation
    bio.overture.token.exchange
    bio.overture.access.denied

**The prefix is the organization and nothing else.** No service segment: `source` already says which
service emitted an event, and encoding it again in `type` says the same thing twice while still
failing at the thing a segment is supposed to do. Two services both emitting `access.denied` under
their own segments are two names for what a reader has to treat as one kind of occurrence; what
actually separates Usher denying a grant from an ushered application denying a query is the entity,
so `grant.denied` and `query.denied` do the work no segment could.

**The entity carries the discrimination, which makes entity names a platform commitment rather than a
local one.** A flat vocabulary under one organization means two services must not mean different
things by one entity, and nothing arbitrates that today. `set` already means a saved set in one
application and could mean something else elsewhere. That commitment is named among the owed items
below rather than assumed.

**Never mix `.` and `_` inside a type.** Metrics systems normalize one separator to the other, so a
type written `grant.bulk_operation` collides with one written `grant_bulk_operation`. Dots separate
the segments; a segment is one word.

**No word is both an entity and an action.** `revocation` was: an act in `grant.revocation` and
`identity.revocation`, and an entity in what is now `revocationChannel.modeChange`. A reader meeting
the word in one position carries the wrong meaning into the other, and the two segments are the only
thing distinguishing them. The fix is to name the entity precisely, which the channel is, rather than
to borrow the action's noun. This is also the first constraint on the shared entity vocabulary the
platform owes: the same word landing in both positions across two services is the same defect with
nobody in a position to see it.

**Two families of event, distinguished by whether anyone acted.**

An **action** is something a person or service did, and it can be refused, so it carries `result`. A
grant created, a resource registered, ownership transferred. An **observation** is something the
system noticed, with no actor and no outcome to report: a threshold crossed, a resource left without
an owner, the revocation channel changing mode. Observations carry no `result`, because there was
nothing to succeed at.

## Events and the permissions that produce them

**An event type and the permission whose exercise produces it share an entity segment and differ
only verb to noun.**

    grant.create        produces    grant.creation
    grant.revoke        produces    grant.revocation
    ownership.transfer  produces    ownership.transfer

Both vocabularies use the same `entity.action` shape, both are unbuilt, and they will be written at
different times by different people. So the correspondence is stated rather than left to care: a
reader holding one should be able to predict the other, and an event with no permission behind it, or
a permission that emits nothing, is a gap in one of the two lists. See
[rabac-alignment.md](../docs/atlas/roadmap/rabac-alignment.md) for the permission vocabularies.

## A note on vocabulary

The event model is its own vocabulary and does not inherit the policy model's. CloudEvents defines an
optional `subject` attribute meaning the specific thing within a source that an event concerns. That
is not the `sub` claim, which is what `subject` means everywhere else in this project. Usher does not
currently use the CloudEvents attribute; if it ever does, it is the events vocabulary's word, not the
policy model's.

**Constraints:** Log entries must never contain the Usher token payload, raw bearer tokens, or
health record identifiers. See [security-threat-model.md](security-threat-model.md) § A09.

**Log levels:** the severity column maps directly to log levels: `info` is routine (nothing to
see here), `warning` is anomalous and worth reviewing, `critical` demands immediate attention.

---

## Scope

Usher logs **who holds what grants, and when that changes.** It has no
visibility into whether a token was used, what query was run, or what records were returned.
Enforcement happens at the plugin in each consuming application (Arranger, Stage, and so on), which
applies a decision the controller already made, and logging what it applied is that application's
responsibility.

A complete audit trail for a health data access event requires correlating two log sources:
Usher (permission in place) and the consuming app (permission exercised). Neither alone is
sufficient for full forensic reconstruction. See [plugin-integration.md](plugin-integration.md)
for the access-decision logging requirements consuming apps must implement.

**Every control-plane capability pairs with an event here, and no data-plane capability does.** That
asymmetry is structural rather than an omission, and it is worth stating because it otherwise reads
as a gap in the table below and invites someone to close it by inventing `record.readSucceeded`.

| | Who may perform it | Who records that it happened |
|---|---|---|
| A control-plane capability, such as `grant.create` | someone acting against Usher's own API | **Usher**, as an event in this document |
| A data-plane capability, such as `record.read` | someone acting against an ushered application | **that application**, in its own log |

Usher never observes a read, so it cannot record one. What it records is the decision, at the token
exchange, and the token exchange is the only Usher event a data-plane capability produces. The
application records the exercise, and the two correlate through `actorId`, which is the identity
provider's `sub` and therefore producible by both.

**Two consequences follow.** An ushered application that logs nothing leaves half the trail missing
and Usher cannot detect that, which is why the requirement sits in the plugin contract rather than
here. And the verb-to-noun pairing below is a control-plane rule: applying it to the data plane
produces events Usher has no way to emit.

---

## Events

**The first column is the entity and action, not the emitted type.** Every one carries the
`bio.overture.` prefix on the wire, so `grant.creation` below is emitted as
`bio.overture.grant.creation`. The prefix is omitted here because it is invariant and repeating it
thirty times obscures the part that differs.

| Event type                   | Description                                                                                | Actor              | Affected entity            | Additional required fields                                                                                                    | Severity         |
| ---------------------------- | ------------------------------------------------------------------------------------------ | ------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `token.exchange`        | Usher token issued to a user, or refused                                                  | User               | Usher token               | `userId`, `result`; on success `tokenTtl` and `grantCount` (the number of grants, never their values); on refusal `reason` | follows `result` |
| `invitation.creation`        | Access invitation sent to an address with no account yet                                   | Custodian or admin | Email address + category + resource | `actorId`, `email`, `resourceId`, `category`, `invitationId`, `expiresAt`                                                   | `info`           |
| `invitation.claim`           | An account confirmed an invitation; the grants it promised were created                    | User               | Principal + the grants created | `actorId`, `invitationId`, `email`, `grantIds`                                                                          | `info`           |
| `invitation.lapse`           | An invitation expired unclaimed, so the grants it promised were never created              | System             | Email address + category + resource | `invitationId`, `email`, `resourceId`, `category`                                                                   | `info`           |
| `grant.creation`             | Category grant created for a user                                                          | Custodian          | User + category + resource | `custodianId`, `granteeId`, `resourceId`, `category`, `grantId`                                                           | `info`           |
| `grant.selfCreation`         | An admin created a grant for themselves, through the endpoint that requires a TTL          | Admin              | The admin + category + resource | `actorId`, `resourceId`, `category`, `grantId`, `expiresAt`                                                          | `warning`        |
| `grant.extension`            | A grant's end moved later                                                                  | Custodian or owner | Category grant             | `userId`, `resourceId`, `categoryId`, `endBefore`, `endAfter`                                                                  | `info`           |
| `grant.reduction`            | A grant's end moved earlier, and remains in the future                                     | Custodian or owner | Category grant             | `userId`, `resourceId`, `categoryId`, `endBefore`, `endAfter`                                                                  | `warning`        |
| `grant.revocation`           | Category grant revoked                                                                     | Custodian or admin | User + category + resource | `actorId`, `granteeId`, `resourceId`, `category`, `grantId`, `reason`                                                     | `info`           |
| `grant.rateExceeded`          | Grant operations by a single actor exceed the configured threshold within a rolling window | Custodian or admin | Multiple                   | `actorId`, `operationCount`, `windowSeconds`                                                                               | `warning`        |
| `identity.revocation`        | User identity flagged as compromised; all active grants revoked                            | Admin              | User                       | `adminId`, `revokedUserId`, `scope`                                                                                        | `critical`       |
| `resource.registration`      | Study or cohort registered                                                                 | Admin or submitter | Resource                   | `actorId`, `resourceId`, `fieldName`, `fieldValue`, `initialOwnerId`                                                    | `info`           |
| `ownership.transfer`         | Resource ownership transferred                                                             | Owner or admin     | Resource                   | `actorId`, `fromOwnerId`, `toOwnerId`, `resourceId`                                                                     | `info`           |
| `resource.orphaned`          | Resource has no owner; admin notified                                                      | System             | Resource                   | `resourceId`, `lastOwnerId`, `triggerEventType`                                                                          | `critical`       |
| `resource.visibilityChange` | Resource hidden or restored due to ownership state                                         | System or admin    | Resource                   | `actorId`, `resourceId`, `fromState`, `toState`, `reason`                                                                 | `warning`        |
| `custodianship.assignment`   | Custodian role assigned to a user for a category within a resource                         | Owner or admin     | User + category + resource | `actorId`, `custodianId`, `resourceId`, `category`                                                                         | `info`           |
| `custodianship.removal`      | Custodian role removed from a user                                                         | Owner or admin     | User + category + resource | `actorId`, `custodianId`, `resourceId`, `category`                                                                         | `info`           |
| `grant.unguarded`            | A grant took effect without a custodian's decision because the category had none assigned  |                    |                            |                                                                                                                               |                  |
| `admin.override`             | Admin performed an action that bypasses an instance config restriction                    | Admin              | Varies                     | `adminId`, `operation`, `configBypassed`, `resourceId`                                                                     | `critical`       |
| `revocationChannel.modeChange`     | Bridge moved between normal and revocation-uncertain: whether it can currently confirm its cached authorizations are still valid | System             | All active sessions        | `fromMode`, `toMode`, `reason`                                                                                              | `critical`       |

**An invitation ends two ways and they are different facts.** A claim says somebody took the access
offered; a lapse says nobody did. Collapsing them loses the second, which is the only record that an
offer was made and refused by inaction. Explicit refusal is already a grant state, `declined`, so
without `invitation.lapse` the model records the loud refusal and drops the quiet one.

**The claim event is also the only place the address and the principal appear together.** An
invitation is keyed by email and the grants it creates are keyed by subject, so this is what joins
them, and it is the last point at which the address is in the record before being discarded.

**Grant rate**, which `grant.rateExceeded` reports on, is how many grant operations one actor
performs within a set period: the `operationCount` and the `windowSeconds` in its payload. It is a
rate rather than a running total, so an actor who issues grants steadily over months never triggers
it while one who issues the same number in an afternoon does.

The period is a **rolling window**, measured backwards from each operation rather than reset on a
clock boundary. Ten operations spanning midnight count the same as ten within one hour, which is
what stops the signal being evaded by waiting for the hour to turn over.

This is the detection signal for a custodian acting at scale, whether compromised or acting in bad
faith. It reports and does not block: a custodian has the authority to issue every one of those
grants, so the event exists to make the pattern visible rather than to decide whether it was
legitimate.

---

## Open items

- Retention period per severity level: not yet defined. Health data contexts may impose statutory
  minimum retention. See [security-threat-model.md](security-threat-model.md) § A09.
- Alerting SLAs per severity level: not yet defined.
- **A `source` convention is owed, and is deliberately deferred.** `source` plus `id` is the key
  deduplication depends on, so an undisciplined `source` weakens deduplication whatever `type` looks
  like. The attribute must be a URI-reference with an absolute URI recommended, and nothing further
  is agreed: not how a deployment is identified within it, not whether it names a service or an
  endpoint. What is settled is the part the model needs, that one deployment is one source however
  it ends up spelled. The spelling is a logging concern, it is visible in the trail once events are
  flowing, and it does not gate the permissions model.
- **A shared entity vocabulary is owed, and only the flat type form owes it.** Two services meaning
  different things by one entity produces two occurrences under one name, and a consumer joins them.
  There is no registry and no owner. The failure is silent, which is why it is recorded as owed
  rather than left to discipline.
- `grantRateThreshold` configures when `grant.rateExceeded` fires, as an `operationCount` over
  a `windowSeconds`. The name is settled; both default values are not. Where the count is kept is a
  scaling question rather than a detail: see multi-instance propagation in
  [security-workflow.md](security-workflow.md#multi-instance-propagation).
- **The three custodianship entries are post-MVP**, arriving with community custodianship:
  `custodianship.assignment`, `custodianship.removal`, and `grant.unguarded`. Nothing emits them in
  the first release, because nothing assigns a custodian in it.
- **An event is owed for a resource's categories changing, and nothing emits one.** That write
  decides what every principal reaches and is the one the fast path watches, since it bumps the
  resource's category version. Its type waits on the same question as its capability: whether the
  authority sits with the resource's owner or the category's custodian decides whether it is
  `resource.categoryChange` or `category.association`. The event is owed whichever way that lands.
  See the capability vocabulary in [permissions-model.md](permissions-model.md).
- `grant.unguarded` needs its required fields settling, and needs deciding whether it is an event at
  all. It has no actor of its own: it happens as a consequence of a grant being created through a
  category nobody governs. As a separate entry it can go missing, and a creation logged without its
  companion reads as an ordinary grant, which is the wrong failure direction for the one thing this
  design already lets fail permissively. As a field on `grant.creation`, it cannot be omitted without
  omitting the creation. See [decisions.md](decisions.md) § Granting is one function, which contrasts
  this vacancy against a resource left without an owner and explains why the two resolve in opposite
  directions. The warning to that resource's owners is a separate delivery record and is not this
  event either way.
- The auto-promotion event is removed rather than renamed: the non-empty-owner invariant removes
  the case it recorded, so nothing will ever emit it.
- Ownership events still read as transfer between single owners. Ownership is a non-empty set, so
  adding and removing an owner are the primary operations and transfer is a compound of the two.
