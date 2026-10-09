# Delegated access

_How a client acting for a person reaches an Usher-protected application: an assistant's host, a
portal's backend, a pipeline run for someone._

**Status: a draft for review.** Rule A is decided; rule B is proposed for the developer's decision,
marked **Decide**. Nothing here is built.

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

**Decide B: a sign-in token reaches only the application it was issued for.** The controller
accepts a sign-in token from a bridge only when the token's audience names that bridge's
application. The threat is a token captured at one hop, at a server, in a log or by a proxy, being
replayed at another application. With this rule, each hop needs a token of its own, token exchange
at the identity provider is how a client gets one, and forwarding a token issued for something else
fails closed. The security workflow already requires `aud` to be validated without saying what it
must name; this says it. The cost falls on configuration: an identity provider has to issue a
portal's tokens naming each application the portal calls, which Keycloak does with audience mappers,
and the deployment runbook says so.

**The client that asked for a token reaches the trail as its actor.** Usher records a sign-in
token's `azp`, the client it was issued to, beside the subject, and an `act` claim too where the
identity provider adds one; Keycloak adds `act` only with its delegation feature, still a preview.
Access does not change, since the person's grants decide either way.

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
