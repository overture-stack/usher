# Standard operating procedures

A standard operating procedure (SOP) is a sequence of steps an operator follows for one task on any
instance of Usher. Each names the identity provider's features as Keycloak's admin console and admin
API name them, and the Controller's operations by path. Each Controller operation here is sent with
the access token of the person acting; the API documentation page at `/api-docs` signs a person in
and sends it.

| SOP                                                                            | When to follow it                                                                   |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| [Setting up the first administrator](first-administrator.md)                   | once, after the Controller first starts, before anything else can be managed        |
| [Registering an application](registering-an-application.md)                    | once for each application, such as an Arranger deployment, before its Bridge starts |
| [Accepting a grant](accepting-a-grant.md)                                      | when you are granted access, and when a grant's role gains a capability             |
| [Accepting a nomination](accepting-a-nomination.md)                            | when someone nominates you as an administrator of Usher                             |
| [Revoking and lifting a person](revoking-and-lifting-a-person.md)              | when one person must lose all access at once, and when they get it back             |
| [Signing everyone out](signing-everyone-out.md)                                | when sign-in tokens may have leaked                                                 |
| [Responding to a compromised signing key](identity-provider-key-compromise.md) | when the identity provider's signing key may be in someone else's hands             |
