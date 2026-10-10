# API keys: why opaque, and the narrowing that follows

Programmatic access to Overture services runs on API keys issued through the team's Keycloak plugin.
Score is the main consumer today; Song was the other. Usher inherits them rather than designing them,
and this file records the one decision taken and the one improvement worth building later.

---

## Decided: keys stay opaque strings, checked rather than verified

**Usher cannot absorb a self-verifying token.** The revocation guarantee has two parts, an Usher
token that lives five minutes and a push channel announcing changes inside that window. A signed
credential with a multi-year expiry cannot sit inside either, given what each is. Withdrawing one
before it expires needs a revocation list, which is the issuer-side state that making it
self-verifying was supposed to remove.

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
with nothing meaningful returned. Usher cannot distinguish that from "no such key" and would resolve
it to the anonymous tier. That direction is safe, since nobody gains access, and the failure is
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

|                                         | Validate at issue                           | Intersect at exchange                      |
| --------------------------------------- | ------------------------------------------- | ------------------------------------------ |
| Who calls whom                          | the plugin calls Usher when a key is minted | nobody new; Usher already calls the plugin |
| Dependency                              | mutual, at two different moments            | one direction                              |
| A key claiming more than its holder has | rejected at creation                        | yields less, silently and safely           |
| Which subject the check runs against    | an open question on the plugin side         | does not arise                             |

Intersection cannot add, so a key can never widen its holder's access no matter what it claims. That
makes the reduce-only property structural rather than dependent on issue-time validation being
correct, and it removes Usher's stake in the open question about which subject that validation
evaluates against.

**A key's scope is therefore a request, not a grant.** The holder asks for a narrowing; Usher decides
what that resolves to at exchange, against what they hold at that moment. A key outliving its
holder's access narrows to nothing rather than to what was true when it was minted.

**Safe by its shape, and only on Usher's path.** Song and Score consume scopes directly and intersect
against nothing, so until they move to Usher enforcement, they rely on issue-time validation to
bound what a key carries. The intersection property is Usher's, not the platform's.

**The cost is a creation-time surprise.** Someone can mint a key claiming scope they do not hold, and
on Usher's path it will quietly do less. That is a usability problem rather than a security one, and the fix belongs
to the interface: the profile view already needs to show a person what they hold, so it can offer the
scope choices rather than accept free text.

**Migration.** Song and Score consume EGO-style scopes today. Those scopes stop mattering as the two
services move to Usher enforcement, so this is a program-level migration rather than a field-format change,
and both forms exist in the meantime.

**Open: the format.** Usher enforces at resource level for MVP, so the system can actually narrow a
key by resource name, with capability the obvious second axis since the token already carries it.
The dotted form used today would collide with the separator rule if extended naively, so the shape
needs settling rather than inheriting.

---

## Decided: DENY is rejected rather than ignored

The existing format allows a negative, `<name>.DENY`, alongside READ and WRITE. It does not carry
forward.

**Under intersection a negative has no meaning.** A key claiming DENY on something cannot reduce
anything by claiming it, so it is inert. That is the problem rather than the resolution: someone
writes DENY expecting a restriction and gets none, which is a widening relative to their intent, and
this design never accepts a widening silently. See [decisions.md](../../../design/decisions.md) §
Additive rendering over subtractive exclusion, where losing a term narrows rather than widens: an
inert DENY breaks that property.

**So a key carrying DENY is refused, not accepted and disregarded.** Refusing is loud and happens
once, at creation. Disregarding is quiet and happens on every use.

Nothing is lost expressively. An additive model says what a key may do, so "everything except X" is
written as the list without X, and DENY was only ever a way of saying that subtractively.

**Any change to the plugin made for Usher ships as a new major version** (the developer, 2026-10-09).
Song and Score consume the plugin today, so a major version is what tells them a release behaves
differently rather than letting a range they pin pick it up.

**Refusing it is a change to the plugin, and not yet requested.** The plugin accepts DENY today, as a
legal access level and a legal Keycloak scope name. The change is requested of the plugin's owner as
part of adopting the Usher scope format, not before.

---

## The suffix constraint, and what it depends on

The parser splits on the **last** dot, so a resource name may itself contain dots: `a.b.c.READ`
parses as name `a.b.c` with level `READ`. A value with no dot at all is rejected. The only real
constraint is the suffix, which must be READ, WRITE or DENY.

**That removes the collision worry and replaces it with a vocabulary one.** A dotted name survives,
so the separator rule is not the problem. The problem is that READ and WRITE are EGO's access levels
and Usher's capabilities are not: `record.view` and `record.export` both sit under the group
`read`, and collapsing them onto READ loses exactly the axis that motivates narrowing, since
view-without-export is the obvious thing to want from a download script's key.

**The capability vocabulary has since been settled**, so the format no longer waits on it: the
data-plane actions are `count`, `view`, `export`, `create`, `update` and `delete`, written
`entity.action`, with the first three grouped as `read`. What remains open is the narrowing itself rather than the words for it. Two
shapes are available once that lands:

- **Name carries resource and category, suffix carries a coarse level.** `STUDY_A.controlled.READ`
  parses today, but does not mint without more: issuing checks every scope against Keycloak's
  authorization model (see below), so it needs that model populated for every resource-and-category
  combination a key could name, each with READ and WRITE scopes and permissions. It cannot express
  view-without-download either.
- **The accepted suffix set becomes the capability vocabulary.** Needs a plugin change, and is the
  only one that expresses what narrowing is for.

The second is what the feature is for. The first only looks free: minting it keeps keys tied to an
authorization model held in Keycloak, which is what Usher replaces.

---

## Sequencing: the format is settled before the first key, not alongside

A stored key whose scope does not parse is unreadable rather than unrecognized, so the failure lands
on the whole key rather than on one entry. A format settled while keys are already being issued in it
therefore breaks keys rather than degrading them.

If both forms coexist during migration, both have to satisfy the suffix rule, or the model changes
before either does.

---

## Why narrowing matters, now that the field is known to exist

**The deficiency is not the format, it is the scope.** A key is its holder: whatever that person
may do, the key may do. A researcher wanting a key for a download script hands that script their
whole access, and a key leaked from a pipeline carries everything they hold.

**This was filed as future work and is not.** The field exists, is populated, and is already
validated against something at issue. So the work is semantic rather than structural: deciding what
the field means once Usher is the thing that decides permissions. The section above settles that.

**Why it matters more here than elsewhere.** The data is health data, and automation outlives the
projects that created it. A script that can only read one study is a materially different exposure
from one carrying a researcher's full access three years after they stopped using it.

---

## The authentication constraint, which shapes the exchange

`check_api_key` requires the service calling it to authenticate, and where that service presents a
bearer token, the token's subject must own the key. Usher introspects other people's keys by definition, so it cannot use a
bearer token and needs basic auth.

**This is Usher's first credential to Keycloak.** Usher's only other work there is public-key
verification against the published JWKS, which needs no secret. A basic-auth credential able to
introspect any key is a different class of thing, and it reintroduces a shared secret: the JWE key
design deliberately avoided that shape by registering public halves.

The credential follows the deployment's own secret handling rather than a scheme of Usher's, and it
belongs in the threat model rather than in a configuration line.

---

## What the existing API key plugin does

- Keys are `UUID.randomUUID()` strings, hashed at rest, so nothing is self-verifying and a check is
  structurally required. The opaque decision fits what exists rather than asking for a rewrite.
- `check_api_key` returns `user_id`, `exp`, `isRevoked`, `isValid`, `message` and `scope`, so the
  exchange gets a principal, an expiry, and explicit revocation rather than inferred. `scope` is null
  whenever the key is not valid, so an invalid key carries no scope rather than a stale one, and scope
  cannot be read apart from validity.
- **Issuing is coupled to Keycloak's authorization model.** For every scope requested, some client's
  authorization resource server must hold a Resource named exactly the scope's name, carrying a
  Scope named exactly its level, with a permission the caller satisfies. Every scope must pass, so one
  miss refuses the whole key as an invalid scope. The plugin depends on the EGO-era authorization
  model at issue, not only through the string format, and Usher-native scope names, which have no
  Keycloak resource, cannot be minted until that check is replaced.
- **A key's lifetime is `APIKEY_DURATION_DAYS`**, read from the plugin's environment and 365 when
  unset, applied at issue as that many days from then and stored on the key. A key is valid while it
  is neither expired nor revoked. So the lifetime is deployment-wide, with no per-key lifetime, which
  leaves a short-lived key for a script inexpressible; lowering it shortens no key already issued; and
  an environment leaving it unset issues one-year keys, not unlimited ones.
- Revocation is observable only by the check failing, and the exchange-path design makes that
  sufficient and free. There is no event and nothing to poll.

---

## Open, and needed before any of this is built

- **The Usher scope format.** MVP can narrow by resource name, with capability the obvious second
  axis. The dotted form in use today would collide with the separator rule if extended naively.
- **Whether the interface offers scope choices or accepts free text.** Offering them needs the
  profile view to know what a person holds, which it needs anyway.
- **Where the basic-auth credential lives and how it rotates**, and whether an introspect-anything
  capability should be a Keycloak client of its own, separate from Usher's other future needs.
- **Key lifetime.** [../../phase-1.md](../../phase-1.md) records that API tokens open a much longer
  window than the five-minute Usher token, and the Overture demo environment sets 3650 days. The
  plugin's lifetime is deployment-wide and fixed at issue, as above; whether Usher wants per-key
  lifetimes, such as short keys for scripts, is open.
- **The plugin's issue-time check.** Usher scope names have no Keycloak resource, so minting them needs
  the plugin's check against Keycloak's authorization model replaced. What replaces it, if anything,
  follows from intersection at exchange, which already bounds what a key yields.
