# x4-compliance-mcp

Remote MCP server for the X4 Group **Compliance** team. Serves Amiqus identity
verification and AML onboarding data to Claude over an authenticated endpoint.

Replaces the local `amiqus` Claude plugin (stdlib Python + `setup.bat`), which
required a manual install on every machine and read its API token from a
plaintext file in OneDrive.

    Endpoint:  https://<project>.vercel.app/api/compliance/mcp
    Region:    lhr1 (London)
    Scope:     READ ONLY

## Why this is its own deployment

Separate from `x4-mcp-server` (the Sales connector) on purpose: AML and identity
data gets its own blast radius, its own shared secret and its own retention
posture. The ~50-line auth gate is copied rather than shared; at one file that
is cheaper than maintaining a package.

## Why Seven20 is not wired in here

Compliance users already have the Seven20 connector, which runs as **their own
Salesforce login**. A service identity in this project would hand every user the
same scope regardless of their own permissions, which is a regression in access
control on the most sensitive data we hold. So joins happen above, in Claude,
across the two connectors.

**The join key is email, lowercased. Name is not a fallback and must never
become one.** A sample of 20 Amiqus clients matched 51 Seven20 Contact records;
one name alone carried 17 duplicates. Matching on name would return a confident
wrong answer on an AML gate rather than an error.

## Environment variables

Set as Vercel **Sensitive** Environment Variables, Production.

| Variable | Required | Notes |
|---|---|---|
| `AMIQUS_API_TOKEN` | yes | Amiqus Personal Access Token, Contracts Team account |
| `MCP_SHARED_SECRET` | yes | Gates the endpoint. Fails closed if unset |
| `MCP_SHARED_SECRET_PREVIOUS` | no | Outgoing secret during a rotation; both accepted while set |
| `AMIQUS_BASE_URL` | no | Defaults to `https://id.amiqus.co/api/v2` |

### ⚠ Token expiry

Amiqus Personal Access Tokens **expire one year after creation and cannot be
refreshed programmatically.** There is no warning from Amiqus. When it expires,
every tool starts returning 401 and Compliance loses the connector with no
notice.

    Token minted:  2026-10-06
    EXPIRES:       2026-10-06 + 1 year  ->  2027-10-06

Put a reminder in the calendar for **September 2027**. Renewal is: mint a new
PAT on the Contracts Team account, update `AMIQUS_API_TOKEN` in Vercel,
redeploy, then revoke the old one.

## Gotchas that cost a day

Both of these were found the hard way on 6 Oct 2026. Read them before touching
auth or environment variables.

**An environment variable change does nothing until you redeploy.** Vercel bakes
env vars into a deployment at build time. Editing a value in the dashboard only
changes what the NEXT build receives; the running one keeps the old value. A
gate that fails closed will return 403 to a perfectly correct secret.

**The shared secret must be URL-safe.** It is passed as `?k=`, and a base64
secret ends in `=` padding which gets percent-encoded somewhere between the
clipboard and the request, arriving as `%3D` and never matching. Use hex or
alphanumerics only - nothing containing `+`, `/`, `=`, `%` or whitespace.

Better still, avoid the URL entirely: the connector's **Request headers** panel
(Authentication set to "No sign-in") can carry `Authorization: Bearer <secret>`,
which this gate already accepts. That keeps the secret out of URLs, browser
history and logs, and sidesteps encoding completely.

**If a connector gets stuck** in `needs_reconnect` after failed attempts, delete
it and add it fresh. The client caches a bad state that retrying does not clear.
The "Couldn't register with the sign-in service" error is OAuth dynamic client
registration failing, which is expected here and harmless once the connector is
added cleanly.

## Rotating the shared secret

1. Copy the current `MCP_SHARED_SECRET` value into `MCP_SHARED_SECRET_PREVIOUS`.
2. Set a new `MCP_SHARED_SECRET`. Redeploy.
3. Both now work. Hand out the new connector URL.
4. Watch Vercel logs for `[gate] authenticated with MCP_SHARED_SECRET_PREVIOUS`.
5. When those stop, delete `MCP_SHARED_SECRET_PREVIOUS` and redeploy.

## Deploying

    npx vercel --prod

(On the Windows work laptop use `npx.cmd`; PowerShell execution policy blocks
`npx.ps1`.)

## Tools

| Tool | Status |
|---|---|
| `amiqus_whoami` | shipped |
| `amiqus_search_clients` | to port |
| `amiqus_list_records` | to port |
| `amiqus_get_record` | to port |
| `amiqus_get_record_items` | to port |
| `amiqus_list_client_records` | to port |
| `amiqus_list_templates` | to port |
| `amiqus_get_client_forms` | to port |
| `amiqus_create_record` | **out of scope** - writes excluded from v1 |

### Composite tools

Added because the daily question cost 1 + N calls through the passthrough
tools. `amiqus_list_records` reports "0 of 2 complete" but every `steps[].title`
and `steps[].status` comes back null, so document names only appear via
`/records/{id}/steps`, one record at a time.

| Tool | What it answers |
|---|---|
| `amiqus_chase_list` | Everyone outstanding, with the real names of the documents they still owe, days waiting, days to expiry, ordered by urgency. One call instead of 23. |
| `amiqus_check_status` | Given emails (normally from Seven20), each person's gate state: cleared, outstanding with named missing items, or no record. Returns an explicit `not_found` list. |

Both fan out server-side at a concurrency of 5, and isolate per-record errors so
one unreadable record cannot take down the whole list. Amiqus rate limits, and
this function has 30 seconds.

The passthrough tools are unchanged. These are additive: ad-hoc questions still
work exactly as before.

All list responses are capped at 50 (`MAX_LIST`) and carry an insight-level
note. Amiqus holds passport images, addresses and AML results; no tool here is
allowed to become a bulk-extraction endpoint. That cap is inherited from the
Python server deliberately, not by accident.
