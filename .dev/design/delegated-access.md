# Delegated access

_How a client acting for a person reaches an Usher-protected application: an assistant's host, a
portal's backend, a pipeline run for someone._

**Status: decided, not built.** Rules A and B are both decided. Two recommendations, marked
**Decide**, await the developer's team.

---

## Who this covers

A client calls an Usher-protected application either for a person or as itself. Acting as itself,
it is a service account holding grants of its own, as [admin-model.md](admin-model.md) sets out, and
nothing below applies. Acting for a person, it holds no access of its own on that request: the
person's grants decide, and the client is recorded beside them.

## One request, traced

A person asks an assistant for HEART_STUDY's controlled records. The assistant's host reaches the
data through an MCP server, which calls the search server that holds it.

1. The person signs in at the identity provider, and the host holds a token whose audience is the
   MCP server.
2. The host calls the MCP server with that token.
3. The MCP server exchanges it at the identity provider for a token whose audience is the search
   server (OAuth 2.0 Token Exchange, RFC 8693, supported by Keycloak from 26.2). The new token's `azp`
   names the MCP server, the client that asked for it.
4. The MCP server calls the search server with the exchanged token.
5. The search server's bridge exchanges that token with Usher's controller as it does any sign-in
   token, sending its own audience identifier, as it already does.
6. The controller validates the token, its audience included, computes the person's permissions,
   and records the person as the subject and the MCP server as the actor.
7. The adapter narrows the query to the person's grants, so the MCP server receives exactly what the
   person would see asking directly, and nothing more.

## The rules

**A: the principal is the person, and the client is the actor.** Decided 2026-10-08. A request made for a person
is decided by that person's grants alone, and Usher's trail records both, so it reads "the assistant
read this for Ana" rather than "the assistant read this". A client never gains access by acting for
someone, and a client reading for nobody is a service account with grants of its own. The
alternative, a client holding broad grants and filtering for each person itself, puts enforcement
back inside the client, which is what the bridge exists to prevent.

**B: a sign-in token works only at an application it is addressed to.** Decided 2026-10-16. The
controller accepts a sign-in token from a bridge only when the token's `aud` claim names that
bridge's application. The identity provider writes the addresses, and Usher checks them; the
identity provider enforces nothing. The threat is a token captured at one place, on a device, in a
log or by a proxy, being replayed directly at an application it was not meant for.

**Addresses are set per client, not per sign-in.** An identity provider cannot know at sign-in what
a person will go on to do. So each client's tokens name every application that client is built to
call, set once when the client is registered, which Keycloak does with an audience mapper on the
client. A portal's tokens name each application the portal calls, and the deployment runbook says
so.

**What it protects, and what it does not:**

- A token addressed to one recipient is refused everywhere else. A desktop assistant's token
  addressed only to the operator's MCP server cannot be replayed directly at the search server.
- A chain in which each service passes a person's sign-in on by token exchange gets a token per hop,
  and forwarding a token addressed to something else fails closed.
- A portal's token names every application the portal calls, so one captured from the portal works
  at each of them, with or without this rule. The rule adds little for such a token.

**The cost is configuration.** Each client needs its audience mapper. A missing one makes that
client's requests fail closed: they are refused, never wrongly accepted. Deployments without Usher
are unaffected.

**The client that asked for a token reaches the trail as its actor.** Usher records a sign-in
token's `azp`, the client it was issued to, beside the subject, and an `act` claim too where the
identity provider adds one; Keycloak adds `act` only with its delegation feature, still a preview.
Access does not change, since the person's grants decide either way.

**A client that cannot keep a secret is named, not proven.** A desktop or browser application is a
public client: it signs in with PKCE and holds no secret, because any secret shipped inside it can be
extracted. Any application can present a public client's ID, so the actor recorded for one is
attribution only. Access does not change, by rule A. The MCP host's connection plan applies this in
§3: a deployment holding controlled data lets only an operator-run MCP server, which can keep a
secret, receive tokens addressed to the search server, so the actor on that path is proven (decided
2026-10-16). Which kinds of client may receive such tokens is set out in the two recommendations
below.

**Decide: each kind of client is decided for itself, and an undecided kind is refused.** No single
rule covers every client, since one would bar legitimate command-line tools. The default for a kind
not yet decided is the secure one: in a deployment holding controlled data, a client that cannot
keep a secret, or that hands the person's token to code that cannot, receives no token addressed to
an Usher-protected application. Command-line tools, such as one downloading files from Score, are
decided with their integration.

**Decide: a browser portal's backend holds the token.** Arranger's components call the search server
from the browser, so a portal that passes the person's token to the page is a client that cannot
keep a secret, and the default above would shut it out of a deployment holding controlled data. In
such a deployment, the portal's backend holds the token and calls the search server itself, and the
page never sees it. This is the backend-for-frontend pattern, the first and strongest of the three
in RFC 10017, OAuth 2.0 for Browser-Based Applications. A script injected into the page can still
send requests through the backend while the page is open, but cannot take the token away. The
backend defends every request against cross-site forgery, the components' downloads included. It
affects Stage, the iMicroSeq portal and OHCRN's researcher interface, each to be checked against its
current wiring.

**Nothing crosses to another identity domain.** A token from this deployment's identity provider is
never sent outside it, and Usher accepts no token issued by another identity provider or another
Usher instance. Trust between Usher instances is the federation posture, which is not decided; see
the roadmap's "Federation posture". Until it is, a client reaching another deployment signs the
person in there, as it would at any outside service.

**A client's own context is outside Usher's reach.** Usher governs an application's answer. Once
that answer is inside a client, in a chat's model context or a pipeline's working set, what the
client does with it is the client's to govern, the same limit stated for exports. A client that
holds governed data beside untrusted content and a way to send data out needs a rule of its own;
the MCP host's connection plan sets one for the assistant.
