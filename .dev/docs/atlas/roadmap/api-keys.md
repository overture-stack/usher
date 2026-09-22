# API keys: why opaque, and the narrowing that follows

Programmatic access to Overture services runs on API keys issued through a Keycloak plugin the team
maintains. Score is the main consumer today; Song was the other. Usher inherits them rather than
designing them, and this file records the one decision taken and the one improvement worth building
later.

---

## Decided: keys stay opaque strings, checked rather than verified

**A self-verifying token is the shape Usher cannot absorb.** The revocation guarantee has two parts,
an Usher token that lives five minutes and a push channel announcing changes inside that window. A
signed credential with a multi-year expiry cannot sit inside either, given what each is. Withdrawing one before
it expires needs a revocation list, which is the issuer-side state that making it self-verifying was
supposed to remove.

An opaque key inverts that. Revocation is a row, and the next check fails. No window, no list, no
propagation problem.

**Familiarity is the weaker argument and points the same way.** People already hold these keys and
paste them into scripts and pipelines. Keeping the format costs nothing and is not why the decision
went this way.

**What it costs, stated plainly.** The check runs in Usher's exchange path, so Keycloak and the
plugin become an availability dependency. The rate is the mitigating fact: a bridge exchanges once
per TTL window per principal rather than once per request, so a hundred requests a minute is one
check every five minutes, not five hundred.

The sharp edge is the plugin's failure mode. An incompatible JAR makes the endpoint stop answering
with nothing meaningful returned, which Usher cannot distinguish from "no such key" and would resolve
to the anonymous tier. That direction is safe, since nobody gains access, and the failure is
invisible: the person sees missing data rather than a fault. The plugin distinguishing the two cases
in its response is worth more to Usher than any latency improvement.

---

## Decided: the scope field carries Usher scope, intersected at exchange

Keys already carry a `scope` field, and it already holds EGO-style `<policyName>.<permission>` pairs
parsed into a name and an access level. So two systems encode access decisions today, and that is
live rather than prospective. Usher replaces EGO, so the field follows.

**The field is redefined to carry Usher-native scope.** It names Usher's own vocabulary rather than
EGO policy names, since a scope should be written in the vocabulary of whatever decides access.

**It is validated at exchange, by intersection, rather than at issue.** This is the part worth being
deliberate about, because the obvious alternative costs more than it looks.

| | Validate at issue | Intersect at exchange |
|---|---|---|
| Who calls whom | the plugin calls Usher when a key is minted | nobody new; Usher already calls the plugin |
| Dependency | mutual, at two different moments | one direction |
| A key claiming more than its holder has | rejected at creation | yields less, silently and safely |
| Which subject the check runs against | an open question on the plugin side | does not arise |

Intersection cannot add, so a key can never widen its holder's access no matter what it claims. That
makes the reduce-only property structural rather than dependent on issue-time validation being
correct, and it removes Usher's stake in the open question about which subject that validation
evaluates against.

**A key's scope is therefore a request, not a grant.** The holder asks for a narrowing; Usher decides
what that resolves to at exchange, against what they hold at that moment. A key outliving its
holder's access narrows to nothing rather than to what was true when it was minted.

**Safe by its shape, and only on Usher's path.** Song and Score consume scopes directly and intersect
against nothing, so until they move to Usher enforcement, issue-time validation remains their only
control. The intersection property is Usher's, not the platform's.

**The cost is a creation-time surprise.** Someone can mint a key claiming scope they do not hold, and
on Usher's path it will quietly do less. That is a usability problem rather than a security one, and the fix belongs
to the interface: the profile view already needs to show a person what they hold, so it can offer the
scope choices rather than accept free text.

**Migration.** Song and Score consume EGO-style scopes today. Those scopes stop mattering as the two
services move to Usher enforcement, so this is a program-level migration rather than a field-format change,
and both forms exist in the meantime.

**Open: the format.** Usher enforces at resource level for MVP, so resource names are the granularity
the system can actually apply, with capability narrowing the obvious second axis since the token
already carries it. The dotted form used today would collide with the separator rule if extended
naively, so the shape needs settling rather than inheriting.

---

## Decided: DENY is rejected rather than ignored

The existing format allows a negative, `<name>.DENY`, alongside READ and WRITE. It does not carry
forward.

**Under intersection a negative has no meaning.** A key claiming DENY on something cannot reduce
anything by claiming it, so it is inert. That is the problem rather than the resolution: someone
writes DENY expecting a restriction and gets none, which is a widening relative to their intent, and
widening is the one direction this design never accepts silently. See
[decisions.md](../../../design/decisions.md) § Additive rendering over subtractive exclusion, where
losing a term narrows rather than widens, which is the property an inert DENY breaks.

**So a key carrying DENY is refused, not accepted and disregarded.** Refusing is loud and happens
once, at creation. Disregarding is quiet and happens on every use.

Nothing is lost expressively. An additive model says what a key may do, so "everything except X" is
written as the list without X, and DENY was only ever a way of saying that subtractively.

---

## The suffix constraint, and what it depends on

The parser splits on the **last** dot, so a resource name may itself contain dots: `a.b.c.READ`
parses as name `a.b.c` with level `READ`. A value with no dot at all is rejected. The only real
constraint is the suffix, which must be READ, WRITE or DENY.

**That removes the collision worry and replaces it with a vocabulary one.** A dotted name survives,
so the separator rule is not the problem. The problem is that READ and WRITE are EGO's access levels
and Usher's capabilities are not: `record.read` and `record.export` are both readerly, and
collapsing them onto READ loses exactly the axis that motivates narrowing, since read-without-export
is the obvious thing to want from a download script's key.

**The capability vocabulary has since been settled**, so the format no longer waits on it: the
data-plane actions are `create`, `read`, `update`, `delete`, `export` and `aggregate`, written
`entity.action`. What remains open is the narrowing itself rather than the words for it. Two
shapes are available once that lands:

- **Name carries resource and category, suffix carries a coarse level.** `STUDY_A.controlled.READ`
  parses today with no plugin change, and cannot express view-without-download.
- **The accepted suffix set becomes the capability vocabulary.** Needs a plugin change, and is the
  only one that expresses what narrowing is for.

The second is what the feature is for; the first is what exists. Neither can be chosen before the
capability names are.

---

## Sequencing: the format is settled before the first key, not alongside

A stored key whose scope does not parse is unreadable rather than unrecognized, so the failure lands
on the whole key rather than on one entry. A format settled while keys are already being issued in it
therefore breaks keys rather than degrading them.

If both forms coexist during migration, both have to satisfy the suffix rule, or the model changes
before either does.

---

## Why narrowing matters, now that the field is known to exist

**The deficiency is not the format, it is the scope.** A key is its holder. Anything that person may
do, the key may do. A researcher wanting a key for a download script hands that script their whole
access, and a key leaked from a pipeline carries everything they hold.

**This was filed as future work and is not.** The field exists, is populated, and is already
validated against something at issue. So the work is semantic rather than structural: deciding what
the field means once Usher is the thing that decides permissions, which the section above settles.

**Why it matters more here than elsewhere.** The data is health data, and automation outlives the
projects that created it. A script that can only read one study is a materially different exposure
from one carrying a researcher's full access three years after they stopped using it.

---

## The authentication constraint, which shapes the exchange

`check_api_key` requires the service calling it to authenticate, and where that service presents a
bearer token, the token's subject must own the key. Usher introspects other people's keys by definition, so it cannot use a
bearer token and needs basic auth.

**This is Usher's first credential to Keycloak.** Everything else Usher does there is public-key
verification against the published JWKS, which needs no secret. A basic-auth credential able to
introspect any key is a different class of thing, and it reintroduces the shared-secret shape that
the JWE key design deliberately avoided by registering public halves.

It follows the deployment's own secret handling rather than anything Usher invents, and it is worth
naming in the threat model rather than appearing as a configuration line.

---

## What the existing API key plugin does

- Keys are `UUID.randomUUID()` strings, hashed at rest, so nothing is self-verifying and a check is
  structurally required. The opaque decision fits what exists rather than asking for a rewrite.
- `check_api_key` returns `user_id`, `exp`, `isRevoked`, `isValid`, `message` and `scope`, so the
  exchange gets a principal, an expiry, and explicit revocation rather than inferred.
- Revocation is observable only by the check failing, which the exchange-path design makes sufficient
  and free. There is no event and nothing to poll.

---

## Open, and needed before any of this is built

- **The Usher scope format.** Resource names are the granularity MVP can apply, with capability
  narrowing the obvious second axis. The dotted form in use today would collide with the separator
  rule if extended naively.
- **Whether the interface offers scope choices or accepts free text.** Offering them needs the
  profile view to know what a person holds, which it needs anyway.
- **Where the basic-auth credential lives and how it rotates**, and whether an introspect-anything
  capability should be a distinct Keycloak client from anything else Usher might later need.
- **Key lifetime.** [../../phase-1.md](../../phase-1.md) records that API tokens open a much longer
  window than the five-minute Usher token, that the iMS environments do not set it, and that the
  Overture demo environment sets it to 3650 days, which shows how far the knob goes.
