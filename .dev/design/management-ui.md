# Access Management UI

_Status: in progress. What it is and how it ships are settled: a package this repository publishes
and portals mount, rendering data handed to it. What it is handed, as a typed interface, is not, and
needs the consuming portal in the room._

---

## Concept

The access management UI is Usher's **PAP (Policy Administration Point)** layer: the interface
through which administrators manage who can access what, without requiring Keycloak admin access
or any IdP-level configuration.

Target audience: data access administrators and resource coordinators. The UI presents
domain-specific language configurable per instance (in an iMS instance, "resources" appear
as "studies"; roles appear as "study enrolments").

**It ships as a package from this repository and portals mount it**, rather than each portal building
its own. The existing iMS surface is the input for most of it.

**One part has no precedent and must not be mistaken for a port.** The iMS surface grants access as a
flat list of holders on a resource. Its `sampleType` is a single classification chosen once when a
resource is created, so a resource is one thing or the other and never both, and nobody holds a
resource for one classification and not another. That split exists in that application's submission
pages and is unconnected to its access-management feature, which contains no category-style scoping
at all. Checked against their code with the owner rather than inferred.

So per-category granting is new design on both sides: no data in the first deployment carries a field
that distinguishes categories, and no management surface anywhere grants one. That is a reason to
label it rather than to drop it, and the risk is that the feature around it does have a
working implementation, which makes it easy to assume this part does too.

Three consequences follow, and the first two are why the shape is worth choosing now rather than at
build time.

**Two guarantees, in two places, and only one of them is the package's.** A portal showing what
someone holds must never disclose what exists and they lack. What the data _contains_ is Usher's
read to enforce: the endpoint returns what a principal holds and nothing else, so nothing downstream
can render what they lack. What the rendering _implies_ is the package's, and it can leak while every
value is correct. "Three of seven studies" discloses that seven exist. So does an affordance for
something unreachable, or an empty state that distinguishes nothing-here from nothing-for-you. Those
are choices, easy to get wrong independently in two codebases, and putting them in one place is the
argument for a package.

**The principle is not the package's alone, and only here does it have a home.** Search components, a
portal's own pages and an API describing its own fields all render governed data and can all
disclose the same way. None is covered yet; see the rendering item in [to-discuss.md](to-discuss.md).

**The contract narrows.** What needed specifying was an open interface between Usher and any portal.
What actually needs specifying is what the package asks Usher for, plus how a portal mounts it. The
second is small and the first has one consumer.

**The package renders and does not fetch, which puts the server side on the host.** Reading a
decrypted token is the bridge's job and the bridge cannot run in a browser, so a package that fetched
for itself would need a server in every host before any host could use it. One that renders from data
it is handed works in a server-rendered portal and a browser-only one alike, with each supplying the
data by whatever means it has. The host decrypts, because the host holds the key.

**Five constraints a consuming portal imposes**, four of them integration facts already true in
Stage rather than preferences:

- **Theming is an input, and it is CSS custom properties rather than a theme object.** Fixed styling
  looks foreign in a host and gets forked, so theming has to come from outside. Which mechanism is
  not a spelling choice: a JS theme object passed through React context and a Tailwind or shadcn
  theme are different interfaces, the second being custom properties consumed by utility classes
  with variants by class composition. Custom properties are the one input both can supply, since
  Tailwind v4 defines its theme as them, shadcn's convention is CSS variables for colour, and a
  CSS-in-JS runtime reads `var(--x)` without difficulty. A theme object would be correct for a host
  today and wrong for the same host after a migration already decided.

  **The two-stack case is the expected path rather than a hedge.** The first host's move to the
  utility-class stack is decided and unstarted, with no replacement framework chosen, so this package
  ships while that host is still on CSS-in-JS and the host migrates underneath it afterwards. Same
  package, same host, two stacks, in that order, with no re-theming in between. That is what the
  custom-properties input is for, and without it the package would need retheming at the exact moment
  the host has the least attention to spare.

  **On the older stack the host supplies the bridge**, which is work to expect rather than to
  discover: a host themed by a JS object emits those values as custom properties on a root element,
  and the package reads them without knowing which stack produced them. Small, and it belongs to the
  host because only the host knows its own theme.

- **No data model or vocabulary is hardcoded in rendered output.** A host resolves its catalogues at
  runtime precisely so no model is baked in, and an instance calls resources studies and roles study
  enrolments. This is the domain-label question answered from the consumer side, and it is settled by
  both: nothing names one deployment's concepts on screen.
- **The data source is injectable**, per the paragraph above.
- **Components, not routes.** Where an administrative surface sits in a host's navigation is the
  host's decision, so the package assumes no route and no menu entry.
- **No store of its own.** Everything rendered is derivable from what Usher returns plus what the
  host injects. The moment the package needs its own data, a host is maintaining two sources for one
  fact.

**The read shape is the package's input type**, which relocates a question rather than leaving it
open. Usher's endpoint produces that type and the host is a pipe between them, so specifying the
component's inputs specifies the contract, and that is a more concrete thing to design than an
endpoint in the abstract.

**One input for obtaining data, used by every path including the package's own**, and this comes from
a failure the same pattern has already produced next door. Arranger's components take a theme and an
injectable fetcher, which is this shape exactly. A host routes that fetcher through its own proxy, so
the fetcher ignores the URL it is handed and rebuilds the path from its own configuration. Every call
honours that except one bootstrap read inside the provider, which passes an unscoped URL and a
pre-prefixed endpoint on the assumption that the fetcher uses what it is given. The two conventions
compose into a doubly-prefixed path that returns 404.

What makes it worth designing against rather than testing for: it surfaces only in a host whose
injection does something non-obvious, and proxy routing is exactly that case, so it appears in the
host's environment and never in the package's own tests. A set of inputs where one path can bypass
the others has this defect available; a single uniformly-used one does not. If the package needs a
read before it can render, that read goes through the same input as everything else.

**The empty-state convention is guidance for hosts, not only an internal rule.** A host renders its
own empty and error states on the screens either side of this surface, so it can disclose the
distinction the package is careful about, in a place the package does not control. Stating the
convention in the package's documentation is what gives a host the chance to hold it.

**How the stylesheet reaches the host is an interface decision, not a build detail.** Either the host
imports a stylesheet or the package injects one, and never both: a package doing both leaves the
intended consumption model ambiguous, and an auto-injected CSS import throws in plain Node, where
`require()` cannot parse a `.css` file. Nothing internal to the package may assume a path only the
package's own build resolves either, since a path alias surviving into shipped type declarations
means nothing to a consumer. Both failures are reported from an Overture package on the target stack,
described from a reading some weeks old and not found in that repository's current state, so the
lessons are recorded here and the example is not cited as a place to look.

**Constraints gathered from a consuming application need a date on them.** Three offered here
described something other than what a package must support: a client-side session check framed as a
browser-only architecture, a styling system the host has already decided to leave, and an unmerged
pull request described as a package the platform has. Each was caught, none by this side. Where a
host is mid-migration, "how it works now" and "what it will need" diverge, and a published interface
has to be built against the second.

The practice that follows is cheap: label an integration fact as current implementation or durable
requirement when it is offered, and where it is current-but-changing, say what it is changing to. All
three would have been caught at the point of writing rather than afterwards. Applied to a precedent,
the same question is whether the thing exists, ships, and can be installed, because "a package X has"
and "an open pull request against X" are different claims that sound alike.

**It does not gate data access.** Enforcement lives in the service holding the data, so a portal that
has not mounted any of this still shows correctly filtered results.

**A denial vocabulary exists to start from, and it belongs to the management plane rather than the
data plane.** The iMS backing service returns a typed error rather than a bare status, and the
interface maps each to its own message: two not-found variants, one for the resource and one for the
holders, already-exists, already-holds, does-not-hold, one failure type per write, and an unknown
catch-all. That is the difference between telling someone a person already has access and telling
them something went wrong.

**Adopting it needs one rule the original did not have to carry.** Existence denial governs data
reads, and these are writes to the grant store, so "already has access" discloses nothing about
records. The exception is the resource itself: a principal asking about a resource they do not manage
must not be able to tell not-found from not-permitted, or the management API becomes the enumeration
oracle the query path refuses to be.

**The profile half ports more cleanly than it looks.** The iMS view derives what someone holds by
parsing JWT scope claims in the browser, which this design rules out, and the parsing is isolated in
one hook while the rendering component takes already-computed values and does no token handling.
So the view survives the move to a server-side read essentially unchanged and only the derivation is
rebuilt. Where that read comes from is therefore the whole of the work rather than part of it.

---

## Known scope

- **Resource management:** register and describe resources available in Usher.
- **Role management:** define the roles available for assignment (e.g. owner, viewer).
- **Category management:** define categories and assign them to resources. The interface cannot tell
  an operator whether a category scopes records or fields, because Usher does not know: what a
  category selects is the adapter's mapping. What it can show is how a category has been used in
  grants, which is the nearest honest answer and is read rather than asserted.
- **Granting:** give a holder a role on one category of one resource, and revoke it. There is no
  separate step assigning someone a role first: the grant carries the role, so the control is a
  holder, a category and a role together rather than two operations. A holder is a person in the
  first release and a group later, which the same control serves. A grant may also name a field
  category within the record category, which is post-MVP and is one more input on the same control
  rather than a second surface.
- **Grant state:** show whether a recipient accepted, when they answered, and what they were shown
  at the time. All three come from the decision record and none are derivable from the grant.
- **Custodian appointment:** assign and remove the custodians who approve access to a data
  category. This is the control standing between an administrator and community-governed data, so
  its own constraints are a governance question rather than a UI one; see the appointment item in
  [decisions.md](decisions.md).
- **Revocation controls:** trigger emergency revocation for a user, all users of a resource, or
  platform-wide (global revocation requires explicit confirmation).
- **Audit log:** record of all access decisions, permission changes, and revocation events. Scope,
  retention policy, and queryability are not yet designed.

---

## Open questions

### Domain label configurability

**Half answered.** `entities` and `capabilities` each carry `display_name` and `description`, which
is where per-instance wording lives: `resource` displays as "Study", `record.export` displays as
"Download". Those are columns in Usher rather than host configuration, for the reason this package
exists at all, that a label supplied by each host separately is the same label maintained twice.

What is still open is everything not covered by those two tables: how the labels are edited, whether
through a settings surface or a deployment-time load, and what a multi-tenant instance does when two
tenants want different words for one entity.

### User search and identity resolution

The UI needs to let admins find users by name or email to add them to a resource. This requires
querying the IdP's user directory. How does Usher integrate with the IdP's user search API, and
what happens when a user exists in Usher's policy store but not (or no longer) in the IdP?

### Audit log design

Where is the audit log stored? Options: Usher's own database (queryable from the UI), an
external logging service (shipped via structured log output), or both. What is the required
retention period (this may be governed by data governance policy per instance). Should the
log be queryable through the UI, or export-only?

### Request and approval workflows

Should the UI support a workflow where a user requests access to a resource or category grant,
and an admin approves or denies? This is relevant for DACO-style gated access (ethics-review-
required). Not in current scope but should be considered in the UI architecture so it can be
added without a full redesign.

### Multi-tenancy

Can one Usher instance serve multiple independent organizations, each with their own resources,
roles, and administrators? If so, the UI needs tenant isolation and per-tenant admin roles. If
not, each organization deploys its own Usher instance.
