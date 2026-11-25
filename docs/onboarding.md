<!--
  Source for the Usher onboarding page, published as a Claude artifact.
  Edit the prose freely. The raw HTML blocks hold what Markdown cannot express
  (subtitle, status banner, tables, the numbered flow, the token example, the
  glossary, the footer): leave their markup alone and edit the text inside.
  Keep each of those blocks free of blank lines, or Markdown stops treating it
  as HTML partway through.
  Editing this file does not change the live page. It is rendered by
  .dev/render-onboarding.py and published as the Claude artifact titled
  "Overture User Access Control"; find it by that title in the artifact list.
  The page states what is: it leaves out implementation detail and anything
  phrased as a decision still being made.
-->

# Overture User Access Control

<p class="subtitle">Usher is Overture's access enforcement system. For every application on the platform, it keeps track of what each person has been "granted" permission to see or do, and hands those grants to the applications. It also gives the people who govern access one place to change them. Its role is closer to a keychain than a lock: each application does its own unlocking, and Usher never touches the data it governs. This document is an orientation to that model, to the security properties it rests on, and to the reasoning behind each decision that shaped this design.</p>

## The problem

A platform's data is usually segmented by access level. Some of it is public. Some needs only a registered account. Some is subject to conditions set by the community that contributed it, or by an ethics review. A single record can sit under several conditions at once. A platform holding many datasets almost never applies one access rule to all of them.

Working out which of those conditions apply for each record in a query is the base task on every single request. Four additional factors make this process harder.

- **Access changes.** A permission granted today may be withdrawn tomorrow, and the withdrawal has to take effect quickly across every application that touches the data.
- **The same rules have to hold in several separate applications.** A platform generally is not one program but a set of them, each written and deployed on its own. When each implements the access rules separately, those implementations can drift apart, and a rule change reaching one service but not another leaves access open where it should have closed. That risk is what most directly justifies a separate service over access logic inside each application.
- **Decisions have to be reconstructable.** Governance reviews, regulatory inquiries, and security investigations all need to establish who could see what, and when, without the need for anyone to read source code to find out.
- **Uncertainty is not permission.** If the system cannot work out what someone is entitled to, the correct response is to withhold rather than to fall through to an open default. This principle runs through every decision described below.

## The solution: two questions, two systems

Two questions sit behind every request, and a different piece of software answers each.

- **Who are you?** Keycloak is the open-source identity provider that answers this: it holds the accounts, the groups and the sign-in process, and Overture already integrates it.
- **What may you see or do?** Usher computes the answer and delivers it to each application on request, without ever seeing a password or verifying anyone's identity itself. It keeps the grants in a separate database away from the accounts. Usher's design builds upon Keycloak's without depending on it specifically.

Everything after this section is about that second question, so the first one is worth setting aside now for the sake of clarity. Proving who someone is tells you nothing about what they should be allowed to see or do, and "who" is doing more work than it looks: **not every request comes from a person.** Automated submission workflows, data pipelines and other services request data too, and they are subject to exactly the same decisions on the same terms. Therefore, this document says "person" in most places because it reads more naturally, but the term applies to a service account as much as to a researcher.

The answers to the two questions define everything downstream. Beyond the single "identity" answer, a common platform architecture encompasses several applications (e.g. separate search and submission services), each holding data under different schema shapes, meaning each application needs its own set of grants.

Usher exists so that the second question is decided in one place rather than worked out separately inside each application. The answers differ by application; the authority that produces them does not.

## Three tiers of access

Usher's mental model builds in layers, and the first is how a person comes to hold a grant at all. A grant is Usher's record that one person may do certain things with certain records: it names a dataset, one category of that dataset's records, the role held there, and when it expires. There are three routes, each asking more of them than the last.

**Open.** No sign-in required. Publicly available data: summary counts, published datasets, anything carrying no privacy risk. Even when nobody has signed in, the ushered application still asks Usher what an anonymous visitor may reach, and Usher still answers and records that it answered. So open access is governed by the same machinery as everything else. Usher never sees the search itself or the data that comes back, so what is recorded is that an answer was given, not what anyone looked for.

**Registered.** Anyone who signs in reaches this tier. This tier suits data where accountability matters but a full approval process would be disproportionate.

**Controlled.** Being registered is no longer enough at this tier, and on larger platforms an access committee may review researcher applications first. Access is granted dataset by dataset, deliberately by the dataset's owner.

What exactly a grant covers within a dataset is the next layer of the mental model. The next section is also where the system's own word for a dataset arrives.

## Resources and categories

In Usher, access is granted over a resource, and this section uses that term while the rest of this document says "dataset". The difference is deliberate. "resource" is the system's own word, chosen to be generic so that the model assumes nobody's vocabulary: one platform calls the same thing a study, another a cohort, another a project. "Dataset" is this document's everyday stand-in for it, used the same way and for the same reason as "person" above, and nothing in Usher is named dataset. Definitions belong on the system's own word, so they are here; elsewhere, once you know what is meant, the friendlier word does the work.

**Permission over a resource, rather than restriction on it, inverts what may be the more familiar arrangement**, in which data is readable until a rule closes it off. The reason is how a control failure lands in each. On a good day the two describe exactly the same access. When a rule goes missing from a system that starts open and closes things off, usually by someone's mistake, data that should have been hidden gets served and nothing announces it. When a grant goes missing here, someone is denied data they were entitled to, and complains. One failure is silent and the other is loud, which is why nothing here is reachable until a grant says so.

A second difference from that familiar approach is what a resource actually represents: **a field and its value**, nothing more. Each platform nominates a field already carried by its records: a study identifier, a cohort identifier, or anything else that marks records as belonging together. Every record holding one particular value in that field is one resource. Nobody draws a boundary; the data already has one and the platform points at it. Each record belongs to exactly one resource, so resources do not overlap.

Furthermore, different resources don't require separate "physical" containers. To enforce access control, some systems attach access to a storage location (e.g. separate S3 buckets or search indices), changing a record's permissions when it is moved and therefore two resources cannot overlap without duplicating data. Messy, and avoidable.

**A category is a condition over the records' own fields**, and since that can get confusing next to resources, it is worth slowing down for. A resource's field answers which records belong together, and a category's condition answers which of them need an approval. The simplest condition is a field and a value, and a condition can also combine fields or compare dates:

<pre class="token">  <span class="c">the resource</span>  field: study_id    value: HEART_STUDY
  <span class="c">the category</span>  condition: consent is anything but "no restriction"</pre>

Usher ships no fixed list of categories: each platform defines the ones its own data needs, so a platform holding patient records might name one "controlled", while one holding community-contributed data might name another "community-governed". A condition reads what the records state about themselves, such as where or when they were collected or what consent covers them, never a field that simply says who may see them. A category applies to every dataset whose records match its condition, so no dataset has to list it. Matching one puts those records behind a grant: they go to nobody without a grant naming that category.

The tier names reappear here, and that is not mere coincidence: every resource has one more category, "unmarked", for the records not marked by any other category, and its unmarked records sit at one of the three tiers. At Open, everyone reaches them; at Registered, anyone signed in; at Controlled, only someone deliberately granted access to them. Records marked by a category such as "controlled" are reachable only by people holding a grant on that category, whichever tier the resource's unmarked records sit at.

**A grant reaches a record only when the record matches both its resource and its category.** Take a grant naming HEART_STUDY and the category in the example above. It reaches a record whose "study_id" is HEART_STUDY and whose "access_level" is restricted. A restricted record from another study fails the first check, and an unrestricted HEART_STUDY record fails the second. That is the entire mechanism, and everything below follows from it.

Pairing resource and category prevents two kinds of leak. Naming only the resource would carry everything in it regardless of sensitivity, so a single grant would hand over a community's contributed records along with the clinical ones. Naming only the category would reach across the whole platform: a grant for controlled data in one study would hand over the controlled data in every other study, including those whose own grant was never sought.

To illustrate this better, here are one researcher's grants across four of the resources on an imaginary platform. Grants are held per resource, so each row is its own list rather than a slice of one platform-wide set. The researcher holds the <b>controlled</b> grant for both the heart study and the reef archive. They also hold the <b>open</b> grant on the unmarked records of all four resources, which is why that one appears in every row.

<div class="scroller">
    <table>
      <caption>One researcher's grants, resource by resource</caption>
      <thead>
        <tr><th scope="col">Resource</th><th scope="col">Categories carried by its records</th><th scope="col">Grants they hold</th><th scope="col">What they reach</th></tr>
      </thead>
      <tbody>
        <tr><td><b>HEART_STUDY</b></td><td>unmarked, controlled</td><td>open, controlled</td><td class="o">All of it</td></tr>
        <tr><td><b>LUNG_COHORT</b></td><td>unmarked</td><td>open</td><td class="o">All of it</td></tr>
        <tr><td><b>REEF_ARCHIVE</b></td><td>unmarked, controlled, community-governed</td><td>open, controlled</td><td>Its unmarked and controlled records, and none of its community-governed ones</td></tr>
        <tr><td><b>BRAIN_ATLAS</b></td><td>unmarked, controlled</td><td>open</td><td>Its unmarked records only</td></tr>
      </tbody>
    </table>
  </div>

### How categories behave

The rule behind the "What they reach" column is one line: a grant reaches the records in that resource carrying that category, and nothing else. The lung cohort holds only unmarked records, so the open grant reaches all of it. The reef archive's community-governed records stay out of reach, since this researcher holds no grant for them.

**A category names a condition satisfied by its records, and a grant reaches the records matching it.** For instance, a resource holding both unmarked and controlled records at the Open tier serves its unmarked records to anyone and its controlled records only to someone granted "controlled". The brain atlas shows how a grant falls short instead, since a category held in one resource counts for nothing in another.

**Where a record belongs to two categories, both grants are needed.** A record that is both "controlled" and "Indigenous" is reachable only by someone holding both grants. If either one were enough, a controlled grant alone would reach Indigenous data without its custodian's approval. A record belongs to every category whose condition it matches, so it may belong to several, or to none.

**The one category that works differently is "unmarked", and it includes all records not covered by any other category.** Every other category is defined by a condition on the records: one selecting controlled records, or records contributed by a community. "unmarked" is defined by what is left over, which is why a resource with nothing else categorized is unmarked in full, and why no resource needs to list it.

**At the Open tier, everyone holds the open grant.** It is the one grant held without asking, signed in or not, and it reaches a resource's unmarked records. At the Registered tier, anyone signed in holds it instead. At the Controlled tier, nobody holds it until someone is deliberately granted it. That is how records not marked by any category stay reachable even when they are not open.

**A new resource starts at the tier its registration names.** A resource registered at Controlled has records reachable by nobody until someone is granted that access.

Grants are also what let two people differ on one resource: both may hold its open grant while one may only read those records and the other may change them as well.

## Who holds what

Four kinds of participant hold or govern access. They run from the narrowest to the widest, which is also the order in which a reader is likely to meet them.

<div class="scroller">
    <table>
      <caption>The four participants</caption>
      <thead>
        <tr><th scope="col">Who</th><th scope="col">Applies to</th><th scope="col">Can they see the data?</th></tr>
      </thead>
      <tbody>
        <tr><td><b>Viewer</b></td><td>The categories of a dataset they have been granted</td><td>Yes, as far as their grants cover</td></tr>
        <tr><td><b>Owner</b></td><td>One dataset, and may grant and revoke access to others within it</td><td>Usually yes in practice, because an owner is usually also a viewer</td></tr>
        <tr><td><b>Administrator</b></td><td>The whole platform: registering "resources", granting the submitter and owner roles, revoking any grant, revoking a person outright, signing out everyone</td><td>No. Reaching it takes a self-grant that an owner of the dataset or another administrator decides, and it is recorded like any other grant</td></tr>
      </tbody>
    </table>
  </div>

**Usher has no custodian role.** No one can be appointed to govern a category across every dataset that carries it, so each category's access is decided dataset by dataset.

**Viewer is a family rather than a single role.** Viewer is the one participant who reads data, and reading is three things rather than one: counting records, opening them, and taking a copy away. Changing them is a different kind of act again. So a platform grants one of several reading roles, and the difference between them is exactly which of those a person may do.

Six things can be done with the records of a dataset. They are listed here from the least reach to the most, and each role is a point on that run. The first three are what reading is made of, which is why they sit under one heading.

<div class="scroller">
    <table>
      <caption>What each reading role may do</caption>
      <thead>
        <tr><th scope="col" rowspan="2">Role</th><th scope="colgroup" colspan="3">Read</th><th scope="col" rowspan="2">Create</th><th scope="col" rowspan="2">Update</th><th scope="col" rowspan="2">Delete</th></tr>
        <tr><th scope="col">Count</th><th scope="col">View</th><th scope="col">Export</th></tr>
      </thead>
      <tbody>
        <tr><td><b>Viewer</b></td><td class="o">&#9679;</td><td class="o">&#9679;</td><td class="o">&#9679;</td><td></td><td></td><td></td></tr>
        <tr><td><b>Editor</b></td><td class="o">&#9679;</td><td class="o">&#9679;</td><td class="o">&#9679;</td><td class="o">&#9679;</td><td class="o">&#9679;</td><td></td></tr>
        <tr><td><b>Curator</b></td><td class="o">&#9679;</td><td class="o">&#9679;</td><td class="o">&#9679;</td><td class="o">&#9679;</td><td class="o">&#9679;</td><td class="o">&#9679;</td></tr>
        <tr><td><b>Submitter</b></td><td></td><td></td><td></td><td class="o">&#9679;</td><td class="o">&#9679;</td><td></td></tr>
      </tbody>
    </table>
  </div>

**Exporting sits beside viewing rather than above it, and the reason is honesty.** Taking a file away is a different act from reading a screen, worth its own record in the log and its own approval. It is not a way to stop someone keeping a copy: anyone who can view records can page through them and assemble the same file by hand. So every role that views also exports, and the distinction earns its place by making the bulk route visible rather than by withholding anything.

**Submitter is the one row that is not a point on the run.** Someone contributing data may create records and correct them, and that gives them no ability to read what is already there. Reading their own submissions back is a separate grant, deliberately, so that contributing data and seeing data are decided independently.

**Authority over who may read something is never itself permission to read it, and that is deliberate rather than an oversight.** It holds for owner and administrator, the two roles that govern access. A platform administrator cannot quietly look at data just because they manage the system that governs access to it. And owning a dataset says who may reach it, not that the owner may. Owners usually can, because whoever owns a dataset is usually also one of the people working with it. That reach comes from what they were separately given, not from owning it. What an administrator holds by default is the account list, everyone's grants, and the log of every such decision. Reaching the data itself takes a deliberate act: asking for a grant of it to themselves. An owner of the dataset or another administrator decides that request, never the administrator who asked, and both the request and the decision are recorded like any other grant.

**An administrator cannot read data without a grant either.** Nothing is reachable unless a dataset is published as open or someone has been granted it by name. That applies to a platform administrator exactly as it applies to everyone else. An administrator who needs to see data asks for a grant of it to themselves, and once decided that grant is recorded, visible and revocable like any other.

**An owner's authority covers one dataset.** Categories are defined once for the whole platform, not inside each dataset: "controlled" in one study and "controlled" in another are the same category.

**Grant operations are counted per person.** Usher records how many grant operations one person performs within a set stretch of time, whether creating, answering, changing, revoking or deciding a grant, and flags it when that goes above a configured level. It counts within a period rather than totalling forever, so someone deciding requests steadily over months never trips it, while someone making the same number of changes in one afternoon does.

This flags and does not block. Refusing them would overrule a holder entitled to issue them. What it does instead is make the pattern visible to someone who can ask about it.

## How a decision reaches the data

Everything above is what gets decided: the tiers, the participants, and the datasets and categories named in a grant. What follows is how a decision made from those reaches the data, and what it looks like on the way.

Two different things happen, in two different places, and the whole design rests on keeping them apart. Usher keeps every rule about what each person is allowed to see or do, and those rules live nowhere else. Together, those rules are the **policy**. Applying the policy to one particular request is **enforcement**, and that happens somewhere else entirely: inside each application, in a small part of Usher that runs there, whenever someone asks for something. Everywhere else, this document says "Usher" for its central service.

Usher decides and never touches data. Its part inside each application enforces and never decides. Everything below is how a decision gets from the first to the second.

That decision travels as one object, called the **Usher token**. It is Usher's encrypted answer to "what may this person see or do", issued for a single named application, and only that application can decrypt it.

Usher may genuinely compute a different answer about the same person for each application. The search service manages one set of datasets and the submission service another, so a token issued for one names datasets unknown to the other, with different grants attached.

Naming the application in the token is what makes that safe. A token presented to the wrong application fails to decrypt, rather than being honoured against datasets it was never computed for. The steps below are where a token comes from and what becomes of it.

<ol class="flow">
    <li><b>Someone signs in</b><span>Keycloak verifies who they are and issues proof of identity. No access decision has been made yet.</span></li>
    <li><b>The application asks Usher what this person may see or do</b><span>Not one question per action, in the form "may they open this particular record?", but a single request covering every dataset that application manages, answered in full.</span></li>
    <li><b>Usher computes the answer and encrypts it</b><span>Usher reads the policy, works out every dataset and category covered by this person's grants, and encrypts the result so that only the application it names can decrypt it.</span></li>
    <li><b>The application decrypts the Usher token and applies it</b><span>A small component inside the application turns the Usher token into a filter attached to the query, before that query runs.</span></li>
    <li><b>The data layer returns only what was permitted</b><span>Nothing is filtered out after the fact. Data the person may not reach is never retrieved in the first place.</span></li>
  </ol>

Here is the Usher token for the same researcher, issued to the search service:

<pre class="token"><span class="c">{</span>
  <span class="k">"sub"</span>:         "a4f1c8e2-...",          <span class="c">// the Keycloak account this token refers to</span>
  <span class="k">"iss"</span>:         "usher.example.org",     <span class="c">// the Usher that issued this token</span>
  <span class="k">"aud"</span>:         "search-service",        <span class="c">// the one application this token is valid for</span>
  <span class="k">"exp"</span>:         1718611500,              <span class="c">// when this token stops being honoured</span>
  <span class="k">"generatedAt"</span>: 1718611200,              <span class="c">// when the permissions were last computed</span>
  <span class="k">"permissions"</span>: <span class="c">{</span>                          <span class="c">// keyed by resource identifier</span>
    <span class="k">"HEART_STUDY"</span>:  { "unmarked": {"record": ["view"]}, "controlled": {"record": ["view"]} },
    <span class="k">"LUNG_COHORT"</span>:  { "unmarked": {"record": ["view", "update"]} },
    <span class="k">"REEF_ARCHIVE"</span>: { "unmarked": {"record": ["view"]}, "controlled": {"record": ["view"]} },
    <span class="k">"BRAIN_ATLAS"</span>:  { "unmarked": {"record": ["view"]} }
  <span class="c">}</span>                       <span class="c">// each category, and what may be done there</span>
<span class="c">}</span></pre>

The names in capitals are invented for these examples. They are dataset identifiers, not permission labels. They are the identity of a specific study or cohort as that platform registered it, which is why a grant covering one of them says nothing about the other.

What a platform may treat as a dataset is deliberately open, and the vocabulary section at the end covers it under <b>Resource</b>. Registering one is an administrative action, taken through the Management API, and its mechanics sit outside this document.

<b>sub</b>, <b>iss</b>, <b>aud</b> and <b>exp</b> are standard JWT claims, defined by the same specification every OIDC system uses, so most of this object is not Usher's invention. <b>generatedAt</b> and <b>permissions</b> are, and are the two this document explains. A real token carries more. One member, <b>iat</b>, is the time it was issued. Another names which version of this format it is written in, so that a later version can add something an older application must be told about rather than allowed to ignore. Three more list every dataset served by the application and every category defined, held or not, so the application can check it knows how to recognize each category and withhold any record of a served dataset in which the person holds nothing. Each category's name in a real token begins with its scope, <b>global.</b> for a category defined for the whole platform, so "unmarked" appears as <b>global.unmarked</b>. The lists are never shown to anyone. Each part below earns its place:

<div class="scroller">
    <table>
      <caption>What each part is for</caption>
      <thead>
        <tr><th scope="col">Part</th><th scope="col">Purpose</th></tr>
      </thead>
      <tbody>
        <tr><td><b>sub</b></td><td><b>(Subject)</b> The account the token refers to. Empty for an anonymous request, which still gets a token so that open access is logged like everything else.</td></tr>
        <tr><td><b>iss</b></td><td><b>(Issuer)</b> Which Usher issued the token. Verified on arrival, so a token manufactured somewhere else is rejected rather than trusted.</td></tr>
        <tr><td><b>aud</b></td><td><b>(Audience)</b> The one application the token was made for. This is what makes a token delivered to the wrong application fail to decrypt instead of being quietly honoured.</td></tr>
        <tr><td><b>exp</b></td><td><b>(Expiration)</b> When the token stops being honoured. Short, so it cannot be replayed long after the permissions behind it changed. Applications do not wait for expiry to notice a change: renewal is built in, and a revocation is announced on a live channel rather than waiting for a token to lapse.</td></tr>
        <tr><td><b>generatedAt</b></td><td>When the permissions were last computed. Lets an application reuse a cached token instead of asking again on every request. How long that window lasts is set by the platform's configuration and carried in <b>exp</b>, so an application reads the answer from the token rather than choosing its own interval.</td></tr>
        <tr><td><b>permissions</b></td><td>The answer itself: one entry per dataset reachable by this person in this application. Everything else in the token exists to make this part trustworthy.</td></tr>
        <tr><td><b>payloadVersion</b></td><td>Which version of this format the token is written in, one of those the application said it reads, so a later version can add something an older application must be told about rather than allowed to ignore.</td></tr>
        <tr><td><b>iat</b></td><td><b>(Issued at)</b> When the token was issued. A renewal moves it while <b>generatedAt</b> stays, since the permissions were not computed again.</td></tr>
        <tr><td><b>globalCategories</b></td><td>Every category defined for the whole platform, held or not, so the application can check it knows how to recognize each one.</td></tr>
        <tr><td><b>resourceCategories</b></td><td>Each dataset's own categories, held or not, for every dataset named in <b>permissions</b>.</td></tr>
        <tr><td><b>servedResources</b></td><td>Every dataset served by the application, held or not, so a record of a served dataset in which the person holds nothing is withheld.</td></tr>
        <tr><td colspan="2"><b>Inside each grant entry, one per dataset:</b></td></tr>
        <tr><td><b>the dataset name</b></td><td>The platform's identifier for the dataset this entry is about, as described above. <b>HEART_STUDY</b> and <b>LUNG_COHORT</b> here.</td></tr>
        <tr><td><b>the grants held</b></td><td>One entry per category of that dataset held by this person, each naming what they may do with the records carrying it. The word <b>record</b> sits between the category and the list and every entry says it, because a grant covers whole records. A dataset appears here as soon as any one of its categories has been approved, so this list is what was cleared rather than everything the dataset holds: the records served from it are the ones covered by these categories, and the rest stay out of the answer. The open grant appears here as a grant on "unmarked", alongside the rest, being a grant like any other. Grants are per dataset, so clearing a category in one study counts for nothing in another. Neither ownership nor a custodian's authority appears in this list: both are powers over how access is managed, exercised against Usher itself rather than against the data, so nothing that enforces a query has any use for them.</td></tr>
      </tbody>
    </table>
  </div>

**What the token leaves out matters as much as what it carries.** Two absences mean different things:

A dataset **missing from the list** means no access to any part of it. There is no separate entry recording a denial, because a denial is simply the lack of an entry. Every dataset on the platform beyond these four is invisible to this researcher. A dataset that does appear carries only the categories that were granted, which is the same absence one level down: the reef archive is listed without community-governed, and its community-governed records are as far out of reach as a dataset that never appeared at all.

A token with **no grants at all** means the person may reach nothing, and it is deliberately distinct from a token that failed to arrive. An empty answer is still an answer, and the application can tell the difference between "you may reach nothing" and "I could not find out".

## The decisions

### Nobody has access until someone grants it

The policy records what each person has been given, never what they have been denied. No entry means no access, every time, with no inherited default and no separate list of exceptions to maintain alongside the list of grants.

For governance, the complete answer to what someone can reach is the set of grants on record. Nothing is implied, so an audit is a matter of reading a list rather than inferring from one.

### Mistakes should hide data, not expose it

Adding rather than taking away is also a choice about how the filter is built: start from nothing and add each of the person's grants, or start from everything and subtract what they lack. Software loses pieces, so the question is what each one does when a piece goes missing.

<div class="scroller">
    <table>
      <caption>The same fault, under each approach</caption>
      <thead>
        <tr><th scope="col">If this happens</th><th scope="col">Subtract from everything</th><th scope="col">Add up from nothing</th></tr>
      </thead>
      <tbody>
        <tr><td>Data arrives carrying a label nobody has registered yet</td><td class="o bad">Visible to all</td><td class="o good">Hidden</td></tr>
        <tr><td>A fault drops one piece of the filter</td><td class="o bad">Access widens</td><td class="o good">Access narrows</td></tr>
        <tr><td>A category exists in policy but the application does not know it</td><td class="o bad">Records leak</td><td class="o good">Denied</td></tr>
        <tr><td>The person holds no grants at all</td><td class="o good">Denied</td><td class="o good">Denied</td></tr>
      </tbody>
    </table>
  </div>

Three of the four rows differ, and each of those three widens access under subtraction and narrows it under addition. The fourth is a tie, and no row favours subtracting.

### One place holds the rules, and every application obeys them

Usher holds the policy and makes no data queries of its own. Each application carries a small part of Usher, which asks Usher what to apply, then applies it before any query reaches the data. Applications make no policy decisions themselves.

This keeps the rules consistent as the platform grows. Adding an application does not mean re-implementing the access logic, and when a rule changes or a decision has to be explained, there is exactly one place to look.

### Usher never touches the data it protects

No records are rewritten and no columns added. The rules are applied at the moment of the query.

Applying rules at query time is what separates adopting a policy system from undertaking a data rewrite. A platform can turn Usher on without altering the data it holds, and turning it off leaves nothing behind to clean up.

### The Usher token is encrypted, short-lived, and never reaches the person asking

The Usher token travels to the application holding the data and is decrypted there, never passing through anyone's browser. Each application caches its copy briefly, so most requests need no round trip back to Usher.

Each application has its own key. That gives two properties beyond secrecy: a token delivered to the wrong application fails to decrypt rather than being quietly honoured, and the contents of someone's grants stay out of logs, error reports, and support tickets.

### Silence stops the system rather than coasting on it

Because answers are cached, there is a short window in which a withdrawn permission could still be honoured. Usher keeps a live channel open to announce changes immediately, and each application also checks in with Usher at regular intervals, which catches any announcement missed by the channel.

If an application cannot confirm it is hearing from Usher for longer than a set grace period, it stops serving the data that needed permission. It reports that data unavailable until the channel returns. Openly published data keeps flowing, since nobody needed permission for it and no withdrawal could have applied to it. The application says which part of the answer is missing rather than quietly showing less. This is deliberate. Without it, anyone able to cut the channel could freeze someone's grants exactly as they were, which is a way to retain access after it has been revoked. Treating silence as a denial means cutting the channel gains nothing. An application that has just started serves nothing at all until it has heard from Usher, since it has nothing yet to stand on.

### A refusal does not confirm the data exists

When access is refused, the reply says the data either does not exist or is not available to that person, without distinguishing between the two.

Confirming that a named dataset exists but is off limits is itself a disclosure, and one that can be repeated to map out what the platform holds. There is no exception to this, not even for someone whose own grant has lapsed: an application cannot tell that case apart from a stranger's, because both look the same from where it stands. Usher sends no notice when a grant lapses, so a lapsed grant looks like any other refusal and the person has to ask.

### How fine the control gets is decided by the data, not by Usher

Access is decided from the descriptions already carried by a platform's data, and nothing is ever written into that data to make a decision possible. That single principle decides how fine the control can be, and it decides it per platform rather than once for everyone.

Where the data already distinguishes what is being controlled, a grant reaches the records matching that description and leaves the rest. Where it does not, there is nothing to match on, so a dataset behaves as one undifferentiated thing and a grant reaches all of it or none. Neither case involves adding a sensitivity label to records that do not have one, and this design never crosses that line: labelling data to make it governable would mean rewriting the data to suit the access system, and the access system is supposed to fit the data.

So the honest answer to "how fine can this get" is: as fine as the descriptions already present allow, and no finer. A platform whose records carry nothing marking sensitivity gets whole-dataset grants.

### A layer over Keycloak rather than a system built from scratch

Keycloak already runs on the platform and already holds the accounts, groups and identities. Usher rebuilds none of that: no accounts, no sign-in, no federation with institutional logins. What Keycloak does not offer is an interface safe to give anyone outside a small group of engineers, because administering access through it means handing someone the controls for the whole identity system.

So Usher is the layer above it. Keycloak establishes who someone is. Usher keeps the access policy in a database of its own and computes what a person may see or do. Usher's part inside each application receives that answer and enforces it before any query runs. It then presents access management as a small number of comprehensible tasks, aimed at the people who make access decisions rather than at the people who run the identity system.

**Keycloak does have an authorization feature of its own, and it has been ruled out as a replacement.** It is already deployed, which made it the candidate most likely to make some of this unnecessary. It was set aside on independence: Overture intends to support more than one identity provider, so the rules about who may reach what cannot live inside one of them. Its documentation later answered two questions about it, and neither changed that. It can list what a person may reach, but only for items registered in it one by one, and it hands a data service no filter to apply. And it cannot give a community representative authority over their own data alone, fully audited, with no other administrative rights. Community governance rests on that second requirement, and Usher does not implement the custodian role that would meet it.

Building this layer is a smaller undertaking than building an authorization system from nothing, because authentication, identity and the account model are not rebuilt. And someone responsible for a community's data, or a research administrator, can be given exactly the authority required by their role, without also being given administrative access to the platform's identity infrastructure.

## What Usher is not

**Not a sign-in system.** Identity remains with Keycloak. Usher trusts a verified identity and takes it from there.

**Not a place data lives.** It holds policy, not records, and cannot read the data it governs.

**Not something that changes your data.** Enforcement works from the descriptions already carried by a platform's data and writes nothing into it. Adopting Usher alters no records, and removing it leaves none behind.

**Not an ethics or approval workflow.** It records the outcome of a review and enforces it, while the review itself runs elsewhere, in an application governed by Usher like any other.

**Not a guarantee about copies.** Once data has been exported, Usher no longer governs it. Anything that turns a result into a downloadable file creates a new access boundary that inherits nothing from this one. This is a known limit rather than an oversight, and it bounds what any access control system of this kind can promise.

## Limits

**Usher has not been studied against the frameworks governing Indigenous data.** For First Nations data that is OCAP, the principles of Ownership, Control, Access and Possession administered by the First Nations Information Governance Centre. Inuit and Métis data have frameworks of their own, the National Inuit Strategy on Research and the Métis data governance principles, and the CARE principles apply internationally. Those principles concern who holds authority over data, not only who may read it, so a permissions model is at most a mechanism for honouring them, never evidence of having done so.

**A lapsed grant is not announced.** A refusal cannot say whether a grant expired or never existed, and it should not, and Usher sends no notice of a lapse. A lapsed grant looks like any other refusal, and the person has to ask.

## Terms that may come up

None of this is needed to follow the document. It is here so the vocabulary is not a barrier in discussion.

<dl>
    <dt>Authorization</dt>
    <dd>Deciding what someone may see or do. Distinct from authentication, which is confirming who they are.</dd>
    <dt>Role-centric attribute-based access control, or RABAC</dt>
    <dd>Deciding access in two steps. A role decides which actions someone may take at all, and facts about the person asking, the data and the situation decide which data those actions reach. It is what allows one person to reach some datasets and not others without inventing a new role for every combination.</dd>
    <dt>Policy</dt>
    <dd>Every rule about what each person is allowed to see or do. Usher keeps them all, in one place, and nothing else does.</dd>
    <dt>Enforcement</dt>
    <dd>Applying those rules to one particular request, before any data is fetched. The part of Usher that does it runs inside each application and only shapes the request. The application fetches the data, which is why Usher never touches the data it governs.</dd>
    <dt>Approval</dt>
    <dd>The decision that someone may reach something, made by a dataset's owner. Everything in this document follows from one, since nothing is reachable unless an approval says so.</dd>
    <dt>Grant</dt>
    <dd>Usher's record of an approval: who, which dataset, which category, the role they hold there, and when it expires. The role is what says what they may do, because nothing records that apart from the grant naming it: this document mostly describes the effect rather than naming the role, though the two are one fact. The unit the whole policy is built from. This document says "grant" nearly everywhere, because that is the word on the tables and in the token. Where it says "approval", it means the human decision that a grant is the record of. They come apart only on federated platforms, where a committee at another institution makes the decision and Usher records an outcome it did not decide.</dd>
    <dt>Permission</dt>
    <dd>One thing someone is allowed to do with one kind of data in one dataset, such as reading a record or changing it. A grant is made of these. A permission only counts while the grant carrying it is live, meaning accepted, unexpired and not revoked, so a grant can exist while the permission it would give does not. This document uses "approval" for the act that creates one.</dd>
    <dt>Record</dt>
    <dd>One row of data in a dataset, which is what access is ultimately about. Held deliberately apart from a grant, since Usher holds grants and never holds records: "record" throughout this document means data, never policy.</dd>
    <dt>Resource</dt>
    <dd>Usher's neutral word for a dataset, and the word engineers on this project use. A field and a value: every record holding that value in that field is one resource. Deliberately generic, so the model does not assume anyone's vocabulary, since one platform calls it a study and another a cohort or a project.</dd>
    <dt>Category</dt>
    <dd>One kind of approval a dataset's records can require, named by the platform that defines it, such as controlled or community-governed. Every category is defined for the whole platform. Defined by a condition over the records' own fields, of which a field and a value is the simplest: a resource's field says which records belong together, a category's condition says which of them need an approval, and a record may belong to several categories. Reaching those particular records means holding an approval naming that category on that dataset; the dataset's other records answer to whichever category they carry instead. Every dataset also has "unmarked", for the records not marked by any other category, and its tier decides who reaches them. Which condition defines a category is configuration, not something Usher decides.</dd>
    <dt>Adapter, or Bridge</dt>
    <dd>The small component inside each application that fetches Usher's answer and applies it before a query runs. Where enforcement actually happens. This document treats it as one thing; engineers split it in two, the Bridge, a shared library that fetches and reads Usher's answer the same way in every application, and the adapter, written for each application, which applies that answer to that application's own queries.</dd>
    <dt>Platform</dt>
    <dd>One running Usher and the applications it serves, holding its own datasets, its own categories and its own grants. Engineers call this an instance. Where this document says a platform decides something, it means a choice made once for that Usher and applying across the applications it serves. The software every such platform is built from is called Overture, never the platform.</dd>
    <dt>Ushered application</dt>
    <dd>An application that carries one of those adapters, and so one whose access decisions come from Usher. Worth a word of its own because a platform runs plenty of applications that do not: the search index, the databases, and the sign-in system are all applications, and none of them asks Usher anything.</dd>
    <dt>Fail-secure</dt>
    <dd>The property that anything going wrong results in less access rather than more. The thread running through most of the decisions above.</dd>
    <dt>Revocation</dt>
    <dd>Withdrawing access already granted, and making that take effect promptly everywhere rather than whenever a cached answer happens to expire. A dataset's owner can revoke access within that dataset, and an administrator anywhere.</dd>
  </dl>

<footer>
    Usher is the access enforcement system for Overture. Prepared as an orientation to the permissions and security model and the reasoning behind it.
  </footer>
