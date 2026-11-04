# Client Integration

_Status: designed. What every client of an Usher-protected service receives and does with each
answer, and what a portal adds for the person using it._

---

## Concept

An Usher-protected service answers its clients through the bridge and the application's adapter,
and a client never sees the Usher token or the permissions inside it. This document is the client's
side of that boundary, as [adapter-integration.md](adapter-integration.md) is the service's.

Two kinds of client read it:

| Client                                                   | Who reads the answer                                 |
| -------------------------------------------------------- | ---------------------------------------------------- |
| A script, a notebook, a command-line tool, curl          | The person running it, from the status and the body  |
| A portal: its server proxies requests, its pages render  | The portal's code, which writes its own text for the person |

The rules under [Every client](#every-client) hold for both. [Portals](#portals) adds what a person
sees.

---

## Every client

### What each answer means

| Answer                                                        | Meaning                                                                                                      | What the client does                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `200` with `Usher-Suspended: true`                            | The principal's grants are on hold, so only the data available to everyone was served                       | Treat the results as limited, never as complete, and ask again later for the full set                    |
| `401` with `WWW-Authenticate: Bearer error="invalid_token"`   | A refused identity: the sign-in token is expired, invalid or revoked, and the answer never says which        | Renew the sign-in token once and retry once; see [Renewal](#renewal)                                    |
| `400` with `WWW-Authenticate: Bearer error="invalid_request"` | The request carried more than one credential, or one anywhere but the `Authorization` header                 | Send one bearer token, in the `Authorization` header; retrying unchanged gets the same answer             |
| `403`                                                         | The application denied what was asked: nothing granted reaches it                                            | Do not renew, since a new token holds the same grants; tell the person, or stop                          |
| `503` with `Retry-After`                                      | Access could not be confirmed: the service cannot reach Usher, or the request needs a grant that is on hold  | Wait the interval, then retry; it is not a sign-in problem, so do not renew                              |

**The bodies are short fixed texts, the same for every reason behind them.** The `401` reads "Sign in
again for a new token, or leave the token out to get the data available to everyone." A refusal never
says why, and a narrowed answer never says what it withheld, since either would tell a stranger which
data exists. See [decisions.md](decisions.md) § A refused identity gets one 401, whatever the reason,
and § A denial is named at catalogue level, and never at record level.

**A GraphQL endpoint answers inside the response.** A GraphQL response's status speaks for the whole
request, so a refused operation is a GraphQL error carrying a stable code, with no data, while an
HTTP route such as an export answers with the status itself. The text and the retry interval are the
same either way.

**Leaving the token out is always allowed.** A request with no credential is never suspended, and is
served the data available to everyone, once the service has reached Usher at least once since it
started; before then, every request gets the `503`. That is the path a revoked identity still has.

### Renewal

A client renews its sign-in token once per refusal, and a `401` that persists after a successful
renewal is final for that token. From then on, the client sends nothing more with that token until
it holds a different one. Without that rule, a refused identity becomes a loop: every retry is
refused and every refusal triggers another renewal.

A `503` and a `403` never trigger a renewal. Neither is about the token: the first clears when Usher
is reachable again, and the second holds whatever token is sent.

### Values to import rather than retype

`@overture-stack/usher-types` exports the wire values, so a client compares answers against the same
constants the bridge sends. Its exports import neither Express nor any Node built-in, so a portal's
browser code can use them:

| Export             | Value                                                        |
| ------------------ | ------------------------------------------------------------ |
| `SUSPENDED_HEADER` | `Usher-Suspended`                                            |
| `SUSPENDED_VALUE`  | `true`                                                       |
| `CHALLENGE_ERRORS` | `invalidToken: 'invalid_token'`, `invalidRequest: 'invalid_request'` |

Statuses and `Retry-After` are standard HTTP and are not exported. No header names the layer that
answered: a client running its own server, such as a portal's proxy, tells its own failures from the
service's by its own means, for example a code in its own response body.

**Every header above is readable by browser script.** The bridge lists `WWW-Authenticate` and
`Usher-Suspended` in `Access-Control-Expose-Headers`, so a page calling from another origin can read
them.

---

## Portals

A portal's server holds the person's session and proxies their requests; its pages render what
comes back. Both halves have rules.

### The proxy

- Forward the person's own sign-in token, and nothing else, as the bearer token. The service decides
  what that token may see, never the portal.
- A session that has ended is refused by the proxy, never forwarded without a token, so a person who
  believes they are signed in never silently sees less.
- Relay `Usher-Suspended` and `WWW-Authenticate` to the page. Set the portal's own cross-origin
  policy rather than relaying the service's.
- Renew the session's token on the server, at most once per person per minute, so a refusal cannot
  become a renewal storm across a person's open tabs.

### What the person sees

| Answer                                     | The portal shows                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Usher-Suspended: true`                    | The results, with a notice that only the data available to everyone is shown for now                                                                                    |
| `401` that persists after the renewal      | The refusal, in place of the view, with Try again. The person stays signed in, and the only account action offered is Log out, which the person chooses. The portal never signs them out itself |
| `403`                                      | The refusal for what was asked                                                                                                                                           |
| `503` from the service                     | A notice that access could not be confirmed, and to try again later                                                                                                     |
| The portal's own sign-in outage            | The portal's own notice, told apart from the service's `503` by the portal's own response code                                                                          |
| The portal's own session ended             | Sign-out, through the portal's own session handling                                                                                                                      |

**After a final answer, nothing is sent until something changes.** A refused identity or a `403` stops
the page's requests until the token changes, the person changes, or the person chooses Try again.

**A sign-out in one tab clears protected results in every tab** of the same portal.

**Which grants ended, and when, belongs to the profile view.** A search never says why it returns
less, so the person learns that their access changed in [profile-view.md](profile-view.md), never
from a search.

### Downloads

A download submitted as a form into a hidden frame becomes a file without any page script reading
the response, so no header reaches the person. Two consequences:

- **A cut export says so in its file name.** Arranger names an export cut short by its row limit
  `<name>-<rows>-of-<matching><extension>`, or `<name>-first-<rows>-of-<matching><extension>` when the
  request carried a sort, so the name is what tells the person. The count covers only records
  visible to the person, and matches the count on the page.
- **A suspended principal's export answers `503`** rather than a file holding only the data available
  to everyone, which would read as complete. See
  [decisions.md](decisions.md) § A suspended principal is answered by what the open tier can settle.
