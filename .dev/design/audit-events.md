# Audit Events

All events are emitted as structured JSON, following the **CloudEvents** specification so that one
shape works as a log line today and as a message on a broker later, without translation.

## The envelope

Every entry from every Overture service carries the same context attributes. These are CloudEvents'
own, and their names are fixed by that specification, which restricts attribute names to lower-case
letters and digits. That is why none of them carry an underscore.

| Attribute     | Required | Description                                                                            |
| ------------- | -------- | -------------------------------------------------------------------------------------- |
| `specversion` | yes      | The CloudEvents version this entry conforms to                                         |
| `id`          | yes      | Identifies this entry, unique per source                                               |
| `source`      | yes      | Which deployment emitted it, as a URI reference. One per deployment, never per replica |
| `type`        | yes      | What happened, from the table below, carrying the `bio.overture.` prefix               |
| `time`        | yes here | When it happened. RFC 3339, UTC with `Z`, seconds always present                       |
| `dataschema`  | optional | Names which definition of `data` applies, where one is published                       |

`source` is what makes a complete audit trail possible: a health data access event needs Usher's
entry correlated with the consuming application's, and each says where it came from without anyone
parsing a name to find out.

**`time` is narrowed twice beyond requiring it**, and only one of the two narrowings restates the
standard rather than tightening it. **UTC with
the `Z` designator, never a numeric offset**: RFC 3339 permits `+05:00`, so this is a real narrowing.
A corpus carrying mixed offsets cannot be ordered without resolving every entry first, and
cross-service ordering is the whole purpose of a correlated trail. Two records written minutes apart
can appear a day apart when each writer picks its own frame, and neither value looks wrong on
inspection. **Seconds always present**, already required by RFC 3339's `full-time`. Truncating to
minutes is an ordinary formatting convenience elsewhere and collapses the ordering of everything
inside one minute. Fractional seconds are permitted and not required.

## The payload

Everything else lives in `data`, where the CloudEvents restriction on names does not apply and
**property names are camelCase**, matching the Usher token's `generatedAt` rather than the policy
store's columns: `data` is JSON on the wire, and nothing about it is a database identifier. **Each
entity defines its own property names.** The `token` entity has `tokenTtl`, `grantCount` and `rules`; the
`grant` entity has none of those. A reader who knows the entity knows what the payload can contain,
and `dataschema` names the definition where one is published.

These properties recur across entities:

| Property    | Applies to              | Description                                                                                                                                                                                     |
| ----------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actorId`   | all                     | Who triggered it, as the identity provider's `sub`. `null` where `actorType` says there is nobody                                                                                               |
| `sourceIp`  | events a request caused | Origin IP of that request; omitted only when no request caused the event                                                                                                                        |
| `result`    | actions only            | `succeeded`; `denied`, the request refused for the actor's authority or its content; or `failed`, a fault in the controller or its configuration                                                |
| `actorType` | all                     | `human`, `serviceAccount`, `anonymous` or `system`. Not derivable from `actorId`, whose format is the same for the first two and absent for the last two, and alerting needs to tell them apart |

**`actorId` carries the identity provider's `sub`, which is what makes it correlate.** A correlation
key has to be producible by every service that correlates on it, and `sub` is the only identifier
held by every ushered application, since the Usher token carries it. Usher stores the subject with
its issuer, and `users.id`, Usher's own identifier, never appears in an event, since no other
service could produce it and `actorId` would then correlate with nothing; see user identifier
discipline in `permissions-model.md`. Once a second identity provider is supported, `actorId`
carries the issuer as well.

It holds by design rather than by coincidence, and the two look identical right up until someone
changes one of them.

**`actorId` is always derived from the token by whichever service emits the event, and is never
taken from the request.** A neighbouring field elsewhere on the platform is the
opposite: Arranger's `saveSet` mutation takes a `userId` argument supplied by the client and persists
it as the set's owner. That field and this one are not two names for one thing. They have opposite
trust properties, and a shared name would invite the mistake of reading a client-asserted value as
an audit identity. Different names because different provenance, and neither is renamed into the
other.

**`actorType` has four values because `actorId` has two ways of being absent**, and they are not the
same fact. A system-triggered event has nobody behind it. An anonymous request has somebody behind it
whose identity was never established, since an unauthenticated request still receives a token so that
open access is audited like everything else. Collapsing both into a null `actorId` under a type that
claims a person loses the distinction in the direction that misleads: an empty identifier paired with
`human` reads as a known person whose id failed to record. Asserting the absence also keeps anonymous
access countable, which is what answers how much open access a deployment actually serves.

**Every replica of one Usher deployment emits the same `source`, and instance attribution goes in
`data`.** The spec makes `source` + `id` the uniqueness key behind deduplication, and says a source
may include more than one producer, so a source is the context of an event rather than the process
that emitted it. Usher is planned as stateless replicas sharing one policy database.
Giving each replica its own source would put one logical occurrence under two keys, and deduplication
would not catch it. Which replica served a request still belongs in the event; it belongs beside the
other domain detail, where it does not enter the key.

**`system` is not an afterthought value, and the first event on the platform is likely to be one.** A
catalogue-load check runs without any action by a principal, so an ushered application's first
structured event carries `actorType: system` and no `actorId` at all. The envelope is therefore
exercised from the beginning on the case with no actor, so absence handling has to be right before
anything carrying a real principal is ever emitted. The usual order is the reverse, a shape
designed around the populated case with absence bolted on by whoever first hits it, which is how an
empty string ends up where a null belongs.

## Alerting happens through recording, and four events already work that way

Usher does not hold alerting rules or send notifications. It emits events rich enough that rules can
be written against them elsewhere, and severity is what lets a destination route on an event without
parsing its payload. The envelope exists for that separation, which is also what A09 asks for once
its name changed from monitoring to alerting: in the category's terms, recording without evaluation
is itself the failure.

**Most conditions are rules over the stream and belong downstream.** Repeated denials for one
principal, a spike in grants to one resource, access at an unusual hour: all of those are visible in
what is already recorded, and encoding them here would put policy in the wrong service and freeze it
at release time.

**A condition visible only to Usher becomes an event of its own type**, and that is the whole of the
in-process detection. Four exist:

| Event                          | What it detects                                                       | Why it cannot be a downstream rule                                               |
| ------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `grant.rateExceeded`           | one actor's grant operations crossing a threshold in a rolling window | the count is shared state across instances, so no single event stream carries it |
| `grant.unguarded`              | a grant taking effect with no custodian to approve it                 | requires knowing the category had no custodian at that moment                    |
| `resource.orphaned`            | a resource left with no owner                                         | a state reached by a deletion elsewhere, not anyone's action                     |
| `revocationChannel.modeChange` | the channel going quiet and the bridge raising                        | the absence of events, invisible to any rule over present events                 |

**The last one is the general case: silence.** Every other condition is a pattern in
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
failing at a segment's job. Two services both emitting `access.denied` under
their own segments are two names for what a reader has to treat as one kind of occurrence; what
actually separates Usher denying a grant from an ushered application denying a query is the entity,
so `grant.denied` and `query.denied` do what no segment could.

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
thing distinguishing them. The fix is to name the entity, the channel, precisely rather than to
borrow the action's noun. This is also the first constraint on the shared entity vocabulary owed by
the platform: the same word landing in both positions across two services is the same defect with
nobody in a position to see it.

**Two families of event, distinguished by whether anyone acted.**

An **action** is performed by a person or service, and it can be refused, so it carries `result`. A
grant created, a resource registered, ownership transferred. An **observation** is noticed by the
system, with no actor and no outcome to report: a threshold crossed, a resource left without
an owner, the revocation channel changing mode. Observations carry no `result`, because there was
nothing to succeed at.

## Events and the permissions that produce them

**An event type and the permission whose exercise produces it share an entity segment and differ
only verb to noun.**

    grant.create        produces    grant.creation
    grant.revoke        produces    grant.revocation
    ownership.transfer  produces    ownership.transfer

Both vocabularies use the same `entity.action` shape, both are unbuilt, and they will be written at
different times by different people. A reader holding one should be able to predict the other, and an event with no permission behind it,
or a permission that emits nothing, is a gap in one of the two lists. See
[rabac-alignment.md](../docs/atlas/roadmap/rabac-alignment.md) for the permission vocabularies.

## A note on vocabulary

The event model is its own vocabulary and does not inherit the policy model's. CloudEvents defines an
optional `subject` attribute, naming what an event concerns within its source. That is not the `sub`
claim, which is what `subject` means everywhere else in this project. Usher does not
currently use the CloudEvents attribute; if it ever does, it is the events vocabulary's word, not the
policy model's.

**Constraints:** Log entries must never contain the Usher token payload, raw bearer tokens, or
health record identifiers. See [security-threat-model.md](security-threat-model.md) § A09. An
event's `data` never carries a NUL character or an unpaired surrogate, which PostgreSQL's `jsonb`
refuses, so a request value that could reach it is refused at the request, with a code of its own,
before any transaction begins.

**Log levels:** the severity column maps directly to log levels: `info` is routine (nothing to
see here), `warning` is anomalous and worth reviewing, `error` is a fault that denied or withheld
something and needs fixing, `critical` demands immediate attention.

---

## Scope

Usher logs **who holds what grants, and when that changes.** It has no
visibility into whether a token was used, what query was run, or what records were returned.
Enforcement happens at the adapter in each consuming application (Arranger, Stage, and so on), which
applies a decision already made by the controller, and logging what it applied is that application's
responsibility.

A complete audit trail for a health data access event requires correlating two log sources:
Usher (permission in place) and the consuming app (permission exercised). Neither alone is
sufficient for full forensic reconstruction. See [adapter-integration.md](adapter-integration.md)
for consuming apps' access-decision logging requirements.

**Every control-plane capability pairs with an event here, and no data-plane capability does.** That
asymmetry is structural rather than an omission. Read as a gap it invites someone to close it by
inventing `record.readSucceeded`.

|                                                    | Who may perform it                            | Who records that it happened            |
| -------------------------------------------------- | --------------------------------------------- | --------------------------------------- |
| A control-plane capability, such as `grant.create` | someone acting against Usher's own API        | **Usher**, as an event in this document |
| A data-plane capability, such as `record.view`     | someone acting against an ushered application | **that application**, in its own log    |

Usher never observes a read, so it cannot record one. What it records is the decision, at the token
exchange, and the token exchange is the only Usher event produced by a data-plane capability. The
application records the exercise, and the two correlate through `actorId`, which is the identity
provider's `sub` and therefore producible by both.

**Two consequences follow.** An ushered application that logs nothing leaves half the trail missing
and Usher cannot detect that, which is why the requirement sits in the adapter contract rather than
here. And the verb-to-noun pairing below is a control-plane rule: applying it to the data plane
produces events beyond Usher's reach.

---

## Events

**The first column is the entity and action, not the emitted type.** Every one carries the
`bio.overture.` prefix on the wire, so `grant.creation` below is emitted as
`bio.overture.grant.creation`. The prefix is omitted here because it is invariant and repeating it
on every row obscures the part that differs.

| Event type                          | Description                                                                                                                                                                                                                                                                                                                                   | Actor                     | Affected entity                                          | Additional required fields                                                                                                                                                                                                                                                                                                   | Severity                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `token.exchange`                    | Usher token issued to a user, or refused                                                                                                                                                                                                                                                                                                      | User                      | Usher token                                              | `userId`, `result`; on success `tokenTtl`, `grantCount` (the count of grants, never their values), `rules` (the rules conferring grants), `audience` and `generatedAt`; on refusal `reason`, `refusedSubject` when the token verified, and `heldResourceCount` and `tokenBytes` when the token would exceed the response cap | follows `result`                                                  |
| `channelAssertion.rejection`        | Controller refused a bridge's channel assertion that verifies under its application's key, with its one `401`, naming the cause only in `reason`                                                                                                                                                                                              | System                    | Application                                              | `reason`, `applicationId`                                                                                                                                                                                                                                                                                                    | `warning`                                                         |
| `channelAssertion.rejectionTally`   | Controller refused bridges' channel assertions it could not verify, counted per reason and named application over one interval                                                                                                                                                                                                                | System                    | Application, when registered                             | `reason`, `count`; `applicationId` when the assertions name a registered application                                                                                                                                                                                                                                         | `warning`                                                         |
| `managementToken.refusal`           | Controller refused a management token that verifies under the trusted issuer, before the operation began                                                                                                                                                                                                                                      | Anonymous                 | Management API                                           | `reason` (`expiredToken`, `missingExpiry`, `missingSubject`, `notYetValid`, `otherAudience`, `revokedPlatform`, `revokedPrincipal`, `signedOutSession` or `unrepresentableSubject`), `refusedSubject` when its `sub` is storable text of at most 255 characters, `method`, `route`                                           | `warning`                                                         |
| `managementToken.refusalTally`      | Controller refused management credentials it could not read or verify, counted per reason over one interval                                                                                                                                                                                                                                   | System                    | Management API                                           | `reason` (`malformedCredential`, `unreadableToken`, `otherIssuer` or `invalidSignature`), `count`                                                                                                                                                                                                                            | `warning`                                                         |
| `invitation.creation`               | Access invitation sent to an address with no account yet                                                                                                                                                                                                                                                                                      | Custodian or admin        | Email address + category + resource                      | `actorId`, `email`, `resourceId`, `category`, `invitationId`, `expiresAt`                                                                                                                                                                                                                                                    | `info`                                                            |
| `invitation.claim`                  | An account confirmed an invitation; the grants it promised were created                                                                                                                                                                                                                                                                       | User                      | Principal + the grants created                           | `actorId`, `invitationId`, `email`, `grantIds`                                                                                                                                                                                                                                                                               | `info`                                                            |
| `invitation.lapse`                  | An invitation expired unclaimed, so the grants it promised were never created                                                                                                                                                                                                                                                                 | System                    | Email address + category + resource                      | `invitationId`, `email`, `resourceId`, `category`                                                                                                                                                                                                                                                                            | `info`                                                            |
| `grant.creation`                    | Category grant created for a user                                                                                                                                                                                                                                                                                                             | Custodian                 | User + category + resource                               | `custodianId`, `granteeId`, `resourceId`, `category`, `role`, `grantId`; `origin` (`migration`) and `causedBy` when a migration wrote it                                                                                                                                                                                     | `info`                                                            |
| `grant.decision`                    | A grant's holder accepted or rejected it, or a migration recorded an acceptance, its actor then the administrator who ran the migration                                                                                                                                                                                                       | User                      | Category grant                                           | `actorId`, `grantId`, `resourceId`, `category`, `role`, `decision` (`accepted` or `rejected`); `origin` (`migration`) and `causedBy` when a migration wrote it                                                                                                                                                               | `info`                                                            |
| `grant.selfCreation`                | An admin created a grant for themselves, through the endpoint that requires a TTL                                                                                                                                                                                                                                                             | Admin                     | The admin + category + resource                          | `actorId`, `resourceId`, `category`, `role`, `grantId`, `expiresAt`                                                                                                                                                                                                                                                          | `warning`                                                         |
| `grant.extension`                   | A grant's end moved later                                                                                                                                                                                                                                                                                                                     | Custodian, owner or admin | Category grant                                           | `userId`, `resourceId`, `category`, `endBefore`, `endAfter`                                                                                                                                                                                                                                                                  | `info`                                                            |
| `grant.reduction`                   | A grant's end moved earlier, and remains in the future                                                                                                                                                                                                                                                                                        | Custodian, owner or admin | Category grant                                           | `userId`, `resourceId`, `category`, `endBefore`, `endAfter`                                                                                                                                                                                                                                                                  | `warning`                                                         |
| `grant.revocation`                  | Category grant revoked                                                                                                                                                                                                                                                                                                                        | Custodian, owner or admin | User + category + resource                               | `actorId`, `granteeId`, `resourceId`, `category`, `role`, `grantId`, `reason`; `causedBy` when a retirement ended it                                                                                                                                                                                                         | `info`                                                            |
| `grant.rateExceeded`                | Grant operations by a single actor exceed the configured threshold within a rolling window                                                                                                                                                                                                                                                    | Custodian or admin        | Multiple                                                 | `actorId`, `operationCount`, `windowSeconds`                                                                                                                                                                                                                                                                                 | `warning`                                                         |
| `identity.revocation`               | User identity flagged as compromised; all active grants revoked                                                                                                                                                                                                                                                                               | Admin                     | User                                                     | `adminId`, `revokedUserId`, `scope`                                                                                                                                                                                                                                                                                          | `critical`                                                        |
| `identity.revocationLift`           | User identity's compromise flag lifted                                                                                                                                                                                                                                                                                                        | Admin                     | User                                                     | `adminId`, `liftedUserId`                                                                                                                                                                                                                                                                                                    | `warning`                                                         |
| `identity.signOut`                  | The identity provider signed a person out, through its back-channel logout                                                                                                                                                                                                                                                                    | System                    | User                                                     | `signedOutUserId`, `result`                                                                                                                                                                                                                                                                                                  | `info`                                                            |
| `platform.revocation`               | Every principal's access revoked across the platform at once                                                                                                                                                                                                                                                                                  | Admin                     | All principals                                           | `actorId`, `reason` (`credentialCompromise`, `keyCompromise` or `securityIncident`)                                                                                                                                                                                                                                          | `critical`                                                        |
| `baseline.change`                   | The baseline and signed-in rule a start runs under recorded: at the store's first start, and at any start under rules other than those recorded, which also writes one baseline notice                                                                                                                                                        | System                    | All principals                                           | `baseline` and `signedInRule`, each the actions it confers, sorted                                                                                                                                                                                                                                                           | `info` at the store's first start; else `warning`                 |
| `resource.registration`             | Study or cohort registered                                                                                                                                                                                                                                                                                                                    | Admin or submitter        | Resource                                                 | `actorId`, `resourceId`, `initialOwnerId`; `origin` (`migration`) and `causedBy` when a migration wrote it                                                                                                                                                                                                                   | `info`                                                            |
| `migration.run`                     | EGO migration run by an administrator: a real run's counts on success, and a refusal or failure as below the table                                                                                                                                                                                                                            | Admin                     | Resources and grants                                     | `actorId`; on success, the counts listed below the table                                                                                                                                                                                                                                                                     | follows `result`                                                  |
| `ownership.transfer`                | Resource ownership transferred                                                                                                                                                                                                                                                                                                                | Owner or admin            | Resource                                                 | `actorId`, `fromOwnerId`, `toOwnerId`, `resourceId`                                                                                                                                                                                                                                                                          | `info`                                                            |
| `resource.orphaned`                 | Resource has no owner; admin notified                                                                                                                                                                                                                                                                                                         | System                    | Resource                                                 | `resourceId`, `lastOwnerId`, `triggerEventType`                                                                                                                                                                                                                                                                              | `critical`                                                        |
| `resource.suppression`              | Resource hidden from results, its grants untouched                                                                                                                                                                                                                                                                                            | Owner or admin            | Resource                                                 | `actorId`, `resourceId`, `reason`                                                                                                                                                                                                                                                                                            | `warning`                                                         |
| `resource.restoration`              | Suppressed resource shown in results again                                                                                                                                                                                                                                                                                                    | Owner or admin            | Resource                                                 | `actorId`, `resourceId`, `reason`                                                                                                                                                                                                                                                                                            | `info`                                                            |
| `resource.detailsUpdate`            | A resource's details changed                                                                                                                                                                                                                                                                                                                  | Owner or admin            | Resource                                                 | `actorId`, `resourceId`, `changed` (the names of the details changed, never their values)                                                                                                                                                                                                                                    | `info`                                                            |
| `resource.revocation`               | Every user of a resource revoked at once                                                                                                                                                                                                                                                                                                      | Admin                     | Resource                                                 | `actorId`, `resourceId`, `reason` (`credentialCompromise`, `custodianRequest`, `keyCompromise` or `securityIncident`)                                                                                                                                                                                                        | `critical`                                                        |
| `resource.retirement`               | Resource retired, ending its owners' grants; refused while a non-owner grant or a pending invitation remains                                                                                                                                                                                                                                  | Admin                     | Resource                                                 | `actorId`, `resourceId`, `grantCount` (the owner grants ended, naming none)                                                                                                                                                                                                                                                  | `info`                                                            |
| `resource.deletion`                 | A registration that never held a grant or an invitation deleted                                                                                                                                                                                                                                                                               | Admin                     | Resource                                                 | `actorId`, `resourceId`                                                                                                                                                                                                                                                                                                      | `info`                                                            |
| `category.creation`                 | Category defined                                                                                                                                                                                                                                                                                                                              | Admin                     | Category                                                 | `actorId`, `category`                                                                                                                                                                                                                                                                                                        | `info`                                                            |
| `custodianship.assignment`          | Custodian role assigned to a user for a category within a resource                                                                                                                                                                                                                                                                            | Owner or admin            | User + category + resource                               | `actorId`, `custodianId`, `resourceId`, `category`                                                                                                                                                                                                                                                                           | `info`                                                            |
| `custodianship.removal`             | Custodian role removed from a user                                                                                                                                                                                                                                                                                                            | Owner or admin            | User + category + resource                               | `actorId`, `custodianId`, `resourceId`, `category`                                                                                                                                                                                                                                                                           | `info`                                                            |
| `grant.unguarded`                   | A grant took effect without a custodian's decision because the category had none assigned                                                                                                                                                                                                                                                     |                           |                                                          |                                                                                                                                                                                                                                                                                                                              |                                                                   |
| `admin.override`                    | Admin performed an action that bypasses an instance config restriction                                                                                                                                                                                                                                                                        | Admin                     | Varies                                                   | `adminId`, `operation`, `configBypassed`, `resourceId`                                                                                                                                                                                                                                                                       | `critical`                                                        |
| `audit.read`                        | The audit trail read through the Management API                                                                                                                                                                                                                                                                                               | Admin                     | Audit trail                                              | `actorId`                                                                                                                                                                                                                                                                                                                    | `info`                                                            |
| `application.registration`          | Application registered, its first key issued in the same act                                                                                                                                                                                                                                                                                  | Admin                     | Application                                              | `actorId`, `applicationId`                                                                                                                                                                                                                                                                                                   | `info`                                                            |
| `application.servedResourcesChange` | A resource added to or removed from the set served by an application                                                                                                                                                                                                                                                                          | Admin                     | Application + resource                                   | `actorId`, `applicationId`, `resourceId`, `change` (`added` or `removed`)                                                                                                                                                                                                                                                    | `info`                                                            |
| `applicationKey.issuance`           | Key issued for an application: at its registration, and again for a rotation                                                                                                                                                                                                                                                                  | Admin                     | Application key                                          | `actorId`, `applicationId`, `keyId`                                                                                                                                                                                                                                                                                          | `info`                                                            |
| `applicationKey.revocation`         | Application key revoked, so the controller refuses exchanges made with it                                                                                                                                                                                                                                                                     | Admin                     | Application key                                          | `actorId`, `applicationId`, `keyId`; `reason` (`rotated`, `compromised` or `retired`) when given                                                                                                                                                                                                                             | `warning` when refused; `critical` for `compromised`; else `info` |
| `applicationKey.confirmation`       | First exchange verified with an application key                                                                                                                                                                                                                                                                                               | System                    | Application key                                          | `applicationId`, `keyId`                                                                                                                                                                                                                                                                                                     | `info`                                                            |
| `applicationKey.unreadable`         | A stored application key failed to decrypt although the key-encryption key passed its check, so the row was altered and that application is refused                                                                                                                                                                                           | System                    | Application key                                          | `applicationId`, `keyId`                                                                                                                                                                                                                                                                                                     | `critical`                                                        |
| `revocationChannel.modeChange`      | Bridge moved between cold, normal and revocation-uncertain, or stayed cold at startup: whether it can currently confirm its cached authorizations are still valid                                                                                                                                                                             | System                    | All active sessions                                      | `fromMode`, `toMode`, `reason`; the reasons include holding no anonymous payload, a probable key mismatch, and a probable audience mismatch                                                                                                                                                                                  | `critical` into cold or uncertain, `info` into normal             |
| `category.unenforced`               | Bridge received a grant it does not enforce yet, so the grant reached nothing: a category entry carrying `field`. Once per such entry in each payload received, never per request                                                                                                                                                             | System                    | Principal + category + resource                          | `userId`, `resourceId`, `category`, `payloadVersion`, `reason` (`notImplemented`), `entry` (`fieldPartition`)                                                                                                                                                                                                                | `warning`                                                         |
| `category.unmapped`                 | Bridge denied a catalogue's whole result, because Usher defines a global category the catalogue's category mapping neither defines nor declares absent; or withheld a resource from a catalogue, because the resource offers a resource category the catalogue neither defines nor declares absent. Once per catalogue, category and resource | System                    | Catalogue + category + resource                          | `catalogue`, `category`, `resourceId`                                                                                                                                                                                                                                                                                        | `critical` for a global category, `error` for a resource category |
| `category.unknown`                  | Bridge found a category in a catalogue's category mapping that Usher does not define for it: a global Usher does not list, or a resource category Usher does not offer for that resource. It is never held, so its records are always excluded. Once per catalogue, category and resource                                                     | System                    | Catalogue + category, + resource for a resource category | `catalogue`, `category`; `resourceId` for a resource category                                                                                                                                                                                                                                                                | `warning`                                                         |
| `catalogue.renderingMismatch`       | Bridge's check of a rendered filter against the payload and registration it came from found a difference, so the catalogue's result was denied                                                                                                                                                                                                | System                    | Catalogue                                                | `catalogue`                                                                                                                                                                                                                                                                                                                  | `critical`                                                        |
| `catalogue.filterLimit`             | Bridge found that a principal's grants rendered past the catalogue's clause limit, so the catalogue's result was denied; names no count of grants                                                                                                                                                                                             | System                    | Catalogue                                                | `catalogue`, `filterClauseLimit`                                                                                                                                                                                                                                                                                             | `error`                                                           |
| `catalogue.resourceListMissing`     | Bridge started a record key registering an empty resource list, so every request to that catalogue is denied                                                                                                                                                                                                                                  | System                    | Catalogue                                                | `catalogue`                                                                                                                                                                                                                                                                                                                  | `critical`                                                        |
| `credential.refusal`                | Bridge refused an identity with its one `401`: refused by the controller, expired by its own `exp`, or already in the refusal store                                                                                                                                                                                                           | Anonymous                 | Principal                                                | `origin` (`controller`, `localExpiry` or `cachedRefusal`)                                                                                                                                                                                                                                                                    | `info`                                                            |
| `credential.malformed`              | Bridge answered `400` because no single credential could be read from a request                                                                                                                                                                                                                                                               | Anonymous                 | Request                                                  | `reason` (`multiple`, `scheme` or `query`)                                                                                                                                                                                                                                                                                   | `info`                                                            |
| `token.exchangeFailure`             | Bridge could not complete an exchange, or shed requests beyond its in-flight bound; shed requests are counted, one event per interval                                                                                                                                                                                                         | System                    | Principal, where known                                   | `cause` (`timeout`, `network`, `status`, `assertionRefused` or `overloaded`); `count` when overloaded                                                                                                                                                                                                                        | `warning`                                                         |
| `token.rejection`                   | Bridge could not read an Usher token, from its header to the validator, and treated it as not received                                                                                                                                                                                                                                        | System                    | Usher token                                              | `reason`, a fixed code, never a value from the token                                                                                                                                                                                                                                                                         | `warning`                                                         |
| `token.overtaken`                   | Bridge discarded an exchange answer because a notice affecting it arrived while it was in flight; the first time it exchanges again, the second it serves the open tier, marked suspended, or serves nothing when no usable anonymous payload is held                                                                                         | System                    | Usher token                                              | `outcome` (`exchangedAgain`, `servedOpenTier` or `abandoned`)                                                                                                                                                                                                                                                                | `info`                                                            |
| `notice.applied`                    | Bridge applied a notice from the revocation channel                                                                                                                                                                                                                                                                                           | System                    | The entries it names                                     | `kind`, `entriesDropped`                                                                                                                                                                                                                                                                                                     | `info`                                                            |
| `revocationChannel.pushReconnect`   | Bridge replaced a push connection that stayed silent past its idle timer                                                                                                                                                                                                                                                                      | System                    | Revocation channel                                       | `reason`                                                                                                                                                                                                                                                                                                                     | `info`                                                            |
| `revocationChannel.reset`           | Bridge dropped every entry because the channel answered that history no longer reaches its cursor                                                                                                                                                                                                                                             | System                    | All active sessions                                      | none                                                                                                                                                                                                                                                                                                                         | `warning`                                                         |
| `revocationChannel.malformed`       | Bridge could not read a notice or a poll answer, so it applied nothing and recorded no check; or the push was answered with a 200 that is not an event stream, as a proxy answering with a page of its own does                                                                                                                               | System                    | Revocation channel                                       | `reason`, a fixed code                                                                                                                                                                                                                                                                                                       | `warning`                                                         |
| `revocationChannel.failure`         | Bridge's revocation channel failed: a poll was answered with a status other than 200, 406 or 410, could not reach the controller, or ran past its deadline, or a defect was thrown while polling, applying a pushed notice, or handing a 410 to the channel; failures are counted, one event per cause per interval                           | System                    | Revocation channel                                       | `cause` (`status`, `network`, `timeout` or `defect`); `count`, the failures of that cause counted                                                                                                                                                                                                                            | `warning`                                                         |
| `bridge.internalError`              | Bridge had an unexpected failure inside it, answered with `503`                                                                                                                                                                                                                                                                               | System                    | Request                                                  | `stage`                                                                                                                                                                                                                                                                                                                      | `critical`                                                        |
| `bridge.startRefusal`               | Bridge refused to start, so it stays cold and answers `503`: a second bridge for one audience, an unusable key, a configuration it refuses, or a throw while it builds its controller client, token reader or revocation channel, or starts the channel                                                                                       | System                    | The application                                          | `reason`, a fixed code naming the rule, never a configured value                                                                                                                                                                                                                                                             | `critical`                                                        |

**An invitation ends two ways and they are different facts.** A claim says somebody took the access
offered; a lapse says nobody did. Collapsing them loses the second, which is the only record that an
offer was made and refused by inaction. Explicit refusal is already a grant state, `declined`, so
without `invitation.lapse` the model records the loud refusal and drops the quiet one.

**The claim event is also the only place the address and the principal appear together.** An
invitation is keyed by email and the grants it creates are keyed by subject, so this is what joins
them, and it is the last point at which the address is in the record before being discarded.

**A refused channel assertion is recorded by what it cost to send, and names an application only
when one is registered.** One that verifies under its application's key and is refused anyway is a
`channelAssertion.rejection`, its `reason` `expiredAssertion`, `notYetValid`, `otherAudience`,
`excessiveLifetime` or `reusedAssertion`, the last an assertion presented a second time, which only a
copy of it can be. One that cannot be verified costs nothing to send, so each instance counts them
per reason and application, and records one `channelAssertion.rejectionTally` for each every 60
seconds, as it does for management credentials: `missingAssertion`, `unreadableAssertion`,
`unknownApplication`, `noLiveKey` or `invalidSignature`. A header carrying the scheme with no
assertion is `missingAssertion`. Every cause answers the same `401`, while the reasons let an
operator tell a missing registration from a drifting clock, and a clock running ahead from one
running behind. Whenever the assertion can be read and its `iss` names a registered application, the
event or count carries that `applicationId`, whatever the cause: the application named by the
assertion, which an unverified one leaves unproven, so a run of refusals under one id points either
at that application's bridge or at someone sending its id. An identifier held by no registration is
text from whoever sent the request, and stays out of the trail.

**A refused management credential is recorded by what it cost to send.** A token that verifies under
the trusted issuer and is still refused came from the identity provider, so each one is a
`managementToken.refusal`, its actor anonymous since the refusal is that the controller does not act
for it, and its `method` and `route` those of the operation matched, the route as its template and
never the path sent. That includes a verified token naming no `sub`, as `missingSubject`, and one
whose `sub` or `sid` holds text that cannot be stored, as `unrepresentableSubject`. A platform
revocation refuses every identity-provider token issued before it, here and at the exchange, as
`revokedPlatform`, a token naming no `iat` read as issued before it. A credential that cannot be
read, as two `Authorization` headers or one sent in the query cannot, or cannot be verified, costs
nothing to send, so each instance
counts them by reason and records one `managementToken.refusalTally` per reason every 60 seconds,
none for a zero count, flushing the counts it holds when it stops. A request with no credential is
not recorded. Neither event is evaluated in the controller: a rule over the tallies, such as 20 or
more in one interval across instances or any count in ten intervals in a row, belongs downstream
with the other rules over the stream.

**`migration.run` records each real run, and a dry run only when it is refused for authority.** A
real run that succeeds records it at `info`, its actor the administrator, with `studiesReported`,
`studiesRegistered`, `studiesSkipped`, `grantsWritten`, `allStudyHoldings`, `dataWithoutPolicy` and
`resourcesWithoutOwner`. A run asked for without the administrator role, real or dry, records it
`denied`, its reason the code answered, so an unauthorized attempt always leaves a trace. A real run
whose `audiences` is refused, empty or naming an unregistered application, records it `denied` with
that `422` code. A run while the migration's settings are missing records it `failed`, with
`migrationNotConfigured`. A dry run accepted, or refused for its content, writes no event, and
neither does a run refused because another holds the lock.

**A refused token names its subject only when the controller verified its signature.**
`refusedSubject` is the `sub` of a sign-in or management token that verifies under the trusted
issuer and is refused anyway: expired, carrying no `exp`, not yet valid, for another audience, or
held by a revoked principal or a signed-out session, or issued before a platform revocation. It is a
field of its own and never the actor, which stays anonymous, since the controller did not act for
that subject. Every `managementToken.refusal` is for such a token, so each carries it, unless its
`sub` is absent, cannot be stored, or breaks the length rule below. A
refused `token.exchange` carries it for those reasons alone: for a token whose signature does not
verify, the field is left out, never empty or `null`, and `reason` says why. A verified `sub` longer
than 255 characters is left out too, never cut short, since a shortened identifier could name
someone else. So a revoked person's token still in use shows whose it is, and a forged token cannot
put anyone's subject in the trail. The bridge's `credential.refusal` carries no subject, since the
bridge verifies no signature.

**A refused Management API request records the event its operation records, with `result`
`denied`.** Its `reason` is the code answered, whether the request was refused for the principal's
authority or for its content, and it records at `warning`; where a `404` stands in for a refusal of
authority, `reason` is `noAuthorityOnResource`. A request that changes nothing, such as serving a
resource to an application that already serves it, records nothing, since nothing was refused, and a
dry run follows `migration.run`'s rule above. A request refused for its management token, before any
operation, is a `managementToken.refusal` instead. A refused event names nothing the request would
have created, so it carries no new `applicationId`, `keyId` or `grantId`, while an existing entity
the request named stays named.

**A retirement is recorded once for the resource and once for each owner grant it ends.** One
`resource.retirement` carries `grantCount`, naming no one, and each owner grant ended gets a
`grant.revocation` whose reason is `resourceRetired`, whose actor is the retiring administrator, and
whose `causedBy` holds the retirement's CloudEvents `id`, so who lost access, and why, is answerable
from the trail alone.

**`identity.signOut` relays a sign-out made at the identity provider.** The person signs out there and
the provider tells the controller through its back-channel logout, so the actor is the system and
`signedOutUserId` is the person's subject.

**Grant rate**, reported by `grant.rateExceeded`, is how many grant operations one actor
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
  behind deduplication, so an undisciplined `source` weakens deduplication whatever `type` looks
  like. The attribute must be a URI-reference with an absolute URI recommended, and nothing further
  is agreed: not how a deployment is identified within it, not whether it names a service or an
  endpoint. What the model needs is settled: one deployment is one source, however it ends up
  spelled. The spelling is a logging concern, it is visible in the trail once events are
  flowing, and it does not gate the permissions model.
- **A shared entity vocabulary is owed, and only the flat type form owes it.** Two services meaning
  different things by one entity produces two occurrences under one name, and a consumer joins them.
  There is no registry and no owner. The failure is silent.
- `grantRateThreshold` configures when `grant.rateExceeded` fires, as an `operationCount` over
  a `windowSeconds`. The name is settled; both default values are not. Where the count is kept is a
  scaling question rather than a detail: see multi-instance propagation in
  [security-workflow.md](security-workflow.md#multi-instance-propagation).
- **`resource.registration` carries no field name or value.** The resource field name is
  per-catalogue adapter configuration, which Usher never holds, and the value is the resource's
  identifier, already carried as `resourceId`. Provisional: revisited when the audit path is
  implemented.
- **The three custodianship entries are post-MVP**, arriving with community custodianship:
  `custodianship.assignment`, `custodianship.removal`, and `grant.unguarded`. Nothing emits them in
  the first release, because nothing assigns a custodian in it.
- **An event is owed for a resource's categories changing, and nothing emits one.** That write
  decides what every principal reaches and is watched by the fast path, since it clears the
  controller's payload cache. Its type waits on the same question as its capability: whether the
  authority sits with the resource's owner or the category's custodian decides whether it is
  `resource.categoryChange` or `category.association`. The event is owed whichever way that lands.
  See the capability vocabulary in [permissions-model.md](permissions-model.md).
- `grant.unguarded` needs its required fields settling, and needs deciding whether it is an event at
  all. It has no actor of its own: it happens as a consequence of a grant being created on a category
  with no custodian. As a separate entry it can go missing, and a creation logged without its
  companion reads as an ordinary grant, hiding exactly the grants unseen by any custodian. As a
  field on `grant.creation`, it cannot be omitted without omitting the creation. See
  [decisions.md](decisions.md) § Granting is one function, which contrasts this vacancy against a
  resource left without an owner and explains why the two are remedied differently. The warning to
  that resource's owners is a separate delivery record and is not this event either way.
- Ownership events still read as transfer between single owners. Ownership is a non-empty set, so
  adding and removing an owner are the primary operations and transfer is a compound of the two.
