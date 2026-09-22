<!--
  Source for the Usher onboarding page, published as a Claude artifact.
  Edit the prose freely. The raw HTML blocks are ones Markdown cannot express
  (subtitle, status banner, tables, the numbered flow, the token example, the
  glossary, the footer): leave their markup alone and edit the text inside.
  Keep each of those blocks free of blank lines, or Markdown stops treating it
  as HTML partway through.
  Editing this file does not change the live page. Ask Claude to render and
  republish.
-->

# Overture User Access Control

<p class="subtitle">Usher is Overture's access control plane. For every application on the platform, it keeps track of what each person may see and do, hands those grants to the applications, and also gives the people who govern access one place to change those grants. Its role is closer to a keychain than a lock: each application does its own unlocking, and Usher never touches the data it governs. This document is an orientation to that model, to the security properties it rests on, and to the reasoning behind each decision that shaped this design.</p>

<p class="status"><b>Status:</b> the requirements are fully defined and implementation is nearly ready to begin. The security mechanism is designed in full, and the permissions model is set out in this document for review. Each ushered application's plugin contract will be settled with that application at integration time, and the administrative interface ships from Usher as a package each portal mounts, reimplementing what the iMS Studies Management service does today. The first integration is the Stage portal over Arranger's search, proven in a development environment, with what it teaches carried to iMS afterwards. The two halves of the environmental submission service follow, Lyric alongside SONG with Score, and then Muse and Singularity complete the iMS MVP on the clinical data side.</p>

## The problem

A platform's data is usually segmented by access level. Some of it is public. Some needs only a registered account. Some carries conditions set by the community that contributed it, or by an ethics review. A single record can sit under several conditions at once. A platform holding many datasets almost never applies one access rule to all of them.

Working out which of those conditions apply for each record in a query is the base task on every single request. Four additional factors make this process harder.

- **Access changes.** A permission granted today may be withdrawn tomorrow, and the withdrawal has to take effect quickly across every application that touches the data.
- **The same rules have to hold in several separate applications.** A platform generally is not one program but a set of them, each written and deployed on its own. When each implements the access rules separately, those implementations can drift apart, and a rule change reaching one service but not another leaves access open where it should have closed. That risk is what most directly justifies a separate service over access logic inside each application.
- **Decisions have to be reconstructable.** Governance reviews, regulatory inquiries, and security investigations all need to establish who could see what, and when, without the need for anyone to read source code to find out.
- **Uncertainty is not permission.** If the system cannot work out what someone is entitled to, the correct response is to withhold rather than to fall through to an open default. This principle runs through every decision described below.

## The solution: two questions, two systems

Two questions sit behind every request, and a different piece of software answers each.

- **Who are you?** Keycloak is the open-source identity provider that answers this: it holds the accounts, the groups and the sign-in process, and Overture already integrates it.
- **What may you see or do?** Usher computes the answer and delivers it to each application on request, without ever seeing a password or performing identity checks of its own. It keeps the grants in a separate database away from the accounts. Usher's design builds upon Keycloak's without depending on it specifically, and support for other authentication providers is planned after the initial release.

Everything after this section is about that second question, so the first one is worth setting aside now for the sake of clarity. Proving who someone is tells you nothing about what they should be allowed to see or do, and "who" is doing more work than it looks: **not every request comes from a person.** Automated submission workflows, data pipelines and other services request data too, and they are subject to exactly the same decisions on the same terms. Therefore, this document says "person" in most places because it reads more naturally, but the term applies to a service account as much as to a researcher.

The answers to the two questions define everything downstream. Beyond the single "identity" answer, a common platform architecture encompasses several applications (e.g. separate search and submission services), each holding data under different schema shapes, meaning each application needs its own set of grants.

Usher exists so that the second question is decided in one place rather than worked out separately inside each application. The answers differ by application; the authority that produces them does not.

## Three tiers of access

Usher's mental model builds in layers, and the first is how a person comes to hold a grant at all. There are three routes, each asking more of them than the last: nothing for the first, a confirmed identity for the second, and a deliberate decision by an owner or custodian for the third. The grants are what reach the data; the tier is how someone gets them.

**Open.** No sign-in required. Publicly available data: summary counts, published datasets, anything carrying no privacy risk. Even when nobody has signed in, the ushered application still asks Usher what an anonymous visitor may reach, and Usher still answers and records that it answered. So open access is governed by the same machinery as everything else. Usher never sees the search itself or the data that comes back, so what is recorded is that an answer was given, not what anyone looked for.

**Registered.** The person confirms their identity in the system, having accepted the platform's terms of access. This tier suits data where accountability matters but a full approval process would be disproportionate.

**Controlled.** Being registered is no longer enough at this tier, and in larger instances an access committee may review researcher applications first. An **instance** here means one running Usher together with the applications it serves, holding its own datasets, its own categories, and its own record of who may reach them. Access is granted dataset by dataset, deliberately by either the dataset's owner or by the custodian who governs that data on the contributing community's behalf.

What exactly a grant covers within a dataset is the next layer of the mental model, and the next section is also where the system's own word for a dataset arrives.

## Resources and categories

Access is granted over a **resource**, and nobody reaches anything until a grant says so. That reverses the more familiar arrangement, in which data is readable until a restriction closes it, and the reversal is deliberate.

**This section says "resource" where the rest of this document says "dataset", and the difference is deliberate.** `resource` is the system's own word, chosen to be generic so that the model assumes nobody's vocabulary: one instance calls the same thing a study, another a cohort, another a project. "Dataset" is this document's everyday stand-in for it, used the same way and for the same reason as "person" above, and nothing in Usher is named dataset. Definitions belong on the word the system uses, so they are here; elsewhere, once you know what is meant, the friendlier word does the work.

The reason is the direction each arrangement fails in. On a good day the two describe exactly the same access. When a rule goes missing from a system that starts open and closes things off, usually by someone's mistake, data that should have been hidden gets served and nothing announces it. When a grant goes missing here, someone is denied data they were entitled to, and complains. One failure is silent and the other is loud, which is why nothing is reachable by default.

A second difference from that familiar approach is what a resource actually is. **It is a field and a value**, nothing more: an instance nominates a field its records already carry, a study identifier or a cohort identifier or anything else that marks records as belonging together, and every record holding one particular value in that field is one resource. Nobody draws a boundary; the data already has one and the instance points at it. In the first version one field identifies a resource, and grouping by more than one field at once, which is what allows a cohort assembled across studies, comes later.

Furthermore, different resources don't require separate "physical" containers. To enforce access control, some systems attach access to a storage location (e.g. separate buckets or search indices), changing a record's permissions when it is moved and therefore two resources cannot overlap without duplicating data.

**A category is also a field and a value, and that is the part worth slowing down for.** It is the same kind of thing as a resource, built the same way, and the only difference is which question it answers. A resource's field answers which records belong together. A category's field answers how sensitive they are. An instance nominates one of each:

<pre class="token">  <span class="c">the resource</span>  field: study_id        value: HEART_STUDY
  <span class="c">the category</span>  field: access_level    value: restricted</pre>

Usher ships no fixed list of categories: an installation defines the ones its own data needs, so a study holding patient records might name one controlled, while one holding community-contributed data might name another community-governed. A resource then lists which of them its records carry, and listing one is what puts those records behind a grant, because they go to nobody without one naming that category.

**Categories are not subdivisions a resource owns, and this is the easiest thing here to get backwards.** They are defined once for the whole platform, and each resource declares which of them apply to its records. So `controlled` is one category that many resources list, not a separate compartment inside each. A resource is divided by them, which is why the containment reading is so natural, but it does not contain them.

**The reason that distinction earns its keep** is the custodian described later on. A community representative governs one category wherever it appears, across every resource on the platform, and that is only coherent because the category is one thing. If `controlled` meant something of its own inside each study, there would be nothing platform-wide to govern and a grant naming it would mean something different in every resource.

The tier names reappear here as category names, and that is the model rather than a coincidence: which tier a resource's records sit at is decided by which category each of them carries. A resource carrying nothing beyond open asks for no grant anyone lacks; one that also carries controlled keeps those particular records for whoever holds the deliberate grant the Controlled tier describes, and serves the rest as it did before.

A grant always names a resource together with one of the categories that resource carries, and neither half works on its own.

**Because both halves are a field and a value, a grant is two tests and a record has to pass both.** Is this record's `study_id` the one the grant names, and is its `access_level` the one the grant names. That is the entire mechanism, and everything below follows from it.

Pairing them is what prevents two kinds of leak. Naming only the resource would carry everything in it whatever its sensitivity, so a single grant would hand over a community's contributed records along with the clinical ones. Naming only the category would reach across the whole platform, so a grant for controlled data in one study would hand over the controlled data in every other study, including those whose own grant was never sought.

To illustrate this better, here are one researcher's grants across four of the resources on an imaginary platform. Grants are held per resource, so each row is its own list rather than a slice of one platform-wide set. The researcher holds the <b>controlled</b> grant for both the heart study and the reef archive, as well as the baseline <b>open</b> grant for all four resources, which is why that one appears in every row.

<div class="scroller">
    <table>
      <caption>One researcher's grants, resource by resource</caption>
      <thead>
        <tr><th scope="col">Resource</th><th scope="col">Categories it carries</th><th scope="col">Grants they hold</th><th scope="col">What they reach</th></tr>
      </thead>
      <tbody>
        <tr><td><b>HEART_STUDY</b></td><td>open, controlled</td><td>open, controlled</td><td class="o">All of it</td></tr>
        <tr><td><b>LUNG_COHORT</b></td><td>open</td><td>open</td><td class="o">All of it</td></tr>
        <tr><td><b>REEF_ARCHIVE</b></td><td>open, controlled, community-governed</td><td>open, controlled</td><td>Its open and controlled records, and none of its community-governed ones</td></tr>
        <tr><td><b>BRAIN_ATLAS</b></td><td>open, controlled</td><td>open</td><td>Its open records only</td></tr>
      </tbody>
    </table>
  </div>

### How categories behave

The rule behind that last column is one line: a grant reaches the records in that resource carrying that category, and nothing else. The lung cohort holds only open records, so the open grant reaches all of it. The reef archive holds community-governed records this researcher has no grant for, so those stay out of reach while the rest does not.

**A category names a condition its records carry, and a grant reaches the records carrying it.** A resource holding both open and controlled records serves its open records to anyone and its controlled records only to someone granted controlled. The brain atlas shows the way a grant falls short instead, since a category held in one resource counts for nothing in another.

**Where a record carries two conditions at once, both grants are needed.** A record that is both controlled and community-governed is reachable only by someone holding both, because a restriction another restriction can bypass is not a restriction. That is what stops a controlled grant from quietly reaching community-governed data it was never meant to touch.

That last part is designed and not yet built, and until it is a record carries one condition at a time. Nothing about it is visible in the first instance, which defines a single category.

**Open is the default category, and it works differently from the others.** Every other category is defined by something the records carry: a field marking them controlled, or marking them contributed by a community. Open is defined by what is left over. It covers whatever the other categories on a resource do not, which is why a resource with nothing else categorized is open in full.

**Everyone holds the open grant.** It is the one grant a person has without asking for it, signed in or not, so a resource carrying only open is reachable by anyone. Every resource carries at least one category, so every resource needs at least one grant.

**An instance has two ways to change that, and both are available from the first release.** It can turn the default off everywhere, so that nothing is open unless open is added to a resource deliberately. Or it can leave the default on and remove open from individual resources, which says that this particular resource holds no open data.

**What a new resource carries follows from those two.** With the default on, a resource is created carrying open, and a warning at submission time says so, so that nobody publishes openly by not choosing. With the default off, a resource is created closed and stays unreachable until someone defines its categories.

Grants are also what let two people differ on one resource: both may hold its open grant while one may only read those records and the other may change them as well.

## Who holds what

Four kinds of participant hold or govern access. They run from the narrowest reach to the widest, which is also the order a reader is likely to meet them.

<div class="scroller">
    <table>
      <caption>The four participants</caption>
      <thead>
        <tr><th scope="col">Who</th><th scope="col">Reach</th><th scope="col">Own data access</th></tr>
      </thead>
      <tbody>
        <tr><td><b>Viewer</b></td><td>The categories of a dataset they have been granted</td><td>Yes, as far as their grants cover</td></tr>
        <tr><td><b>Owner</b></td><td>One dataset, and may grant access to others within it</td><td>No, unless separately granted. Usually yes in practice, because an owner is usually also a viewer</td></tr>
        <tr><td><b>Custodian</b></td><td>One category of sensitive data, across every dataset on the platform</td><td>No, unless separately granted</td></tr>
        <tr><td><b>Administrator</b></td><td>The whole platform: creating datasets, assigning roles, emergency revocation</td><td>None. Reaching it takes a recorded self-grant, like anyone else</td></tr>
      </tbody>
    </table>
  </div>

**One of these four is not in the first release.** Nothing appoints a custodian in it, so the role below is part of the model rather than something an organization can use yet. Everything else in this table is. What that means for the data a custodian would govern is set out under "What comes after the first release" at the end.

**The first row of that table is a family rather than a single role.** Viewer is the one participant who reads data, and reading is not one thing: counting records is different from opening them, and opening them is different from changing them. So an instance grants one of several reading roles, and the difference between them is exactly which of those a person may do.

Six things can be done with the records of a dataset. They are listed here from the least reach to the most, and each role is a point on that run.

<div class="scroller">
    <table>
      <caption>What each reading role may do</caption>
      <thead>
        <tr><th scope="col">Role</th><th scope="col">Count</th><th scope="col">Read</th><th scope="col">Export</th><th scope="col">Create</th><th scope="col">Update</th><th scope="col">Delete</th></tr>
      </thead>
      <tbody>
        <tr><td><b>Surveyor</b></td><td class="o">&#9679;</td><td></td><td></td><td></td><td></td><td></td></tr>
        <tr><td><b>Viewer</b></td><td class="o">&#9679;</td><td class="o">&#9679;</td><td class="o">&#9679;</td><td></td><td></td><td></td></tr>
        <tr><td><b>Editor</b></td><td class="o">&#9679;</td><td class="o">&#9679;</td><td class="o">&#9679;</td><td class="o">&#9679;</td><td class="o">&#9679;</td><td></td></tr>
        <tr><td><b>Curator</b></td><td class="o">&#9679;</td><td class="o">&#9679;</td><td class="o">&#9679;</td><td class="o">&#9679;</td><td class="o">&#9679;</td><td class="o">&#9679;</td></tr>
        <tr><td><b>Submitter</b></td><td></td><td></td><td></td><td class="o">&#9679;</td><td class="o">&#9679;</td><td></td></tr>
      </tbody>
    </table>
  </div>

**Counting without reading is a real thing to want, which is what the first row is for.** A researcher deciding whether a study is worth applying for needs to know how many records match their criteria, not what is in them. A surveyor gets the number and never a record, and it is a deliberate grant rather than something everyone has, because counts over very small groups can identify the people in them.

**Exporting sits beside reading rather than above it, and the reason is honesty.** Taking a file away is a different act from reading a screen, worth its own record in the log and its own approval. It is not a way to stop someone keeping a copy: anyone who can read records can page through them and assemble the same file by hand. So every role that reads also exports, and the distinction earns its place by making the bulk route visible rather than by withholding anything.

**Submitter is the one row that is not a point on the run.** Someone contributing data may create records and correct them, and that gives them no ability to read what is already there. Reading their own submissions back is a separate grant, deliberately, so that contributing data and seeing data are decided independently.

**Authority over who may read something is never itself permission to read it, and that is deliberate rather than an oversight.** It holds for all three of the roles above that govern access. Someone can be given authority over who reads a community's data while having no ability to read it themselves; a platform administrator cannot quietly look at data just because they manage the system that governs access to it; and owning a dataset says who may reach it, not that the owner may. Owners usually can, because whoever owns a dataset is usually also one of the people working with it, but that comes from what they were separately given rather than from owning it. What an administrator holds by default is the account list, the grants everyone holds, and the log of every such decision. Reaching the data itself takes a deliberate act of granting it to themselves, which is recorded like any other grant.

**There is no way around this in the first release, and that is a decision rather than an omission.** Nothing is reachable unless a dataset is published as open or someone has been granted it by name, and that applies to a platform administrator exactly as it applies to everyone else. An administrator who needs to see data grants it to themselves, and that grant is recorded, visible and revocable like any other. What a later release might add is set out under "What comes after the first release" at the end.

**An owner's authority covers one dataset; a custodian's covers one category, across every dataset that carries it.** That is what allows a community to govern its own data across a platform it does not run: when a new dataset declares that category, it falls under the same custodian without anyone assigning it. That is the mechanism the community governance work at the end of this document rests on, and it is why the Controlled tier above puts the decision with a dataset's owner or a category's custodian rather than with a platform administrator.

**Authority that is wide enough to matter is worth watching, so the system counts how fast it is used.** That reach is the point of the role, and it is also what would make the role worth taking over. So Usher records how many grants one person issues within a set stretch of time, and flags it when that goes above a configured level. It counts within a period rather than totalling forever, so someone approving requests steadily over months never trips it, while someone issuing the same number in one afternoon does.

This flags and does not block. A custodian is entitled to issue every one of those grants, so refusing them would be the system overruling the person the community chose. What it does instead is make the pattern visible to someone who can ask about it.

## How a decision reaches the data

Everything above is what gets decided: the tiers, the participants, and the datasets and categories a grant names. What follows is how a decision made from those reaches the data, and what it looks like on the way.

Two different things happen, in two different places, and the whole design rests on keeping them apart. Usher keeps every rule about what each person is allowed to see and do, and it is the only place those rules live. Together, those rules are the **policy**. Applying the policy to one particular request is **enforcement**, and that happens somewhere else entirely: inside each application, every time someone asks for something.

Usher decides and never touches data. The applications enforce and never decide. Everything below is how a decision gets from the first to the second.

That decision travels as one object, called the **Usher token**. It is Usher's encrypted answer to "what may this person see or do", issued for a single named application, and only that application can decrypt it.

Usher may genuinely compute a different answer about the same person for each application. The search service manages one set of datasets and the submission service another, so a token issued for one names datasets the other has never heard of, with different grants attached.

Naming the application in the token is what makes that safe. A token presented to the wrong application fails to decrypt, rather than being honoured against datasets it was never computed for. The steps below are where a token comes from and what becomes of it.

<ol class="flow">
    <li><b>Someone signs in</b><span>Keycloak verifies who they are and issues proof of identity. No access decision has been made yet.</span></li>
    <li><b>The application asks Usher what this person may see or do</b><span>Not one question per action, in the form "may they open this particular record?", but a single request covering every dataset that application manages, answered in full.</span></li>
    <li><b>Usher computes the answer and encrypts it</b><span>Usher reads the policy, works out every dataset and category this person holds a grant for, and encrypts the result so that only the application it names can decrypt it.</span></li>
    <li><b>The application decrypts the Usher token and applies it</b><span>A small component inside the application turns the Usher token into a condition attached to the query, before that query runs.</span></li>
    <li><b>The data layer returns only what was permitted</b><span>Nothing is filtered out after the fact. Data the person may not reach is never retrieved in the first place.</span></li>
  </ol>

Here is the Usher token for the researcher in the table above, issued to the search service:

<pre class="token"><span class="c">{</span>
  <span class="k">"sub"</span>:         "a4f1c8e2-...",          <span class="c">// the Keycloak account this token refers to</span>
  <span class="k">"iss"</span>:         "usher.example.org",     <span class="c">// the Usher instance that issued this token</span>
  <span class="k">"aud"</span>:         "search-service",        <span class="c">// the one application this token is valid for</span>
  <span class="k">"exp"</span>:         1718611500,              <span class="c">// when this token stops being honoured</span>
  <span class="k">"generatedAt"</span>: 1718611200,              <span class="c">// when the permissions were last computed</span>
  <span class="k">"permissions"</span>: <span class="c">{</span>                          <span class="c">// keyed by resource identifier</span>
    <span class="k">"HEART_STUDY"</span>:  { "open": {"record": ["read"]}, "controlled": {"record": ["read"]} },
    <span class="k">"LUNG_COHORT"</span>:  { "open": {"record": ["read", "update"]} },
    <span class="k">"REEF_ARCHIVE"</span>: { "open": {"record": ["read"]}, "controlled": {"record": ["read"]} },
    <span class="k">"BRAIN_ATLAS"</span>:  { "open": {"record": ["read"]} }
  <span class="c">}</span>                       <span class="c">// each category, and what may be done there</span>
<span class="c">}</span></pre>

The names in capitals are invented for these examples. They are dataset identifiers, not permission labels. They are the identity of a specific study or cohort as that instance registered it, which is why a grant covering one of them says nothing about the other.

What an instance may treat as a dataset is deliberately open, and the vocabulary section at the end covers it under <b>Resource</b>. Registering one is an administrative action, taken in the same interface a custodian uses to grant access, and its mechanics sit outside this document.

<b>sub</b>, <b>iss</b>, <b>aud</b> and <b>exp</b> are standard JWT claims, defined by the same specification every OIDC system uses, so most of this object is not Usher's invention. <b>generatedAt</b> and <b>permissions</b> are, and are the two this document explains. A real token carries one more, naming which version of this format it is written in, so that a later version can add something an older application must be told about rather than allowed to ignore. Each part below earns its place:

<div class="scroller">
    <table>
      <caption>What each part is for</caption>
      <thead>
        <tr><th scope="col">Part</th><th scope="col">Purpose</th></tr>
      </thead>
      <tbody>
        <tr><td><b>sub</b></td><td><b>(Subject)</b> The account the token refers to. Empty for an anonymous request, which still gets a token so that open access is logged like everything else.</td></tr>
        <tr><td><b>iss</b></td><td><b>(Issuer)</b> Which Usher instance issued the token. Checked on arrival, so a token manufactured somewhere else is rejected rather than trusted.</td></tr>
        <tr><td><b>aud</b></td><td><b>(Audience)</b> The one application the token was made for. This is what makes a token delivered to the wrong application fail to decrypt instead of being quietly honoured.</td></tr>
        <tr><td><b>exp</b></td><td><b>(Expiration)</b> When the token stops being honoured. Short, so it cannot be replayed long after the permissions behind it changed. Applications do not wait for expiry to notice a change: renewal is built in, and a revocation is announced on a live channel rather than waiting for a token to lapse.</td></tr>
        <tr><td><b>generatedAt</b></td><td>When the permissions were last computed. Lets an application reuse a cached token instead of asking again on every request. How long that window lasts is set by instance configuration and carried in <b>exp</b>, so an application reads the answer from the token rather than choosing its own interval.</td></tr>
        <tr><td><b>permissions</b></td><td>The answer itself: one entry per dataset this person can reach in this application. Everything else in the token exists to make this part trustworthy.</td></tr>
        <tr><td colspan="2"><b>Inside each grant entry, one per dataset:</b></td></tr>
        <tr><td><b>the dataset name</b></td><td>The instance's identifier for the dataset this entry is about, as described above. <b>HEART_STUDY</b> and <b>LUNG_COHORT</b> here.</td></tr>
        <tr><td><b>the grants held</b></td><td>One entry per category of that dataset this person holds, each naming what they may do with the records carrying it. The word <b>record</b> sits between the category and the list because a grant can also cover parts of a record rather than whole ones, which a later release adds; until then every entry says <b>record</b> and the level is there so that adding the other one later changes nothing already built. A dataset appears here as soon as any one of its categories has been approved, so this list is what was cleared rather than everything the dataset holds: the records the application serves from it are the ones these categories cover, and the rest stay out of the answer. The open grant appears here alongside the rest, being a grant like any other. Grants are per dataset, so clearing a category in one study counts for nothing in another. Neither ownership nor a custodian's authority appears in this list: both are powers over how access is managed, exercised against Usher itself rather than against the data, so nothing that enforces a query has any use for them.</td></tr>
      </tbody>
    </table>
  </div>

**What the token leaves out matters as much as what it carries.** Two absences mean different things:

A dataset **missing from the list** means no access to any part of it. There is no separate entry recording a denial, because a denial is simply the lack of an entry, and every dataset on the platform beyond these four is invisible to this researcher. A dataset that does appear carries only the categories that were granted, which is the same absence one level down: the reef archive is listed without community-governed, and its community-governed records are as far out of reach as a dataset that never appeared at all.

A token with **no grants at all** means the person may reach nothing, and it is deliberately distinct from a token that failed to arrive. An empty answer is still an answer, and the application can tell the difference between "you may reach nothing" and "I could not find out".

## The decisions

### Nobody has access until someone grants it

The policy records what each person has been given, never what they have been denied. No entry means no access, every time, with no inherited default and no separate list of exceptions to maintain alongside the list of grants.

For governance, the complete answer to what someone can reach is the set of grants on record. Nothing is implied, so an audit is a matter of reading a list rather than inferring from one.

### Mistakes should hide data, not expose it

Adding rather than taking away is also a choice about how the filter is built: start from nothing and add each grant the person holds, or start from everything and subtract what they lack. Software loses pieces, so the question is what each one does when a piece goes missing.

<div class="scroller">
    <table>
      <caption>The same fault, under each approach</caption>
      <thead>
        <tr><th scope="col">If this happens</th><th scope="col">Subtract from everything</th><th scope="col">Add up from nothing</th></tr>
      </thead>
      <tbody>
        <tr><td>Data arrives carrying a label nobody has registered yet</td><td class="o bad">Visible to all</td><td class="o good">Hidden</td></tr>
        <tr><td>A fault drops one condition from the filter</td><td class="o bad">Access widens</td><td class="o good">Access narrows</td></tr>
        <tr><td>A category exists in policy but the application does not know it</td><td class="o bad">Records leak</td><td class="o good">Denied</td></tr>
        <tr><td>The person holds no grants at all</td><td class="o good">Denied</td><td class="o good">Denied</td></tr>
      </tbody>
    </table>
  </div>

Three of the four rows differ, and each of those three widens access under subtraction and narrows it under addition. The fourth is a tie, and no row favours subtracting.

### One place holds the rules, and every application obeys them

Usher holds the policy and makes no data queries of its own. Each application carries a small component that asks Usher what to apply, then applies it before any query reaches the data. Applications make no policy decisions themselves.

This keeps the rules consistent as the platform grows. Adding an application does not mean re-implementing the access logic, and when a rule changes or a decision has to be explained, there is exactly one place to look.

### Usher never touches the data it protects

No records are rewritten, no columns added, no migration run. The rules are applied at the moment of the query.

Applying rules at query time is what separates adopting a policy system from undertaking a data migration. An instance can turn Usher on without altering the data it holds, and turning it off leaves nothing behind to clean up.

### The Usher token is encrypted, short-lived, and never reaches the person asking

The Usher token travels to the application holding the data and is decrypted there, never passing through anyone's browser. Each application caches its copy briefly, so most requests need no round trip back to Usher.

Each application has its own key. That gives two properties beyond secrecy: a token delivered to the wrong application fails to decrypt rather than being quietly honoured, and the contents of someone's grants stay out of logs, error reports, and support tickets.

### Silence stops the system rather than coasting on it

Because answers are cached, there is a short window in which a withdrawn permission could still be honoured. Usher keeps a live channel open to announce changes immediately, with regular polling as a fallback if that channel drops.

If the channel stays quiet for longer than a set grace period, applications stop serving the data that needed permission and report themselves unavailable for it until the channel returns. Openly published data keeps flowing, since nobody needed permission for it and no withdrawal could have applied to it, and the application says which part of the answer is missing rather than quietly showing less. This is deliberate. Without it, anyone able to cut the channel could freeze someone's grants exactly as they were, which is a way to retain access after it has been revoked. Treating silence as a denial means cutting the channel gains nothing.

### A refusal does not confirm the data exists

When access is refused, the reply says the data either does not exist or is not available to that person, without distinguishing between the two.

Confirming that a named dataset exists but is off limits is itself a disclosure, and one that can be repeated to map out what the platform holds. There is no exception to this, not even for someone whose own grant has lapsed: an application cannot tell that case apart from a stranger's, because both look the same from where it stands. Telling someone their own grant has lapsed is Usher's job rather than the application's, and it is done by notice rather than by a hint in a refusal. Those notices come after the first release, so until then a lapsed grant looks like any other refusal and the person has to ask.

### How fine the control gets is decided by the data, not by Usher

Access is decided from the descriptions an instance's data already carries, and nothing is ever written into that data to make a decision possible. That single principle decides how fine the control can be, and it decides it per instance rather than once for everyone.

Where the data already distinguishes what is being controlled, a grant reaches the records matching that description and leaves the rest. Where it does not, there is nothing to match on, so a dataset behaves as one undifferentiated thing and a grant reaches all of it or none. Neither case involves adding a sensitivity label to records that do not have one, which is the line this design does not cross: labelling data to make it governable would mean rewriting the data to suit the access system, and the access system is supposed to fit the data.

So the honest answer to "how fine can this get" is: as fine as the descriptions already present allow, and no finer. An instance whose records carry nothing marking sensitivity gets whole-dataset grants, which is what the current requirements ask for.

### A layer over Keycloak rather than a system built from scratch

Keycloak already runs on the platform and already holds the accounts, groups and identities. Usher rebuilds none of that: no accounts, no sign-in, no federation with institutional logins. What Keycloak does not offer is an interface anyone outside a small group of engineers can safely be given, because administering access through it means handing someone the controls for the whole identity system.

So Usher is the layer above it. Keycloak establishes who someone is. Usher keeps the access policy in a database of its own, computes what a person may see or do, and delivers that answer to each application, which enforces it before any query runs. It then presents access management as a small number of comprehensible tasks, aimed at the people who make access decisions rather than at the people who run the identity system.

**Keycloak does have an authorization feature of its own, and whether it could replace part of this is still being assessed.** It is already deployed, which makes it the candidate most likely to make some of this unnecessary, so three questions need answers rather than assumptions. Whether it can hand a data service a filter to apply, rather than only answering yes or no about one item at a time. Whether authorization could stay independent of the identity provider, which matters because the platform intends to support more than one. And whether a community representative could be given authority over their own data alone, fully audited, with no other administrative rights. That last is the requirement least likely to be met by an off-the-shelf feature, and it is the one the whole community-governance decision rests on.

Building this layer is a smaller undertaking than building an authorization system from nothing, because authentication, identity and the account model are not rebuilt. And someone responsible for a community's data, or a research administrator, can be given exactly the authority their role requires, without also being given administrative access to the platform's identity infrastructure.

## What Usher is not

**Not a sign-in system.** Identity remains with Keycloak. Usher trusts a verified identity and takes it from there.

**Not a place data lives.** It holds policy, not records, and cannot read the data it governs.

**Not something that changes your data.** Enforcement works from the descriptions an instance's data already carries and writes nothing into it. Adopting Usher alters no records, and removing it leaves none behind.

**Not an ethics or approval workflow, in the first release.** It records the outcome of a review and enforces it, while the review itself runs elsewhere. This is the one item on this list with a date rather than a principle behind it: running the review is close enough to governing access that it may well be built here later, and the others are things Usher is not by design.

**Not a guarantee about copies.** Once data has been exported, Usher no longer governs it. Anything that turns a result into a downloadable file creates a new access boundary that inherits nothing from this one. This is a known limit rather than an oversight, and it bounds what any access control system of this kind can promise.

## Where it stands

The security mechanism is the most fully specified part of the design: how answers are issued, how applications verify them, how a permission change propagates, and how the system behaves when the change channel fails.

The permissions model covers its core structure, and the one substantial piece of design still ahead of it is the database schema, which the rest of the implementation waits on. The application plugin contract exists as design intent rather than as a specification with exact shapes. The administrative interface is settled as far as its shape goes, a package each portal mounts rather than a screen Usher serves, and unsettled on what it is handed to display.

Two design faults were found while preparing the first integration, and in both the system would have granted access it should have refused, which is the opposite of everything described above. Both are now resolved in the design, before any code was written against them. One was an unauthenticated request producing no filter at all, where producing no filter means no restriction rather than a strict one; it now produces an explicit list of what an anonymous visitor may reach, which is empty where the answer is nothing. The other concerned saved sets. A researcher can pick records and save them as a set to come back to, and that set remembers which datasets its records came from, so that access to the set can be checked against access to its sources. The check worked by listing the datasets that ushered application had been set up to recognize, then excluding the ones the person lacks. A record from a dataset the application had never been told about was on neither list, so it passed unchecked. Saving such a set is now refused outright, at the moment it is saved. That is the only point at which both the set's sources and the instance's full list are known, so it is the only point the check can be made.

The honest summary is that the safety properties are settled and the parts people would actually touch are not. That order is deliberate: the decisions above are expensive to change once code depends on them, and an interface is not.

## What comes after the first release

**Nothing in this section is in the first release, and nothing above depends on it.** It is here because each item changes what Usher can promise, and a reader deciding whether it fits their situation needs to know which promises are available now and which are not. Elsewhere this document describes what is being built; here it describes what is not.

**Community governance of a community's own data.** The model carries a custodian role: authority over one category of data across every dataset that holds it, exercised without platform administrator rights, so that people who govern a body of data can decide who reaches it on a platform they do not run. The role is in the design and not in the first release, because nothing appoints a custodian in it. Until something does, a category that would be governed this way has no custodian to ask, and an administrator can reach that data by granting it to themselves. That grant is recorded, and it is approved by nobody outside the platform team.

**The standard this should be studied against is OCAP, and that study has not happened.** Indigenous data governance in Canada is set out in the First Nations principles of Ownership, Control, Access and Possession, administered by the First Nations Information Governance Centre. Those principles concern who holds authority over data, not only who may read it, so a role in a permissions model is at most a mechanism for honouring them and never evidence of having done so. The order of work is deliberate: get the underlying capability right, then study what OCAP asks of it together with the communities concerned, rather than assert alignment from a design. Anyone reading this document to decide whether Usher meets an Indigenous data governance obligation should read it as describing a system that is not yet ready to be assessed against one.

**A record answering to more than one condition at once.** A record that is both controlled and community-governed should need both grants, and today the underlying query layer cannot express that test. Until it can, a record answers to one condition at a time, and a dataset whose records need to be governed under two overlapping conditions has to separate them.

**Holding data back for a period.** Every mechanism described above works by conferring reach, so the way to make something unreachable is to confer nothing. An embargo is the other shape: data a grant would otherwise reach, withheld until a date passes. It needs a design of its own because it is the one rule that takes access away rather than conferring it, and a rule of that kind has to fail closed, so that a system unable to determine whether an embargo has lifted withholds rather than serves. Nothing in the first release withholds this way.

**Grouping data by more than one thing at once.** In the first version a single field identifies a dataset, so datasets cannot overlap. Grouping records by more than one field, which is what allows a cohort assembled across studies, comes later.

**Telling someone their access has lapsed.** A refusal cannot say whether a grant expired or never existed, and it should not. Usher notifying the person directly is what closes that gap, and those notices come after the first release. Until then a lapsed grant looks like any other refusal and the person has to ask.

**A way for an administrator to read without a grant.** A later release may let an organization switch this on. If it is built, it will be off unless someone deliberately turns it on, and it will be bounded rather than total, so an organization can confine it to named datasets or to every category except the ones it names. Two things are not settled and both matter: whether a read made this way is recorded the way a self-grant is, and whether it may apply to community-governed data at all. Until the second is answered, this is exactly the capability the community governance work above has to be weighed against.

**Identity providers other than Keycloak.** Usher's design does not depend on Keycloak specifically, and support for other providers is planned after the initial release.

## Terms that may come up

None of this is needed to follow the document. It is here so the vocabulary is not a barrier in discussion.

<dl>
    <dt>Authorization</dt>
    <dd>Deciding what someone may see or do. Distinct from authentication, which is confirming who they are.</dd>
    <dt>Attribute-based access control, or ABAC</dt>
    <dd>Deciding access from facts about the person asking, the data, and the situation, rather than from a fixed job title. It is what allows one person to reach some datasets and not others without inventing a new role for every combination.</dd>
    <dt>Policy</dt>
    <dd>Every rule about what each person is allowed to see and do. Usher keeps them all, in one place, and nothing else does.</dd>
    <dt>Enforcement</dt>
    <dd>Applying those rules to one particular request, before any data is fetched. It happens inside each application rather than in Usher, which is why Usher never touches the data it governs.</dd>
    <dt>Approval</dt>
    <dd>The decision that someone may reach something, made by a dataset's owner or by a category's custodian. Everything in this document follows from one, since nothing is reachable unless an approval says so.</dd>
    <dt>Grant</dt>
    <dd>Usher's record of an approval: who, which dataset, which category, the role they hold there, and when it expires. The role is what says what they may do, because nothing records that apart from the grant naming it: this document mostly describes the effect rather than naming the role, though the two are one fact. The unit the whole policy is built from. This document says "grant" nearly everywhere, because that is the word on the tables and in the token. Where it says "approval", it means the human decision that a grant is the record of. They come apart only in federated instances, where a committee at another institution makes the decision and Usher records an outcome it did not decide.</dd>
    <dt>Permission</dt>
    <dd>One thing someone is allowed to do with one kind of data in one dataset, such as reading a record or changing it. A grant is made of these. A permission only counts while the grant carrying it is live, meaning accepted, unexpired and not revoked, so a grant can exist while the permission it would give does not. This document uses "approval" for the act that creates one.</dd>
    <dt>Record</dt>
    <dd>One row of data in a dataset, which is what access is ultimately about. Held deliberately apart from a grant, since Usher holds grants and never holds records: "record" throughout this document means data, never policy.</dd>
    <dt>Resource</dt>
    <dd>Usher's neutral word for a dataset, and the word engineers on this project use. A field and a value: every record holding that value in that field is one resource. Deliberately generic, so the model does not assume anyone's vocabulary, since one instance calls it a study and another a cohort or a project.</dd>
    <dt>Category</dt>
    <dd>One kind of approval a dataset's records can require, named by the instance that defines it, such as controlled or community-governed. Built the same way a resource is, from a field and a value, and the only difference is the question it answers: a resource's field says which records belong together, a category's says how sensitive they are. Reaching those particular records means holding an approval naming that category on that dataset; the dataset's other records answer to whichever category they carry instead. Which field and which value is configuration, not something Usher decides.</dd>
    <dt>Custodian</dt>
    <dd>Someone with authority over access to a particular kind of data, typically on behalf of the community that contributed it, and able to act without platform administrator rights. Called a custodian rather than a steward because the requirements this design answers to already use "data steward" for a dataset's owner, which is the Owner above rather than this role.</dd>
    <dt>Plugin, or bridge</dt>
    <dd>The small component inside each application that fetches Usher's answer and applies it before a query runs. Where enforcement actually happens.</dd>
    <dt>Instance</dt>
    <dd>One running Usher and the applications it serves, holding its own datasets, its own categories and its own grants. Where this document says an instance decides something, it means a choice made once for that Usher and applying across the applications it serves.</dd>
    <dt>Ushered application</dt>
    <dd>An application that carries one of those plugins, and so one whose access decisions come from Usher. Worth a word of its own because a platform runs plenty of applications that do not: the search index, the databases, and the sign-in system are all applications, and none of them asks Usher anything.</dd>
    <dt>Fail-secure</dt>
    <dd>The property that anything going wrong results in less access rather than more. The thread running through most of the decisions above.</dd>
    <dt>Revocation</dt>
    <dd>Withdrawing access already granted, and making that take effect promptly everywhere rather than whenever a cached answer happens to expire.</dd>
  </dl>

<footer>
    Usher is the user access control system for the Overture platform. Prepared as an orientation to the permissions and security model and the reasoning behind it.
  </footer>
