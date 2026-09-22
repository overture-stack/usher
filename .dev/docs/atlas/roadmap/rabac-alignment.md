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

| Stage                   | Question                                                          | Direction                   | Usher today                                        |
| ----------------------- | ----------------------------------------------------------------- | --------------------------- | -------------------------------------------------- |
| 1. Role check           | Does this user hold a role carrying this permission at all?       | confers the maximum         | **Not implemented.** Roles carry no permission set |
| 2. Permission filtering | Do the attributes permit exercising it on this particular object? | removes from it, never adds | **Implemented**, as category grants                |

Access requires both stages to pass. Usher built the second and skipped the first.

**The direction column is the part that is easy to get wrong.** Stage two only subtracts: the filter
functions are applied to the permissions in `avail_session_perm` and a permission returning FALSE is
"blocked and removed", the profile notes that "PFP is used only to reduce permissions so there should
not be PFPs that evaluate to permit", and two filters on one object combine deny-override. Usher's
grants read as additive, which describes the implementation rather than the rule it implements:
`decisions.md` records effective access as the ceiling narrowed by grants, which is this shape, and
`token-calculation.md` carries the invariant and the cases.

**One difference underneath it changes what stage one is.** In NIST RBAC `PRMS = 2(OPS x OBS)`, so a
permission already names its object and a role hands out verb-object pairs. That is why role explosion
happens, one doctor role per patient. Usher's ceiling carries verbs only and every object arrives
through a grant, so Usher's stage one is weaker than RABAC's and its stage two does constructive work
RABAC's never does. The two are reconciled by reading the ceiling as universal, which is what the
decision records.

That is the whole finding. The category machinery is a well developed permission filtering policy.
The role-to-permission assignment that the filter is supposed to be filtering was never defined, so
the token carries a `role` label that nothing consumes, because no plugin has anything to consult
it against.

## Three consequences, currently live

**The token carries a role name where it should carry a resolved permission set.** The model states
that a user may hold multiple roles in one resource, that roles are coarse labels rather than a
hierarchy, and that effective permissions are the union across every role held, with the
computation engine required to consult all of them rather than the highest-priority one. The token
schema has a single `role` string. There is nowhere for a union to go, so whatever the engine
computes is flattened to one of three values on the way out.

**A role-to-permission table inside a plugin would put policy in the enforcement layer.** The
architecture requires that applications make no policy decisions. Deciding which permissions the
`viewer` role carries is a policy decision, so a plugin holding that mapping holds policy. In RABAC
the role check is evaluated where the roles live, which here is the controller.

**`public` is a permission set wearing a role's clothes.** The token schema documents it as
equivalent to the minimum read permission with no management actions, which is a permission set
written in prose because there is no field to put it in. The missing field is already showing
through the design.

## The correction: resolve roles to permissions at issuance

Carry the resolved permissions in the token rather than the role name that produced them. **Paired
with the category they apply to, not as an independent list.**

    "COHORT_A": { "open":       { "record": ["read", "update"] },
                  "controlled": { "record": ["read"] } }

This follows from the architecture already in place rather than changing it. Usher is the decision
point, so resolving which permissions a role carries belongs there. Plugins become mechanical,
testing whether the permission list contains the action. The union problem dissolves, because a
union of roles becomes a union of permission sets computed before issuance. Role explosion stays
solved, which is the point of adopting RABAC in the first place: a new permission adds a
permission, never a role.
And an instance can define its own roles without every plugin having to learn them.

**Usher ships the capability vocabulary as defaults, and an instance may add to it.** The
controller and every plugin have to agree on what `download` means, which is what the shipped
defaults provide. That agreement does not require the list to be closed.

**`edit` belongs in the shipped defaults.** An existing Overture consumer already draws the line,
carrying an `editable_studies` list that makes someone a submitter for each study in it. So the
vocabulary needs a read and write split before anything is built against it, and that expectation
comes from a running system rather than from anticipation.

**Every capability name in this corpus is an example, not a dictionary entry.** `record.view` and
`grant.revoke` illustrate the shape, `entity.action`, and the plane split. The dictionary itself is
settled when implementation starts, against real APIs, because what an API offers is discovered by
building against it rather than decided in prose.

**Customization is safe because unknown names fail closed in both directions.** A permission in a
token that a plugin has never heard of is consulted by nothing, so it grants nothing. A permission a
plugin checks for and the token lacks fails the check, so it denies. Neither leaks, and the worst
outcome is access refused that should have been allowed, which someone complains about.

**So customization is additive, and redefining a default is the one unsafe move.** Plugins check by
name. An instance that keeps `download` and narrows what it means leaves every plugin performing what
it already understood downloading to be, with the names still matching and nothing able to detect the
difference. Add names; never repurpose one.

**This is where the pattern differs from categories, and the difference is smaller than it looks.**
A category is meaningless to Usher and meaningful only through a plugin's configuration, so its
meaning is supplied per schema. A capability is meaningful to everyone and must mean the same thing
everywhere it is understood, which is why the defaults ship together rather than being assembled per
installation.

**The two axes are conceptually distinct but must not be carried independently.** Rejected: a
`permissions` list beside a `categories` list, which is less expressive than both RABAC and the
requirement it was meant to serve. Two independent
lists imply their full cross-product: every permission applying to every category. The source model
does not work that way. A filter function is typed `Fi: SESSIONS x OPS x OBS -> {T, F}`, filtering
iterates over each `(ops, obs)` permission separately, and the paper's worked example writes
`FPatient` for `read` specifically. So a filter attached to reading need not be the filter attached to
writing. That is a consequence of the formalism and the example rather than a sentence in the paper,
which is a weaker claim than this document made before and still sufficient.

The concrete case this project already asked for and the orthogonal shape cannot express: read on
one category, read and upload on another, within the same resource. Pairing the permission with the
category expresses it; two lists cannot.

What remains true is that a permission and a category answer different questions, and someone may
hold a permission on a resource's open portion while reaching none of its restricted records. That is
preserved by pairing, since open content is itself a category: holding `download` on `open` and only
`view` on `controlled` says exactly that. No resource-level slot is needed, and adding one would
reintroduce the baseline that additive rendering exists to do without.

Whether the originating role name travels alongside the permissions is a separate and smaller
question. It is not needed for enforcement, and audit events are emitted by the controller, which
knows the role already, so the default should be to leave it out rather than to carry two
representations that can disagree.

## Roles at each plane, and one token shape for both

Permissions divide by what they act on, which is the split the architecture already draws. A
control-plane permission acts on what Usher holds; a data-plane one acts on records an application
holds. Roles live at each plane, and a principal holds roles at both independently.

**The plane names what a permission targets, not where it is enforced.** Both are enforced in the
control plane: the controller checks a control-plane permission on an admin call, and the plugin
checks a data-plane one before a query runs. The plugin is a control-plane component that happens to
run inside an application, which is why enforcing there does not put policy there.

|                                   | control plane                                        | data plane                                        |
| --------------------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| roles                             | admin, custodian, owner                              | submitter, curator, viewer                        |
| operates on                       | who may do what                                      | the records                                       |
| permissions                       | `grant.create`, `grant.revoke`, `ownership.transfer` | `record.view`, `record.download`, `record.create` |
| exercised against                 | Usher's own store                                    | an application's records                          |
| audience of the token carrying it | the management interface                             | one data application                              |
| namespace                         | `grant.*`, `ownership.*`                             | `record.*`                                        |

**The role names in that first row are examples**, as capability names are. Which roles an instance
defines is its governance decision, and `submitter` there is a name an instance might give a group
allowed to upload, which is a different thing from the provenance the glossary records under the same
word.

**Overlap is the normal case rather than the exception.** An owner who is also a submitter holds a
role at each plane, and neither implies the other. This is what "an owner holds member-level data
access" was reaching for, and that phrasing states it as inheritance, which contradicts both the
flat-role deviation recorded below and the decision that ownership carries no data access.

**The data-plane role is RABAC's missing first stage.** It is the ceiling: a curator's role carries
`record.update`, a viewer's does not. The grant is the second stage and the specific: which
categories, and how much of the ceiling applies to each. That is what lets one grant permit reading a
category while another permits reading and uploading, within one resource.

The control plane has its own first stage in the same way. Holding `grant.revoke` on a category is what makes
revoking possible at all; which categories it names is the filtering.

### The token shape is identical and the audience separates them

    aud: "search-service"
    grants: {
      "STUDY_A": { "open":       {"record": ["read", "update"]},
                   "controlled": {"record": ["read"]} }
    }

    aud: "usher-admin-ui"
    grants: {
      "*":       { "controlled": {"grant": ["create", "revoke"]} },
      "STUDY_A": { "open":       {"grant": ["create"]},
                   "*":          {"ownership": ["transfer"]} }
    }

Resource, then category, then permissions, in both. The management token is what an interface reads
to decide which views and controls to offer, rather than discovering its own permissions by
attempting actions and reading the failures.

**Scoping built into the shape is what makes that safe.** A custodian of `controlled` receives a token
naming `controlled` and nothing else, so they never learn which other categories exist. The
alternative, sending the full picture with permissions marked on it, leaks by its shape. This is
the same property the data token already has: it names only resources the principal can reach.

**A wildcard is valid in either position and means all of them.** A custodian's authority spans every
resource, so `*` stands in the resource position; ownership permissions are not per category, so
`*` stands in the category position. Enumerating instead would be both large and disclosive.

**Permissions are namespaced `entity.action` and displayed as the action alone.** `grant.revoke` and
`record.read` both read as "revoke" and "read" to a person, while remaining distinct strings, which is
what allows one shape to carry two vocabularies. It also matches how audit event types are written.

**A permission and the event exercising it produce match**, sharing an entity segment and differing
only verb to noun: `grant.create` produces `grant.creation`, `grant.revoke` produces
`grant.revocation`, `ownership.transfer` produces `ownership.transfer`. Both vocabularies are
unbuilt, and they will be written at different times by different people, so the correspondence needs
stating rather than leaving to care.

**Creating access and conferring it are two acts.** The invitation flow is where they visibly come
apart: an invitation carries the grants it will create, addressed to someone with no account, so the
decision exists before any principal holds it. Binding it to a Keycloak subject happens later, at
registration, and makes no new decision. A person decides; the system binds.

So they take separate names, and the separation is a governance control rather than a taxonomy
preference. A service account that can bind a grant to a principal must not thereby be able to decide
a new one, and one capability covering both would give it exactly that. The same split runs through
the vocabulary: defining a role is not assigning one.

### What remains open in this

- **The dictionary is deferred to implementation, and the shape is not.** Names across this corpus
  follow `entity.action` and divide by plane, which is what the design commits to. Which capabilities
  exist is settled against real APIs when building starts.
- ~~Whether a grant's permissions must sit inside the role's ceiling.~~ **Settled: they must.** The
  filter can only remove from the maximum the roles confer, so a grant cannot hand someone a capability
  their role does not carry, and the role is a real gate rather than advice. `effective ⊆ ceiling` is
  asserted at issuance.
- **Which of this is MVP.** The split itself shapes the schema, so it is not deferrable. The
  control-plane vocabulary follows custodianship, which is not in the first release.

## What this closes or reshapes

| Item                                         | Effect                                                                                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Role permissions (open item)                 | Becomes concrete: define the capability vocabulary, then which permissions each role carries. It stops being an open-ended question about what roles mean |
| The create/read/update/delete gap            | Closed by the same work: these are stage one's permissions                                                                                                |
| Single `role` field against a union of roles | Resolved. The contradiction exists only because roles are carried instead of permissions                                                                  |
| `public` synthetic role                      | Becomes a permission set, and stops needing a prose exception in the token schema                                                                         |
| Write versus read access                     | Informed but not settled. A submitter holds `create`; whether that implies read, and scoped to what, remains the separate decision                        |

## What it does not solve

**Attribute evaluation is split across two components, which is the one structural departure.** In
RABAC, and in attribute-based models generally, the decision point evaluates the attributes and
reaches a decision. Usher's controller cannot: it names categories and deliberately never learns what
they select, because it does not know an instance's fields. So the evaluation divides:

    the controller   which (resource, category) pairs does this principal hold?
    the plugin       which records carry that category, in this schema?

Neither half is the decision on its own. This sits close to the rule that a PEP enforces rather than
decides, and the distinction that keeps it true is that the plugin has no say in who may reach what:
it resolves what a category means locally, which is translation rather than policy.

**It is what makes the model deployable here rather than a compromise on it.** Keeping the controller
ignorant of field names is what allows one service across applications with unrelated schemas, and
what removes the per-request call back to it. Stated here because it is a departure by structure
rather than by omitting a feature, and the other three are omissions.

**Provenance scoping.** Restricting a submitter to the records they submitted is an object-identity
question, not a permission question. It still needs either a two-level resource relationship or
record-level enforcement.

**Session attributes, which RABAC does not actually have.** The model defines user and object
attributes only, and a footnote declines the rest: attributes could be associated with sessions,
environment and system, and "User and object attributes suffice for purpose of RABAC." The worked
example still constrains by time of day and by device, and does it by reading them as attributes of
the session's owner, `time(sessionowner(se))` and `device(sessionowner(se))`.

That is better news for Usher than a session-attribute feature would have been. A time-of-day or
connection-origin constraint is expressible as a user attribute, so wanting one does not require
sessions, which Usher does not have. The time-limited admin self-grant is the nearest thing here and
lives in the admin model rather than in the token.

**Role hierarchies.** RABAC preserves them from NIST RBAC. Usher deliberately does not have them,
treating roles as a flat set whose effective permissions are a union. That is a considered
deviation rather than an oversight, and it survives this change intact: a union of permission sets
is well defined without any hierarchy to resolve.
