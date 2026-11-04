# Revocation notice stream

Checked on Node 24.16 (undici 7.25.0, libuv 1.52.1) on macOS against the npm registry (jose 6.2.12,
eventsource-parser 4.1.1, eventsource 5.1.2, ws 8.22.0, fastify 5.12.5, @fastify/sse 0.6.0),
2026-10-04. Every behaviour stated here was run there, against models of the bridge and mock
controllers on a local port, unless the sentence says it was read from source or documentation, or
reasoned.

This note sets out how the Usher bridge, the library each ushered application embeds, reads the
controller's revocation notice stream. The stream carries every notice that drops cached access: a
principal's revocation or sign-out, a category change on a resource, a change to an audience's served
set, a baseline change, and a global revocation.

## Decisions

These state the design. [schema.md](../../../design/schema.md) "Decide E" leaves the subject tag, the
notice encryption and the bridge's side of the stream to this note, so a decision with no other link
is recorded here. One that another design document records links it, and one still under review says
proposed. The sections after them give the evidence.

### Transport

- The push runs over Server-Sent Events (SSE), not WebSocket.
- The bridge reads the push with undici's `fetch` through an Agent of its own, or the host's `fetch`
  when it hands one over, and `eventsource-parser` 4.1.1.
- The push is `GET notices/stream` under the controller URL, with `Accept: text/event-stream`, the
  channel assertion, `Last-Event-ID` and `Usher-Notice-Versions`.
- The bridge owns every header, sees every status code, and runs its own reconnection.
- On every push connection attempt, the first included, the bridge sends a fresh channel assertion
  and resumes from its push position with `Last-Event-ID`. While it holds no push position, at start
  and after a reset, it opens from the head the poll read, and waits until the poll has read one.
- The bridge reconnects with full-jitter exponential backoff and ignores any `retry` field. The
  controller sends none. The ceiling starts at 1 s and doubles with each failed attempt, up to the
  poll interval T, and starts again only once a connection applies a notice, so a stream that sends
  bytes but nothing applicable keeps backing off.
- A push answered with anything but a 200 event stream reconnects with that backoff. A 410 resets as
  on the poll. A 406 is a malformed channel, and so is a 200 that is not an event stream, such as a
  proxy's own page. Nothing else is logged.
- The bridge sets the parser's `maxBufferSize`, for example to 64 KiB, and treats an overflow as a
  malformed stream.
- The controller writes a heartbeat every H, at most half the shortest proxy timeout P on the path.
  The bridge runs an idle timer I on the push, at least 2H plus jitter and at most T, and replaces a
  push that stays silent past it. The timer runs from the connection attempt's start, so a path that
  withholds even the headers is replaced the same way. The defaults are H = 10 s and I = 25 s,
  against nginx's default read timeout of 60 s.
- The poll runs always, on its own schedule, whether or not the push is connected.
- The bridge takes its `fetch`, or its undici dispatcher, as a typed parameter, and never inherits the
  host's global dispatcher. It exposes `stop()` and keeps its timers unreferenced.

### Liveness

- Only a poll answered within its deadline is a check, as
  [security-workflow.md](../../../design/security-workflow.md) "Only a timely poll proves the stream
  is live" records, decided on 2026-10-06.
- The heartbeat is a transport comment, and never renews the grace period.
- The anchored heartbeat, set out under "The anchored heartbeat, the fallback", was the alternative
  to that rule, and was not taken.
- The poll deadline D is 10 s by default, which is proposed: [bridge-tests.md](../../bridge-tests.md)
  "Open for review" sets the deadline's default with the controller, below the grace period less the
  poll interval.
- A poll that fails is retried at once, and the poll interval T is jittered by 10%.
- A retry that fails as well waits for the recovery interval R rather than T, and so does every poll
  after it until a check is recorded. The poll after a recorded check waits for T again. A 410 is the
  exception: the bridge resets and asks for head at once.
- R is the smaller of 10 s and T by default, configurable as `pollRecoveryIntervalMs`, and at most T,
  so it only ever shortens the wait between failing polls. The grace period G still bounds how long
  cached answers are served: the bridge leaves normal mode once G passes since the last check, as it
  would without R.
- R is jittered by 10% either way, as T is, so bridges that start failing together, as in a
  controller outage, do not poll it in step once it returns. Under the same jitter, a poll timed at R
  is never later than one timed at T would have been.
- A controller failing at once gets two requests every R, the poll and its retry, and is never polled
  in a loop. One that never answers is asked again as each retry is aborted at D, since R at its
  default is no longer than D.
- A 410 answering a request for head is a malformed answer, since such a request names no cursor to
  be too old: no reset, `revocationChannel.malformed` logged, and retried as any failure is.
- A malformed answer is no check, so the schedule treats it as a failure: it is retried at once, and
  starts R when its retry also ends with no check.
- A check abandoned by a stop, a forget or a reset neither starts R nor ends it. A stop arms no
  timer, and a forget or a 410 asks for head at once; that head check's outcome then times the next
  poll, at T once it is recorded and at R once it and its retry have failed.
- A failed poll is logged as `revocationChannel.failure` with a `cause`: `status` for an answer
  other than 200, 406 or 410, `network` when the request cannot reach the controller, `timeout` when
  the deadline aborts it, and `defect` for a throw while signing, reading or applying a page. A
  malformed answer is logged as `revocationChannel.malformed` instead, and a 410 resets.
- A defect thrown while applying a pushed notice, or while handing a 410 to the channel, is logged the
  same way, with cause `defect`.
- Failures are counted rather than logged one by one: the first starts an interval of 60 s, at whose
  end one event for each cause carries that cause's count, and a stop logs whatever is still
  counted. A poll abandoned by a stop or a reset counts as no failure.
- Every poll the push asks for, on silence or on a 410 of its own, runs as the schedule's polls do:
  one immediate retry on failure, R after a failed retry, and head at once after a reset. It runs at
  once whatever interval is in force, replaces the poll already timed, and its own outcome times the
  next.
- T runs from the start of the check the schedule joined to the next check's start, as the bound
  below assumes, and R runs the same way.
- Each request and each read of an answer races the deadline, so a host's `fetch` that ignores its
  signal still ends at D, and never holds a later check or the bridge's stop.
- T + 2D stays below G with T taken at its jitter maximum: 1.1 T + 2D is below G, so one failed poll
  is retried within grace. [Core and Express layer](core-and-express-layer.md) refuses any other
  configuration at construction, and any R above T.
- A check is recorded only when every page arrived within D of the first page's start, and every
  notice in the answer was applied.
- A poll that misses D is no check. A poll left open past its deadline is aborted at D, and any abort
  counts as no check, whatever its reason.
- A check's deadline runs from its first page's start, so a later page still open D after that start
  is aborted then.
- The pages answered before an abort are still applied, and the aborted request applies nothing.
- A page that asks for more must name as `next` a cursor no page of its check has asked after, the
  one the check started from included, so a controller looping its cursors cannot keep a check
  running until D. A page naming one is malformed: it applies nothing, the pages before it stay
  applied and keep the position they moved, `revocationChannel.malformed` is logged with a reason
  code of its own, and the check is no check, retried as any failure is.
- A last page, asking for no more, may name the cursor it was sent with, as it does when no newer
  notice exists.
- [bridge-tests.md](../../bridge-tests.md) "Revocation and invalidation" applies the notices of a
  poll answered after its deadline. With the abort at D no answer arrives after the deadline, so that
  row holds only for the pages answered before D.
- A check's time is its first page's start, which the channel layer passes to the core as
  `confirmChannel(checkStartedAt)`.
- The grace period and the deadline are timed on an injected clock whose production form is monotonic.

### Positions and history

- The bridge keeps two positions: a push position, sent as `Last-Event-ID` and moved by pushed
  notices, and a poll position, moved only by poll answers, as
  [security-workflow.md](../../../design/security-workflow.md) "Propagation: push + poll" records.
- A cursor that history no longer reaches gets 410 Gone on both channels, judged against a stored
  trim watermark and an epoch carried in every cursor, as [schema.md](../../../design/schema.md) "The
  notice stream" records.
- A cursor the controller cannot decrypt, whether altered or issued under a cursor key since
  replaced, gets 410 as a cursor from another epoch does. Replacing the cursor key therefore resets
  every bridge at once, as a restore does (reasoned).
- On a 410 the bridge drops every entry, the anonymous one included, logs `revocationChannel.reset`,
  and asks for head explicitly. It never takes head from a 410's body, only from an authenticated
  answer.
- A poll names its cursor or asks for head explicitly. An absent cursor is a request error, never an
  implicit head.

### Startup

- The bridge reads head with a timely poll and opens the push from it, as "Startup order" sets out.
- The anonymous fetch is the application key's self-test, and runs at start without waiting for the
  head poll. A payload fetched before the head poll's check serves only as the self-test, and the
  check fetches it again.
- At startup, a wrong application key shows first on the anonymous exchange, whose channel
  assertion the controller refuses with 401: the bridge logs `token.exchangeFailure` with cause
  `assertionRefused` and `revocationChannel.modeChange` with reason `probableKeyMismatch`, and stays
  cold. An anonymous token failing decryption at startup is named the same way, after its
  `token.rejection` with reason `decryptionFailed`. [jose for the Usher token](jose-usher-token.md) records
  the same.

### Notices

- Each notice travels as one SSE event, with its cursor as the event's `id`.
- A notice's `kind` is `principal`, `category`, `baseline`, `global` or `servedResources`.
- A baseline change drops every entry, since every signed-in payload carries the baseline's grants
  too ([decisions.md](../../../design/decisions.md) "A category change is announced to the
  applications that serve the resource").
- A change to an audience's served set, the payload's `servedResources`, drops every positive entry
  and the anonymous entry, which is fetched again, as a baseline change does. Refusals are kept, since
  the served set does not change who is refused.
- A served-set change has a kind of its own, `servedResources`, because `notice.applied` logs the
  notice's kind, and logging it as `baseline` would misname what changed.
- A category notice goes only to the audiences that serve the resource (decisions.md "A category
  change is announced to the applications that serve the resource").
- A principal notice goes to every audience, and names the subject by a per-audience tag: an HMAC of
  the subject under a key derived for that audience. This is the recommendation of
  [schema.md](../../../design/schema.md) "Decide E", a draft for review, so it is proposed.
- The bridge indexes its entries by that tag, which is proposed with it.
- Baseline and global notices go to every audience.
- A servedResources notice goes only to the audience whose served set changed.
- Cursors are opaque to the bridge, which never reads one and compares them only for equality.
- Under the timely-poll rule the bridge compares a cursor only with a copy of the same string: an SSE
  `id` with the cursor inside its notice, and a poll answer's `after` with the cursor its request
  sent. So the equality holds however the controller encrypts a cursor.
- Cursors are opaque in fact, not only in form, since a readable global position would show each
  bridge the gaps a category filter leaves. The controller makes them so by encrypting each cursor's
  epoch and position under a key of its own, which it never shares.
- The bridge lists the notice versions it reads when it connects and when it polls, comma-separated
  in an `Usher-Notice-Versions` request header, the same on the push connection as on the poll.
- The controller refuses a version list it cannot serve, and the bridge treats the refusal as a
  malformed channel, with no check.
- The refusal is a 406 Not Acceptable, which is proposed, answered only after the controller has
  accepted the assertion.
- A refused version list is logged as `revocationChannel.malformed` with a fixed reason code of its
  own.
- A notice is malformed when its version or kind is not one the bridge listed, its SSE `id` differs
  from the cursor inside it, it fails to decrypt or validate, or the parser overflows.
- A malformed notice is not applied, no position moves past it, and an answer carrying it is no check.
- A malformed notice, or a poll answer that fails to read, is logged as
  `revocationChannel.malformed` with a fixed reason code.

### Authentication and confidentiality

- The bridge authenticates to the push, the poll and the exchange with an HS256 channel assertion,
  signed under the HKDF subkey of the application key with info `usher/v1/channel-assertion`.
- The assertion's `typ` is `usher-channel+jwt` and its `aud` is `usher:controller`, naming the
  controller rather than one of its endpoints. Its `iss` is the
  application's identifier, from which the controller derives the same key. Its `exp` is no later
  than `iat` plus 60 s, and its `jti` is unique.
- The assertion carries no `kid`. A key version arrives with key rotation, which is open in
  [jose for the Usher token](jose-usher-token.md#open-questions).
- The controller checks the assertion before it reads the version list or the cursor, and answers
  every refusal of an assertion with the same 401.
- The controller refuses a reused `jti` on a stream open, and closes a stream after a maximum lifetime
  of 15 min and whenever the application's key is revoked or rotated away.
- The channel assertion does not sign the request's method, path or query. The encrypted echo of the
  nonce and `after` already catches a rewritten request at the bridge.
- Notices and poll answers are encrypted to the audience as compact JWEs under `dir` and A256GCM.
- A notice has `typ` `usher-notice+jwt` and the subkey with info `usher/v1/notice-encryption`. A poll
  answer has `typ` `usher-poll+jwt` and the subkey with info `usher/v1/poll-answer`.
- The bridge reads both with `compactDecrypt`, never `jwtDecrypt`, under the Usher token's header
  rules in [jose for the Usher token](jose-usher-token.md).
- Every poll answer carries, inside its encryption, the nonce and the `after` cursor its request sent.
- Poll answers are not padded in the first release. A record's length can show an observer on the
  path that a notice exists, which is reasoned rather than measured, but holding back that answer
  already means holding back every answer, so padding would not change the delay bound.
- The application key is used directly only for Usher tokens, and every other use derives an HKDF
  subkey with its own label ([adapter-integration.md](../../../design/adapter-integration.md)
  "Category dictionary introspection").

### The controller and the bridge's caches

- Valkey pub/sub only wakes controller instances to new notices, and the database is the source they
  read ([schema.md](../../../design/schema.md) "What is stored where").
- An exchange answer overtaken by a notice is judged by the affected-payload test in
  [Core and Express layer](core-and-express-layer.md).
- On the controller, a payload recomputed from a snapshot read before a notice's commit is never
  written to the payload cache after that notice has cleared it.
- When a notice drops the anonymous entry and fetching it again fails while the channel is healthy,
  anonymous and open-tier requests get 503 until the fetch succeeds; the rules for the rendering kept
  for uncertain mode are in [Core and Express layer](core-and-express-layer.md).
- The controller sends to each push connection independently, with a timeout, never one connection
  after another. Each connection has a bounded queue and is closed on overflow, and connections per
  audience are capped.

### Logging

- The channel assertion, the `Authorization` header, a notice's body and a JWE are never logged. On
  the controller this means redaction on the request logger.
- No jose, zod or `JSON.parse` error is ever logged, since jose's claim errors carry the plaintext and
  a `JSON.parse` message can quote it.
- An applied notice is logged as `notice.applied`, with its `kind` and `entriesDropped` only: no
  subject, tag or cursor.
- Every event the bridge emits is registered in [audit-events.md](../../../design/audit-events.md).

## Terms used here

| Term              | Meaning in this note                                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| notice            | one entry of the stream: a principal's revocation or relayed sign-out, a category change for one resource, a change to one audience's served set, a baseline change, or a global one                                                          |
| served set        | an audience's served resources, held or not: the payload's `servedResources`                                                                                                                                                                  |
| position          | a notice's place in the controller's one sequence, stored as `notices.position` and following commit order                                                                                                                                    |
| cursor            | the opaque string the controller gives the bridge for a position; it carries the position and an epoch, encrypted under a key only the controller holds                                                                                       |
| head              | the cursor of the newest committed notice                                                                                                                                                                                                     |
| epoch             | a value the controller regenerates whenever its notice history restarts, as after a restore                                                                                                                                                   |
| push position     | the cursor the push resumes from, sent as `Last-Event-ID`; pushed notices advance it                                                                                                                                                          |
| poll position     | the cursor the poll asks after; only poll answers advance it                                                                                                                                                                                  |
| check             | a poll answered within its deadline, which renews the grace period                                                                                                                                                                            |
| heartbeat         | a comment the controller writes on an idle push stream, so that proxies and the bridge see traffic                                                                                                                                            |
| idle timeout      | how long the bridge waits for any byte on the push before it aborts the connection and reconnects                                                                                                                                             |
| channel assertion | a short-lived signed token the bridge sends to the push and the poll, proving which application is asking                                                                                                                                     |
| reset             | what the bridge does on a 410: drop every entry, then read head                                                                                                                                                                               |
| malformed channel | a notice, poll answer or a 200 push answer the bridge cannot read, a poll page asking for more from a cursor its check already asked after, or the versions it lists refused: nothing applied, no check, `revocationChannel.malformed` logged |

**Position and cursor are not synonyms here.** The design files say position, and the contract says
cursor. The bridge only ever holds a cursor, which encodes a position and an epoch. Where this note
says the bridge holds a position, it holds the cursor for one.

| Symbol | Meaning                                                    | Value                              |
| ------ | ---------------------------------------------------------- | ---------------------------------- |
| H      | heartbeat interval                                         | 10 s, the default                  |
| I      | the bridge's idle timeout on the push                      | 25 s, the default                  |
| T      | poll interval                                              | 30 s, the decided default          |
| R      | recovery interval: the poll interval while checks fail     | 10 s or T if shorter, the default  |
| D      | poll deadline                                              | 10 s, a proposed default           |
| G      | grace period                                               | 60 s, the decided default          |
| P      | the shortest read or idle timeout of any proxy on the path | 60 s, nginx's default read timeout |

## Liveness

### One delay, traced twice

The case: a principal P's grant is revoked. Something on the path between bridge and controller
forwards the push stream's bytes in order, but slower than the controller writes them, and holds back
every poll answer. The last check started at t = 0 s, and the notice c42 commits at t = 1 s.

**Rule A: the push connection proves liveness, read as "bytes within the idle timeout".**

1. t = 1: c42 is written to the push stream, behind the bytes already queued.
2. Bytes keep arriving, each within 25 s of the last, so the idle timer never trips.
3. t = 30: the poll goes out and its answer is held back. Push still counts, so the stream is live.
4. t = 60: the grace period has not run out, because the arriving bytes keep renewing it.
5. P's cached entry is honoured until its own `exp`, up to the 5 min TTL. Revocation is bounded by the
   token lifetime, which the bar rules out.

**Rule B: only a poll answered within its deadline is a check.**

1. t = 1: c42 is written to the push stream, behind the bytes already queued.
2. Bytes keep arriving, and push renews nothing.
3. t = 30: the poll goes out and its answer is held back. At t = 40 it misses its deadline, and the
   immediate retry is held back too. No check.
4. t = 60: the grace period since the check at t = 0 has run out. The bridge enters uncertain mode and
   logs `revocationChannel.modeChange`.
5. From t = 60, P is served the open tier only, marked `openTierOnly` and `suspended`, naming P's
   subject as `attributionOnlySubject`, for attribution alone. Revocation is bounded by the grace
   period.

The traces part at step 4. If the path lets polls through, c42 arrives in the next poll answer under
either rule, by t = 40.

Step 2 of rule A was measured on a compressed scale. With H = 1 s and I = 2.5 s, behind a path
releasing at most one chunk every 2.2 s, the idle timer never tripped. Over the same run, the age of
the content arriving grew from 2.2 s to 15.2 s and was still rising.

### What rule B requires

- The heartbeat is transport only: a comment line with no id. It keeps proxies from cutting the
  stream, and lets the idle timer find a dead push. Without it, revocation latency falls silently from
  seconds to the poll interval whenever a push dies.
- The poll runs always. A bridge polling only while push is down would let the grace period run out
  while push is up.
- "An exchange failing while the channel is healthy" reads healthy as "within the grace period of the
  last check", never as "push connected".

### The anchored heartbeat, the fallback

Reasoned, not built, and not taken: rule B was decided instead on 2026-10-06. To prove liveness under rule A, a heartbeat needs two properties that neither an
open connection nor arriving bytes provide:

| Property     | What it proves                                                 | Why arriving bytes fall short                                                                        |
| ------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| freshness    | the bridge can bound how old each heartbeat is when it arrives | a paced path delivers bytes on time while their content ages                                         |
| completeness | a fresh heartbeat proves that no notice before it is missing   | an instance's push can miss a notice while its heartbeats stay fresh, and held polls recover nothing |

One way to get both:

1. The bridge opens the push with a fresh nonce in a request header, and notes its own monotonic time,
   t0.
2. The controller's first event, encrypted to the audience, echoes the nonce and starts a clock for
   that connection at zero.
3. Each heartbeat is an encrypted event carrying that clock's elapsed time, e, and the head cursor the
   controller read from the database.
4. When a heartbeat arrives, its age is at most the bridge's elapsed time since t0, less e, since it
   cannot have been written before the request was sent.
5. A heartbeat older than the bound, or naming a head that differs from the push position, is not a
   liveness signal, and the bridge polls at once.

Step 5 is the one place a bridge compares two cursors the controller encrypted separately. The
comparison holds only if the controller encrypts one epoch and position to one cursor on every
instance. With a fresh random IV for each encryption, every head would differ from the push position,
and the bridge would poll on every heartbeat, which fails safe at the cost of a poll each time.

Both clocks are monotonic, so wall-clock skew never enters. Only the two clocks' rates can differ, and
over a connection's maximum lifetime the difference is small. A heartbeat read just after a commit,
before its notice arrives, names a head the bridge has not reached, and costs one extra poll. Under
this rule the idle timeout plus the reconnect budget must also stay below the grace period.

The heartbeat is then an `event: heartbeat` with an encrypted body and no id. The body needs a `typ`
of its own, such as `usher-heartbeat+jwt`, for the reason the poll answer has one.

The price is a database read of head for each heartbeat on each controller instance, an encrypted
heartbeat and a clock per connection. The liveness rows in [bridge-tests.md](../../bridge-tests.md),
written to the timely-poll rule, would change too. Rule B needs none of it. With the anchored
heartbeat, rule A's step 2 changes: each heartbeat arrives older than the last, one older than the
bound stops counting, and step 4 then matches rule B's, with the grace period measured from the last
heartbeat that counted.

## SSE against WebSocket

The stream runs one way, from controller to bridge. SSE builds in the one thing the channel needs from
a protocol: an id on every event, and a `Last-Event-ID` header to resume after it. WebSocket has no
resume, and its upstream half would carry nothing.

| Concern                | SSE                                                                                                                     | WebSocket                                                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| resume                 | built in: an id on each event and `Last-Event-ID` on reconnect; with a `fetch` client the bridge sets the header itself | none; it needs a custom first message or header, and a custom marker for the end of replay                                                                                                         |
| reconnection           | a `fetch` client needs its own loop, about 20 lines in the model                                                        | nothing built in; its own loop                                                                                                                                                                     |
| liveness               | no protocol ping; a heartbeat and an idle timer                                                                         | protocol ping and pong, but Node's global client cannot send pings and never shows server pings to JavaScript, though it answers them; the `ws` package can do both; an idle timer is still needed |
| through proxies        | a plain streamed HTTP response, subject to read timeouts between reads and, in nginx, to response buffering             | the proxy must pass the upgrade; the same idle timeouts apply; nothing is buffered after the upgrade                                                                                               |
| HTTP/2                 | an ordinary streamed response (not verified)                                                                            | needs the extended CONNECT of RFC 8441, which many paths lack (not verified)                                                                                                                       |
| client authentication  | ordinary headers on every request, and every status visible: 401, 410, 503                                              | handshake headers from Node through `ws` or undici's non-standard `{ headers }` init, never from browsers; Node's global client hides a refused handshake behind close code 1006                   |
| backpressure           | one way: the server waits for `drain` when a write returns false                                                        | the same, plus an upstream path that must be parsed and limited for nothing                                                                                                                        |
| operational visibility | each connection is an HTTP request in the access log, with its status and duration                                      | the access log shows a 101, then opaque frames                                                                                                                                                     |

The resume, reconnection, liveness and client authentication rows were run, as set out under "Node 24
clients". SSE's resume mechanism is also read from the standard. The proxy, backpressure and
visibility rows are reasoned, except @fastify/sse's wait for `drain`, which is read from its source.

What would reverse the choice:

- the bridge needs to send messages upstream during a connection, such as an acknowledgement per
  notice, a subscription that changes at runtime, or repeated freshness challenges;
- the deployed path between bridge and controller buffers or cuts streamed HTTP responses but passes
  upgraded connections, and cannot be configured otherwise;
- notice volume or binary framing becomes a real constraint, which it is not;
- the controller's SSE support proves unreliable under soak, though writing to the raw response stays
  simpler than adopting WebSocket.

## Node 24 clients

| Client                                                                      | Status                                                                                                                                             | `Authorization` header                                                        | Starting `Last-Event-ID`                                | Reconnection                                                                                                       | Status codes                                                                                                                              |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| global `EventSource`                                                        | Stability 1, Experimental (read from Node's documentation); undefined without `--experimental-eventsource`, and warns `UNDICI-ES` when constructed | not in its API; possible through a non-standard undici dispatcher interceptor | not in its API; the same interceptor                    | the non-standard `node.reconnectionTime` or the server's `retry`; no backoff                                       | not visible; a non-200 answer fails the connection with no reconnect, as the SSE standard requires (read from the standard)               |
| `eventsource` 5.1.2, published 2026-09-21; Node >=22.12.0                   | depends on `eventsource-parser` ^4.1.1                                                                                                             | only through a custom `fetch`                                                 | through a custom `fetch`; resent by itself on reconnect | a fixed 3 s floor, reopening after 3.0 s; the server's `retry` overrides it; a custom `fetch` can add delay on top | in `ErrorEvent.code`; by default any non-200, 503 included, closes it for good; a custom `fetch` that throws on 503 keeps it reconnecting |
| `fetch` with `eventsource-parser` 4.1.1, published 2026-09-15; Node >=22.12 | no dependencies, ESM only                                                                                                                          | any header, fresh on every attempt                                            | set by the bridge from its applied cursor               | the bridge's own loop; `retry` ignored                                                                             | every status, each with its own handling                                                                                                  |
| global `WebSocket`                                                          | no flag and no warning; stable since v22.4.0 (read from Node's documentation)                                                                      | through undici's non-standard `{ headers }` init                              | a header with no meaning in the protocol                | none                                                                                                               | not visible: close code 1006 with an empty reason                                                                                         |
| `ws` 8.22.0, published 2026-09-26                                           | no dependencies                                                                                                                                    | yes                                                                           | a header with no meaning in the protocol                | none; `ping()` exists                                                                                              | visible through `'unexpected-response'`                                                                                                   |

The `eventsource` package can be bent to the bridge's needs through a custom `fetch`. Once the bridge
writes that `fetch`, the package adds only the parser it already depends on.

With the recommended client, a model of the bridge resumed after the controller dropped the stream. It
reopened within half a second, sent `Last-Event-ID` from its applied cursor with `Authorization`
present, and applied six notices in order with no gap and no duplicate.

**Two things the bridge must do with the parser.**

1. Set `maxBufferSize`. It defaults to unbounded in the bare parser (read from its type definitions;
   the `eventsource` package passes 100 MB).
2. Handle overflow. On overflow the parser reports `max-buffer-size-exceeded` and stops, and a further
   `feed()` throws synchronously. The bridge aborts the connection, treats the stream as malformed,
   resumes from the push position, and never calls `feed()` where a throw would go uncaught in the
   host process.

**Packaging.** The parser is ESM only, which fits Arranger's search-server, an ESM package. On Node
24.16, `require()` of the parser from CommonJS also worked, so a CommonJS consumer is not blocked. The
parser's engines floor is Node 22.12, so any package that ships the bridge declares a floor at or above
that. Node 20 reached end of life on 2026-04-30, according to the Node.js release schedule.

**One unexplained behaviour.** Node's global WebSocket client made two handshakes per construction
when refused with 401, and one when refused with 410. The cause was not investigated.

## The push connection

### An open socket proves nothing

Measured on compressed timescales: a heartbeat every 2 s, an idle timer of 5 s, and a TCP proxy in
front of the mock where a scenario needs one.

| Scenario                                                               | Defence tested                         | Without it                                                         | With it                                                                                                                           |
| ---------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| the controller stops writing, socket open, and answers no new requests | heartbeat and idle timer               | not detected within 20 s                                           | detected after 4.5 s, with event or comment heartbeats; while the stall lasts, the bridge cycles abort and jittered reconnect     |
| a proxy that cuts connections idle for 5 s, watched for 16 s           | heartbeat                              | 3 cuts and 4 stream opens                                          | no cut, and 1 open                                                                                                                |
| a frozen path: both sockets open, nothing forwarded                    | idle timer, with the heartbeat running | not detected within 15 s; a notice published into it never applied | detected after 4.5 s; the reconnect sent the last applied cursor as `Last-Event-ID`, and the held notice was replayed and applied |
| a paced path: every chunk forwarded in order, at most one every 2.2 s  | idle timer, with H = 1 s and I = 2.5 s | not applicable                                                     | never trips, while the content's age keeps rising (see "One delay, traced twice")                                                 |

Without a timer of its own, the bridge has two fallbacks, and both are too slow:

| Fallback      | When it acts                                                                                                                                                                      | Source                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `fetch`       | abandons a silent body after 301 s, with `UND_ERR_BODY_TIMEOUT`: undici's default `bodyTimeout` of 300 s, five times the grace period                                             | measured                                    |
| TCP keepalive | undici turns it on after 60 s idle, and Node 24.16's libuv probes every 1 s, 10 times, whatever the host's settings: a dead peer found after about 70 s, on Linux and macOS alike | read from libuv's source; measured on macOS |

Keepalive never finds a live but silent peer, or a proxy holding the connection open, since both
answer the probes (reasoned). An SSE client writes nothing after its request, so nothing on the client
side ever provokes a reset from a dead path.

### Heartbeat and idle timer

The timing rule:

- H is at most half of P, so the controller writes something at least twice within any proxy's
  timeout.
- I is at least 2H plus jitter, so one late heartbeat does not trip the timer.
- I is at most T, so a dead push is replaced within one poll interval.

The defaults are H = 10 s and I = 25 s, against nginx's default read timeout of 60 s. The SSE
standard suggests a comment line about every 15 s (read from the standard). @fastify/sse 0.6.0 writes
`: heartbeat` every 30 s by default (read from its source). That is only half of nginx's timeout, and
should be shortened.

### What the bridge does with silence

- Silent for longer than H: nothing. A late heartbeat is normal.
- Silent for longer than I: abort the connection, log `revocationChannel.pushReconnect`, reconnect with
  jittered backoff from the push position, and poll at once.
- Nothing on the push ever changes the mode.

### Inside a host application

- The bridge takes its `fetch`, or its undici dispatcher, as a typed parameter. It never inherits the
  host's global dispatcher, which a host can replace or route through a proxy.
- It exposes `stop()`, which a host holding an `AbortSignal` calls when the signal fires, and its
  timers are unreferenced. A host can then shut down cleanly, and a co-located `node:test` run does
  not hang on an open stream.

## The poll

### Why it runs always

Under the timely-poll rule, decided on 2026-10-06, the poll is the only check, as "What rule B
requires" sets out. It is also
what recovers a notice an instance's push missed, since it asks after its own position.

Valkey's documentation says pub/sub delivers at most once, and that a message a subscriber cannot
handle, as on a disconnect, is lost for good (read from Valkey's documentation). So pub/sub carries
only a wake-up between controller instances, and each instance reads the notices from PostgreSQL on a
wake-up or on a short timer, as [security-workflow.md](../../../design/security-workflow.md)
"Multi-instance propagation" sets out. A lost message delays a push and loses no notice.

### Request and answer

The bridge polls after its poll position, or asks for head explicitly. An absent cursor is a request
error, never an implicit head. A bridge that loses its position while holding entries then cannot skip
notices unnoticed.

```http
GET notices?after=<cursor>&nonce=<random>
Authorization: Bearer <channel assertion>
Accept: application/jose
Usher-Notice-Versions: 1

GET notices?head=true&nonce=<random>
Authorization: Bearer <channel assertion>
Accept: application/jose
Usher-Notice-Versions: 1
```

Both paths are relative to the controller URL, as the exchange's is, and each page carries a fresh
nonce and a fresh channel assertion. The notice versions travel in the same request header as on the
push connection.

A 200 answer is a single compact JWE, with content type `application/jose` and `typ` `usher-poll+jwt`,
under the poll answer's own derived key. Its plaintext is:

```ts
/** A poll answer after decryption. */
type PollAnswer = {
	v: 1;
	/** The nonce the bridge sent, echoed so an old answer cannot stand in for a new one. */
	nonce: string;
	/** The cursor this answer continues from, or 'head', echoed so a rewritten request is caught. */
	after: string;
	notices: Notice[];
	/** The cursor of the last notice returned, or head when there is none. */
	next: string;
	/** True when a page limit cut the answer short. */
	more: boolean;
};
```

| Answer         | Meaning                                                       | What the bridge does                                                                               |
| -------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 200            | notices after the cursor, bounded to a page (for example 500) | validate, apply, advance; when `more` is true, poll again at once from `next`                      |
| 410            | history no longer reaches the cursor                          | reset                                                                                              |
| 401            | the channel assertion was refused                             | no check; `revocationChannel.failure`, cause `status`; what else it logs is under "Open questions" |
| 406 (proposed) | the controller cannot serve the notice versions listed        | a malformed channel: `revocationChannel.malformed` logged; no check                                |
| 503, timeout   | the controller could not answer                               | no check; `revocationChannel.failure` logged; retry at once                                        |

The controller checks the assertion first, and only then the version list and the cursor. It answers
every refusal of an assertion with the same 401. A client without a valid assertion then cannot tell
from 410 against 200 how far history reaches or how many notices exist, and cannot learn from a 406
which notice versions the controller serves (reasoned). The 406 is a status of its own, so the bridge
never mistakes a refused version list for a refused assertion.

**The echo of the nonce and `after` is what binds an answer to its request.** Without both, wherever
TLS ends before the controller process, two attacks pass (measured against a model of the bridge):

- an old answer replayed to a new poll passes as a timely check;
- an answer to a rewritten `after` passes as a check while skipping a notice for good.

### Deadline, retry and recording a check

With the deadline at its proposed default of 10 s, a failed poll is retried at once, and T + 2D
stays below G with T at its 10% jitter maximum, so one failed poll can be retried within grace. That
is stricter than the timely-poll rule's own bound, which keeps D below G less T. Taken at the nominal T,
the ordering is not enough: T = 38 s and D = 10 s keep T + 2D at 58 s, yet with the interval jittered
up to 41.8 s, the retry's answer can arrive as late as 61.8 s, past G.

1. t = 0: a poll starts and is answered in time. Check recorded at 0.
2. t = 30: the next poll starts. Its answer is held back.
3. t = 40: the deadline passes. The bridge aborts the poll and retries at once.
4. t = 50: the retry is answered in time. Check recorded at 40, the retry's start.
5. The grace period was never exceeded: 50 is below 60. With the poll interval jittered up by 10%, the
   worst case is 33 + 20 = 53, still below 60.

Without the immediate retry, the poll after a failure starts at t = 60, which equals G. The bridge is
then already uncertain before any answer can arrive.

The poll that missed its deadline at step 3 is no check, and is aborted at D. Any abort counts as no
check, whatever its reason. In a check of several pages, D runs from the first page's start, so a
later page still open at that moment is aborted then. The pages answered before the abort are still
applied, and moved the poll position, so the retry asks after the last of them. The aborted request
applies nothing (reasoned).

[bridge-tests.md](../../bridge-tests.md) "Revocation and invalidation" has a row for a poll answered
after its deadline, whose notices are still applied. With the abort at D no answer arrives after the
deadline, so the row holds only for the pages answered before D.

**A check is recorded only when all of these hold:**

- every page answered with 200, the last within D of the first page's start;
- each answer decrypted, validated, and echoing the nonce and `after` its request sent;
- each page asking for more naming as `next` a cursor no page of the check had asked after;
- every notice applied;
- `more` false on the last page.

Recording the moment the last page is applied, rather than the first page's start, would lengthen the
grace period by up to D, which is the open side.

An answer's arrival is timed where `fetch` resolves, not after the bridge's own processing, so a busy
host's event-loop lag does not count against D. If it did count, it would fail closed, as a false
uncertain mode (reasoned). A backlog too long to page through within D is still applied page by page,
so a later poll starts nearer head and completes in time (reasoned).

**The recovery interval shortens the wait while checks keep failing.** The defaults, with every
jitter draw at its middle, against a controller that fails each poll at once (reasoned, from the
schedule the poll's tests hold):

1. t = 0: a poll starts and is answered in time. Check recorded at 0.
2. t = 30: the next poll fails, is retried at once, and the retry fails too.
3. t = 40: the next poll starts R after the retry's start, rather than T after it at t = 60, which is
   G. It fails, and so does its retry.
4. t = 50: the next poll is answered in time. Check recorded at 50.
5. The grace period was never exceeded: 50 is below 60. The next poll starts T later, at t = 80.

Had no check been recorded by t = 60, the bridge would have entered uncertain mode then, as it would
without R.

### The clock

`Date.now()` arithmetic is never used: a backward step of the wall clock would lengthen the grace
period. Node's timers run on the event loop's monotonic clock (read from Node's documentation, not
tested by stepping the clock). `performance.now()` is monotonic too, but node:test's mock timers do not
drive it:

- it moved 0.024 ms across a mocked hour;
- listing `performance` among the mocked APIs throws `ERR_INVALID_ARG_VALUE`.

A bridge reading it directly would leave the grace and deadline test rows waiting in real time. An
injected clock, monotonic in production and driven by the test in a suite, avoids both problems.

A form with no clock reading was also modelled under mock timers: a candidate grace timer armed at a
check's first page, which replaces the running timer if the check completes and is cancelled if it
fails. A check started at 30 s and completed at 38 s lapsed at 90 s, not 98 s. A failed check left the
earlier lapse at 60 s in place. Both forms record the check at its start.

### Two positions

One shared position loses notices even with nobody attacking:

1. The bridge's push and poll positions are both c41.
2. c42 and c43 commit. The push misses c42, through any fault of the push, and delivers c43.
3. The bridge applies c43, and its push position moves to c43.
4. With one shared position, the next poll asks after c43, and c42 is skipped for good.
5. With two positions, the next poll asks after c41 and returns c42 and c43. Both are applied, c43 for
   the second time, which drops nothing new, and the poll position moves to c43.

A wrong or forged pushed id can then only add drops. It cannot move the position the poll asks after,
so a notice still rides in every answer until the bridge applies it.

## When history no longer reaches a cursor

The controller answers 410 on the poll, and on the push before any stream byte, in four cases:

- a notice after the cursor has been trimmed;
- the cursor belongs to another epoch;
- the cursor is ahead of head;
- the controller cannot decrypt the cursor, because it was altered or issued under a cursor key since
  replaced.

The fourth fails closed, and recovers through a reset. Replacing the cursor key therefore resets
every bridge at once, as a restore does: the herd that the oldest-kept test below would bring after
every quiet spell, here only when the key is replaced (reasoned).

**"Trimmed" is tested against the watermark, the highest position ever trimmed, not against the oldest
position kept.** The oldest-kept test resets every bridge at once after a quiet spell:

1. A bridge holds c100, and nothing else commits for longer than the retention period.
2. c100 is trimmed, and the table is empty.
3. c101 commits, and is now the oldest kept.
4. The bridge polls after c100. That is older than the oldest kept, so it is told to reset, though it
   missed nothing. Every bridge on the platform resets together, and their exchanges meet each bridge's
   bound on exchanges in flight: closed, at a cost.

With the watermark at c100, nothing after c100 was trimmed, so the same poll gets c101. Identity
positions can have gaps, so "the position after c100 is still kept" is not a usable test either.

**Every cursor carries an epoch, because a restore reuses positions** (reasoned from the schema's
`generated always as identity`, not run against a database):

1. The bridge holds c50.
2. The database is restored from a backup taken at c40.
3. New notices commit as c41 to c55, reusing those positions.
4. The bridge polls after c50 and gets c51 to c55.
5. The new c41 to c50 are skipped for good, and the grants they revoke stay cached until each entry's
   `exp`.

"Ahead of head" catches step 4 only while head is still below c50. An epoch regenerated on every
restore or history reset makes step 4 a 410. The cursor stays opaque to the bridge either way.

**Recovery from uncertain mode, with the poll position at c41:**

1. A poll asks after c41.
2. History still reaches c41: the answer carries c42 to c47, each is applied, `next` is c47 and `more`
   is false.
3. That poll was timely and fully applied, so it is a check. The mode returns to normal,
   `revocationChannel.modeChange` is logged, and grants are honoured again. Requests that arrived before
   this step stay open tier only.
4. If instead history no longer reaches c41, the answer to step 1 is 410.
5. The bridge drops every entry, the anonymous one included, logs `revocationChannel.reset`, and asks
   for head explicitly. That answer, timely and authenticated, is the check, and sets both positions.
6. The bridge fetches the anonymous payload again. Until it arrives, anonymous and open-tier requests
   answer 503.

The push follows the same path: a `Last-Event-ID` that history no longer reaches gets 410 before any
stream byte, and the bridge resets. Fastify 5.12.5 with @fastify/sse 0.6.0 in its `manual` mode served
exactly this: a plain 410 for a cursor ahead of head, before any stream byte, and replay after a valid
`Last-Event-ID`.

The bridge never takes head from a 410's body. It reads head from an authenticated answer.

After a global drop or a reset, every request exchanges again, and the bridge fetches the anonymous
payload first; beyond the bound on exchanges in flight, set out in
[Core and Express layer](core-and-express-layer.md), requests answer 503, which fails closed.

**Retention.** [schema.md](../../../design/schema.md) keeps notices for the token lifetime plus the
grace period, with a margin. A bridge away longer than that holds no live signed-in entries, since
they expire by `exp`. It holds only the anonymous payload honoured past its `exp`, which the reset
clears. A reset is safe at any retention, so the floor governs how often resets happen, not whether
they are safe.

## Startup order

1. Ask for head explicitly, with a timely, authenticated poll. This sets both positions.
2. Once step 1 is answered, open the push from head.
3. At start, alongside step 1, fetch the anonymous payload. This fetch is the application key's
   self-test, as [jose for the Usher token](jose-usher-token.md) sets out.
4. Serve once the anonymous payload is held and a check is recorded, as
   [security-workflow.md](../../../design/security-workflow.md) "Startup behaviour" requires. Until
   then the bridge is cold, and answers 503 before any read path.

Cold is set out in the "Modes" table of [Core and Express layer](core-and-express-layer.md). At
start it holds until `start` has imported the application key, a check is confirmed and an anonymous
payload is accepted. It holds again when the grace period passes with no anonymous payload held, and
while the key's self-test fails.

**Step 3 does not wait for step 1, so a wrong key always reaches the self-test** (run against the
controller mock):

1. The bridge starts with an application key that differs from the controller's.
2. The controller refuses step 1's channel assertion with 401, since it is signed under a subkey of
   that key. No check is recorded, and step 2 does not run.
3. Step 3 runs anyway. The anonymous exchange is authenticated by the same kind of assertion, so the
   controller refuses it with 401 too, before any token is decrypted.
4. The bridge logs `token.exchangeFailure` with cause `assertionRefused` and
   `revocationChannel.modeChange` with reason `probableKeyMismatch`, and stays cold.
5. No check has been recorded since start, so no grace period runs. The self-test, not a lapse of the
   grace period, is what names the key at startup.

If step 3 waited for step 1, a wrong key would leave the bridge cold with only the refused head poll
to show for it, and what a refused channel assertion logs is open, under "Open questions". The
refused exchange names the key instead.

**A payload is kept only when fetched after step 1's check.** One fetched before it serves as the
self-test and is not kept, and the check fetches it again. A notice committed between that early fetch and head would otherwise never reach the bridge
(reasoned).

A notice committed between steps 1 and 3 arrives after head and drops the fresh entry, which is fetched
again. Fetching first could miss it (reasoned).

## Notice wire format

```ts
/** One entry of the revocation notice stream, after decryption. */
type Notice =
	/** A principal's revocation, or a sign-out relayed from the identity provider. */
	| { v: 1; cursor: string; kind: 'principal'; subjectTag: string }
	/** A category change, naming the resource as the payload's `permissions` keys name it. */
	| { v: 1; cursor: string; kind: 'category'; resource: string }
	/** A change to the baseline: drop every entry. */
	| { v: 1; cursor: string; kind: 'baseline' }
	/** Drop every entry. */
	| { v: 1; cursor: string; kind: 'global' }
	/** A change to the audience's served set, the payload's `servedResources`: drop as for a baseline change. */
	| { v: 1; cursor: string; kind: 'servedResources' };
```

`subjectTag` is the per-audience HMAC of what the schema stores as `subject`; the field's name is
proposed. `resource` holds what the schema stores as `resource_name`. There is no reason field: the
bridge's action does not depend on one, and the controller's audit log holds it. A validator in
`usher-types` checks each notice. The bridge lists the notice versions it reads when it connects and
when it polls, as it lists payload versions at the exchange. The list travels in the same request
header on the push connection as on the poll. The controller refuses a list it cannot serve, and the
bridge treats the refusal as a malformed channel, with no check.

One SSE event per notice:

```text
id: <cursor>
event: notice
data: <compact JWE of one Notice>

```

The heartbeat is a comment line, `:`, with no id, so it never moves the resume position.

Rules:

- The controller sends no `retry` field, and the bridge ignores one if it comes.
- The SSE `id` must equal the cursor inside the decrypted notice.
- A mismatch, a decryption or validation failure, a parser overflow, or a version or kind the bridge
  did not list is malformed. The notice is not applied, no position moves, the connection is aborted,
  `revocationChannel.malformed` is logged, and the push resumes from the last applied position.
- On the poll, a malformed notice makes the whole answer no check. Every bridge reading it stalls there
  until it is fixed, and enters uncertain mode after the grace period. That fails closed, and loudly.
- The controller may send a marker after replay on each connection, so the push knows where it stands.
  The marker is optional, since push never counts as a check.
- Revoking one opaque API key is a principal notice for that key's subject. It also drops that
  principal's other entries, which fails closed, and needs no new kind.

### Reading a notice or a poll answer

Notices and poll answers are read by the Usher token's rules in
[jose for the Usher token](jose-usher-token.md): the exact `typ` check before decryption, the
header-member allowlist, the `alg` and `enc` allowlists, a `maxDecompressedLength` of 0 (which refused
a hand-built `zip: "DEF"` JWE under the notice key with `ERR_JOSE_NOT_SUPPORTED`), and fixed reason
codes. What differs here:

| Step        | A pushed notice                      | A poll answer                           |
| ----------- | ------------------------------------ | --------------------------------------- |
| exact `typ` | `usher-notice+jwt`                   | `usher-poll+jwt`                        |
| key         | the notice subkey                    | the poll-answer subkey                  |
| decryption  | `compactDecrypt`, never `jwtDecrypt` | the same                                |
| validator   | the `usher-types` notice validator   | the `usher-types` poll-answer validator |

Both `typ` values differ from the Usher token's `usher+jwt`, so none of the three can be read as
another.

**Why `compactDecrypt` and not `jwtDecrypt`.** A notice has no registered claim to check, and jose's
claim errors carry the plaintext. With `jwtDecrypt` and a mismatched `typ` option, the error was
`ERR_JWT_CLAIM_VALIDATION_FAILED`, and its `payload` held the principal notice's subject.
`JSON.stringify` of the error also printed it. `compactDecrypt` raises no claim errors, so the exact
`typ` check is the only `typ` check.

**Why the poll answer has its own `typ` and key.**

| Separation                    | A poll answer offered as a notice, or the reverse                      |
| ----------------------------- | ---------------------------------------------------------------------- |
| one key, one `typ`            | decrypted; only the validator refused it, by its shape                 |
| distinct `typ` values         | refused at the `typ` check                                             |
| distinct derived keys as well | refused at decryption, `ERR_JWE_DECRYPTION_FAILED`, with `typ` skipped |

## Authentication and confidentiality

### The channel assertion

On every push connection attempt and every poll, the bridge sends `Authorization: Bearer` with a JWS
built from the application key it already holds.

| Part                | Value                                                                 |
| ------------------- | --------------------------------------------------------------------- |
| algorithm           | HS256                                                                 |
| `typ`               | `usher-channel+jwt`                                                   |
| key                 | HKDF-SHA256 of the application key, info `usher/v1/channel-assertion` |
| `iss`               | the application's identifier                                          |
| `aud`               | `usher:controller`                                                    |
| `iat`, `exp`, `jti` | `exp` no later than `iat` plus 60 s; `jti` unique                     |

There is no `kid`. As for the Usher token, a `kid` and the key versions it names arrive together with
key rotation, which is open in [jose for the Usher token](jose-usher-token.md#open-questions).

The derivation keeps the encryption key from ever being used as an HMAC key. With an empty salt,
HKDF's extract step passes the application key to HMAC as its message, not its key (reasoned from
RFC 5869).

The controller:

- derives the same key from `iss`, pins `alg`, `typ` and `aud`, and checks `exp` with its clock
  tolerance, which jose takes in seconds: a `clockTolerance` of 30000 accepted an assertion an hour
  past its `exp`, and one of 30 refused it with `ERR_JWT_EXPIRED`;
- refuses a reused `jti` on a stream open, for example with a Valkey `SET NX` whose expiry matches
  `exp`;
- binds the stream to that application, and closes it after a maximum lifetime of 15 min and
  whenever the application's key is revoked or rotated away, so a stolen or stale connection does not
  outlive its authorization.

With jose 6.2.12 and subkeys from `node:crypto`'s `hkdfSync`, the assertion, 270 to 300 bytes
depending on its claim values, was accepted for its audience. It was refused for another audience
(`ERR_JWT_CLAIM_VALIDATION_FAILED`). It was refused under another application's derived key, the raw
underived key, and the encryption subkey (`ERR_JWS_SIGNATURE_VERIFICATION_FAILED`). An assertion
signed under a WebCrypto-derived subkey verified under the same subkey derived by `hkdfSync`, so a
bridge and a controller can each use either API.

The platform alternatives each tie the controller to one platform: Kubernetes projected
service-account tokens with audience `usher`, checked through TokenReview, tie it to the cluster's
API, and mutual TLS from a service mesh ties it to the mesh. The application-key path works anywhere
the key already reaches, across clusters included.

### Subkeys from the key the bridge holds

| Use                    | HKDF info                                                | Imported as | Usage     |
| ---------------------- | -------------------------------------------------------- | ----------- | --------- |
| channel assertion      | `usher/v1/channel-assertion`                             | HMAC-SHA256 | `sign`    |
| notice decryption      | `usher/v1/notice-encryption`                             | AES-GCM     | `decrypt` |
| poll-answer decryption | `usher/v1/poll-answer`                                   | AES-GCM     | `decrypt` |
| subject tag            | its own label, such as `usher/v1/subject-tag` (proposed) | HMAC-SHA256 | `sign`    |

The token key described in [jose for the Usher token](jose-usher-token.md) cannot feed HKDF. It is a
non-extractable AES-GCM `CryptoKey` whose only usage is decrypt, and WebCrypto refused HKDF on it:
`deriveBits` and `deriveKey` both threw `InvalidAccessError`. So at start the bridge imports the raw
bytes twice:

1. once as the AES-GCM key for the Usher token, non-extractable, usage `decrypt` only;
2. once as an HKDF base key, non-extractable, with usages `deriveBits` or `deriveKey` only.

It derives every subkey from the second at start, as non-extractable `CryptoKey`s. Then it
zero-fills the bytes, and keeps neither them nor the base key.

What was run on Node 24.16:

- The HKDF base key derived 32 bytes, and its bytes matched `hkdfSync` given the same salt and label.
- WebCrypto refuses an extractable HKDF key, and refuses `decrypt` as an HKDF key's usage.
- The derived notice key could not be exported, and decrypted a notice the controller encrypted under
  the `hkdfSync` subkey.
- Zeroing the bridge's copy of the bytes after the imports left every derived key working, since
  WebCrypto copies the bytes on import.

### Encryption to the audience

Each pushed notice's data, and each poll answer as a whole, is a compact JWE under `dir` and A256GCM.
TLS stays required beneath both.

| Measure                                         | Result                                                      |
| ----------------------------------------------- | ----------------------------------------------------------- |
| size of a small notice                          | about 200 bytes; one carrying a principal's subject was 205 |
| 1000 decryptions under the raw key bytes        | 28.6 to 31.9 ms over three runs                             |
| 1000 decryptions under the derived `CryptoKey`  | 17.9 to 21.3 ms over three runs, about 20 µs each           |
| a tampered notice, or another application's key | refused, `ERR_JWE_DECRYPTION_FAILED`                        |

Encryption alone protects neither freshness nor the poll's `after`, which is why the poll answer also
echoes both.

### Which applications hear which notices

| Kind            | Delivered to                          | What an application learns                           |
| --------------- | ------------------------------------- | ---------------------------------------------------- |
| category        | the audiences serving the resource    | changes to its own resources only                    |
| principal       | every audience                        | a tag it can match only to subjects it already holds |
| baseline        | every audience                        | that the baseline changed                            |
| global          | every audience                        | that every entry is dropped                          |
| servedResources | the audience whose served set changed | that its own served set changed                      |

A principal notice cannot be filtered: nothing records which applications hold a token for whom, and
a stale record would withhold a revocation silently. Positions stay one sequence, and the cursors a
bridge sees are opaque, so the gaps a filter leaves say nothing about other applications. With raw
global positions as cursors, each bridge would see gaps revealing how many notices went to other
applications, and when. Opaque must then hold in fact, not only in form: a cursor carries a position
and an epoch, and an encoding that leaves the position readable still shows the gaps.
[schema.md](../../../design/schema.md) "Decide E" compares the filtering options, and records only
that the cursors a bridge sees are opaque. Two encodings would make them so: a cursor the controller
encrypts, or a sequence the controller keeps per audience. The controller encrypts each cursor's
epoch and position under a key of its own, which it never shares, and the bridge, which compares
cursors only for equality, is the same under either.

### Threats and defences

| Threat                                                                     | Defence                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| an unauthenticated subscriber learns who was revoked                       | the channel assertion                                                                                        |
| a captured assertion is used again                                         | `exp` within 60 s, a single-use `jti` on stream open, the `aud` binding, and the maximum stream lifetime     |
| another application reads notices                                          | the per-audience JWE, which makes the boundary cryptographic                                                 |
| an application learns of resources or people it does not serve             | category notices filtered by audience, and principal notices named by a per-audience tag                     |
| a TLS-terminating ingress or a plaintext hop inside the cluster reads them | the JWE                                                                                                      |
| an old poll answer stands in for a new one                                 | the nonce, echoed inside the encrypted answer                                                                |
| a rewritten `after` skips a notice for good                                | `after`, echoed inside the encrypted answer                                                                  |
| a wrong or forged cursor skips notices                                     | cursors read only from decrypted content, and the poll position moved only by poll answers                   |
| a forged 410                                                               | it can only cause a reset, and head is read from an authenticated answer, never from the 410's body          |
| a client probes retention or volume                                        | the assertion checked before the version list and the cursor, and every assertion refusal the same 401       |
| a notice offered as a poll answer, or the reverse                          | distinct `typ` values checked exactly before decryption, and distinct derived keys                           |
| a reading failure writes a subject into a log                              | `compactDecrypt` rather than `jwtDecrypt`, fixed reason codes, and no jose, zod or `JSON.parse` error logged |
| a delay paced to keep the push looking live                                | only a poll answered within its deadline counts as a check                                                   |
| a broken or hostile stream grows the parser's memory                       | `maxBufferSize`, with an overflow treated as malformed                                                       |

## A notice overtaking an exchange

A notice applied while an exchange is in flight can leave that exchange's answer stale; the
affected-payload test, its trace and its measurements are in
[Core and Express layer](core-and-express-layer.md). The controller has a matching rule: a payload
recomputed from a snapshot read before a notice's commit is never written to the payload cache after
that notice has cleared it.

## Logging

- Never log the channel assertion, the `Authorization` header, a notice's body, or a JWE. On the
  controller this means redaction on the request logger.
- An applied notice is logged as `notice.applied`, with its `kind` and `entriesDropped` only: no
  subject, tag or cursor.
- A notice or a poll answer that fails to read is logged as `revocationChannel.malformed`, whose one
  field is `reason`, a fixed code, never an error.
- A refused version list is logged as `revocationChannel.malformed` too, with a reason code of its
  own. [audit-events.md](../../../design/audit-events.md) describes that event as a notice or a poll
  answer the bridge could not read, and a refused list is an answer in no version the bridge reads.
- So is a poll page asking for more from a cursor its check already asked after, with a reason code
  of its own.
- So is a push answered with a 200 that is not an event stream, with a reason code of its own, so a
  proxy answering the stream with a page of its own shows in the log. The poll still carries every
  notice.
- No jose, zod or `JSON.parse` error is logged. jose's claim errors carry the plaintext, and a V8
  `JSON.parse` message quoted the start of an invalid plaintext: `Unexpected token 's', "subject-123
is here" is not valid JSON`.
- The stream adds `revocationChannel.pushReconnect`, `revocationChannel.reset`,
  `revocationChannel.malformed` and `revocationChannel.failure` beside
  `revocationChannel.modeChange`. [audit-events.md](../../../design/audit-events.md) registers every
  event the bridge emits, with its fields and severity, and
  [Core and Express layer](core-and-express-layer.md) builds them.
- A failed poll, or a defect thrown while applying a pushed notice or handing a 410 to the channel,
  is logged as `revocationChannel.failure`, whose fields are `cause` and `count`: one event for each
  cause per interval, never one per failure, so a controller failing every poll cannot flood the log.

## Proxies on the path

A checklist for the controller's push route and every proxy on its path:

- `Content-Type: text/event-stream`;
- `Cache-Control: no-store`;
- `X-Accel-Buffering: no`;
- no compression on the stream;
- a read or idle timeout above 2H on every proxy;
- in Envoy, a route timeout of 0 for the stream's route.

What the defaults are (read from each project's documentation):

| Proxy | Default that matters                                                                                                                                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nginx | `proxy_read_timeout` 60 s, measured between two reads, after which the connection is closed; `proxy_buffering` on, which `X-Accel-Buffering: no` turns off per response    |
| Envoy | a route timeout of 15 s for the whole response, which must be 0 for a stream; a stream idle timeout of 5 min; a connection idle timeout of 1 h, only with no active stream |

No other proxy's default timeouts were checked, so the path a deployment actually uses must be
checked rather than assumed.

## The controller side, and the bridge's mock

| Package            | Version and date   | Notes                                                                                                                                                                      |
| ------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fastify            | 5.12.5, 2026-09-16 |                                                                                                                                                                            |
| @fastify/sse       | 0.6.0, 2026-07-27  | pre-1.0; peer fastify ^5.x; Node >=20.20.2; exposes `Last-Event-ID` and a `replay()` helper; `manual` mode allows a plain 410 before streaming                             |
| fastify-sse-v2     | 4.2.2, 2026-01-27  | third party; the @fastify/sse README lists it without `Last-Event-ID` support (read, not run)                                                                              |
| better-sse         | 0.16.1, 2025-12-29 | not examined beyond its version                                                                                                                                            |
| @fastify/websocket | 11.3.3, 2026-10-03 | built on `ws` ^8.16.0; hooks that run before the upgrade can answer 401; a message handler attached after asynchronous work silently drops messages (read from its README) |

What the controller must handle with @fastify/sse 0.6.0:

- It serializes `data` as JSON by default, so a compact JWE string arrives quoted unless it is
  serialized beforehand or the serializer is replaced.
- It sets `Cache-Control: no-cache`, where the checklist wants `no-store`, and sets
  `X-Accel-Buffering: no` by itself.
- It waits for `drain` on each connection when a write returns false, but its heartbeat writes bypass
  that wait (read from source).
- A `send()` on a connection destroyed in the same tick never settled, and was still pending after
  3 s. Fan-out must therefore send to each connection independently, with a timeout, never one
  connection after another.
- One stalled bridge must not hold up the others. Each connection gets a bounded queue and is closed
  on overflow, after which the bridge resumes through `Last-Event-ID` and the poll. Connections per
  audience are capped.

**The bridge's own tests use a mock on `node:http`, about 100 lines, with no framework dependency.**
Injecting faults is the mock's whole job: a dropped connection, a stall that accepts and never answers,
trimmed history, a cursor ahead of head, a cursor from another epoch, and a TCP proxy in front that cuts
idle connections, freezes both directions while keeping the sockets open, or paces what it forwards.
The real controller can then use @fastify/sse or raw writes against the same contract.

## Test rows

For the "Revocation and invalidation" and "Degraded modes" suites in
[bridge-tests.md](../../bridge-tests.md). The bridge's own suites hold every row except the two
naming the controller's answer to a cursor, from another epoch or one it cannot decrypt; those belong
with the controller's tests, and the bridge's mock models only the first.

| Given                                                                                 | Then                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the push silent for longer than the idle timeout                                      | the connection aborted, `revocationChannel.pushReconnect` logged, a reconnect from the push position, and a poll at once                                                                                                                    |
| a frozen push path                                                                    | found within the idle timeout, and the notice held in it applied on resume                                                                                                                                                                  |
| a pushed id that differs from the decrypted cursor                                    | malformed: nothing applied, no position moved, the connection aborted and logged                                                                                                                                                            |
| a parser overflow                                                                     | malformed, as above, and no further `feed()`                                                                                                                                                                                                |
| a 200 on the push that is not an event stream                                         | malformed: `revocationChannel.malformed` logged with its own reason code, and a reconnect with backoff; the poll still carries every notice                                                                                                 |
| a notice in a version the bridge did not list                                         | malformed; on the poll, no check                                                                                                                                                                                                            |
| a pushed notice later returned by the poll                                            | applied twice, with nothing new dropped                                                                                                                                                                                                     |
| a notice lost from the push, with a later one pushed                                  | the poll, from the poll position, returns the lost one                                                                                                                                                                                      |
| a 410 on the poll or the push                                                         | every entry dropped, the anonymous one included, and `revocationChannel.reset` logged, before head is requested                                                                                                                             |
| a cursor from another epoch                                                           | 410                                                                                                                                                                                                                                         |
| a poll answer not echoing the request's nonce or `after`                              | malformed: nothing applied, no check                                                                                                                                                                                                        |
| a poll still open at its deadline                                                     | aborted at D, no check, the pages answered before D still applied, and an immediate retry                                                                                                                                                   |
| a later page of a check still open D after the first page's start                     | aborted then, no check, and an immediate retry from the last page applied                                                                                                                                                                   |
| a poll aborted for any other reason                                                   | no check                                                                                                                                                                                                                                    |
| a poll and its immediate retry both failed or malformed                               | the next poll at the recovery interval, and each after it until a check is recorded, then the poll interval again                                                                                                                           |
| the listed notice versions refused, on the poll or the push                           | 406: a malformed channel, `revocationChannel.malformed` logged with its own reason code, and no check                                                                                                                                       |
| a cursor the controller cannot decrypt                                                | 410                                                                                                                                                                                                                                         |
| a notice naming the principal applied while its exchange is in flight                 | the answer discarded for every waiter, never cached, and exchanged once more, with `token.overtaken` logged, outcome `exchangedAgain`                                                                                                       |
| a second notice naming the principal applied while the repeated exchange is in flight | that answer discarded too, the open tier served, marked `suspended` and naming its verified subject for attribution alone, and `token.overtaken` logged, outcome `servedOpenTier`                                                           |
| a notice naming somebody else applied while an exchange is in flight                  | one exchange, and the answer cached                                                                                                                                                                                                         |
| a notice JWE offered as a poll answer, or the reverse                                 | refused at the `typ` check: malformed, nothing applied, no check                                                                                                                                                                            |
| a notice that fails to read, from its header to the validator                         | `revocationChannel.malformed` with a fixed reason code; no subject, plaintext or error message in the event                                                                                                                                 |
| a check whose last page arrives within D of its first                                 | the grace period runs from the first page's start                                                                                                                                                                                           |
| a global drop with more exchanges than the bound allows                               | 503 beyond the bound, and the anonymous payload fetched first                                                                                                                                                                               |
| a baseline notice, and the anonymous refetch failing                                  | 503 for anonymous and open-tier requests until it succeeds                                                                                                                                                                                  |
| an application key that differs from the controller's, at startup                     | the head poll refused with 401, the anonymous fetch still made and refused with 401, `token.exchangeFailure` with cause `assertionRefused` and `revocationChannel.modeChange` with reason `probableKeyMismatch` logged, and the bridge cold |
| an anonymous payload fetched before the head poll is answered                         | dropped, and fetched again once head is read                                                                                                                                                                                                |

## Not verified

1. Nothing was measured through a real ingress, gateway or service mesh. Whether bridge-to-controller
   traffic goes directly or through a layer 7 proxy depends on the deployment, and so do that proxy's
   timeouts.
2. HTTP/2 was not tested on either side.
3. The multi-instance controller was not exercised: losing a Valkey subscription, pub/sub used only as
   a wake-up to read the database, or the rush of reconnections when one instance dies.
4. No soak test was run for @fastify/sse 0.6.0, which is pre-1.0, or for the `fetch` client.
5. The experiments ran without TLS. That a TLS record's size reveals whether a poll answer carries
   notices is reasoned, not measured. Holding back such an answer is the same as holding back every
   answer, but the existence of a notice still shows to an observer on the path.
6. The channel was not wired into an Express ^4.18 application, so its lifecycle and shutdown inside
   Arranger's search-server are untested.
7. That timers and `performance.now()` ignore wall-clock steps is read from documentation, not tested
   by stepping the clock.
8. The anchored heartbeat is reasoned, not built.
9. The restore trace is reasoned from the schema's identity column, not run against a restored
   database.
10. The candidate grace timer ran as a model under node:test's mock timers, not inside a bridge.
11. The controller side of the key derivation was modelled with `hkdfSync` in the same process.
12. The per-audience subject tag is built on the bridge's side only; no controller computed one to
    compare with.
13. The controller's cursor encryption was not built. Neither a 410 for a cursor it cannot decrypt nor
    whether two instances encrypt one position to one cursor was run.
    [schema.md](../../../design/schema.md) "What is stored where" does not say where the cursor key
    is kept or when it is replaced.
14. No controller answered 406 to a notice versions header; the bridge's reading of one was tested
    against a fake controller only.

## Open questions

1. **How does a restore change the epoch?** [schema.md](../../../design/schema.md) leaves it as a step
   for the deployment runbook. The bridge needs only that every restore or history reset produces a
   new epoch, so that a cursor from before it gets 410.
2. **What does a refused channel assertion log?** The poll and the push answer 401, and the bridge
   records no check. On the poll, the refusal is logged as `revocationChannel.failure` with
   cause `status`, counted with every other status the poll fails on, so no field names the 401 as its
   cause. After startup, a refusal that persists also shows as `revocationChannel.modeChange` once
   the grace period runs out (reasoned). At startup no check has been recorded, so no grace period
   runs and the bridge stays cold; a refusal caused by a wrong key shows instead through the
   self-test, as "Startup order" sets out. On the push, the bridge logs nothing for it and keeps
   reconnecting with its backoff, each attempt with a fresh assertion, as the transport decisions set
   out.
