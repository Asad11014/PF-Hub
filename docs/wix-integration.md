# Wix Integration page

`/app/wix` in the Hub manages the Wix ↔ Mintsoft integration, which runs as a separate Cloudflare Worker (repo `pf-arizvi/wix-integration`). The Worker imports paid Wix orders into Mintsoft and sends despatch tracking back to Wix.

## How it connects
```
Browser (Hub login) → Hub server /api/wix/* (server/wix.js) → Worker /admin/*
```
- `server/wix.js` forwards a fixed list of routes. Anything else is a 404, so it isn't a general proxy.
- The Worker's credentials are Hub environment variables and never reach the browser.
- Every call sends `X-Actor: <hub username>`, so the Worker's audit log records the person (as `hub:<username>`).
- Webhook URLs, which carry a per-client secret token, are removed from responses before they reach the browser.

## Environment variables (Render)
| Variable | Value |
|---|---|
| `WIX_INTEGRATION_URL` | `https://wix-integration.pf-integrations.workers.dev` (https only, no trailing slash) |
| `WIX_INTEGRATION_TOKEN` | The Worker's `ADMIN_TOKEN` |
| `WIX_INTEGRATION_ACCESS_CLIENT_ID` | Cloudflare Access service token ID. Only needed once Access protects the Worker's `/admin` |
| `WIX_INTEGRATION_ACCESS_CLIENT_SECRET` | Its secret |

Without the first two, the page says the integration isn't connected yet.

## Who can use it
Warehouse users only, using the same per-user permissions as Invoice Audit (`server/permissions.js`):

| Permission | Allows |
|---|---|
| `wix_integration` | Open the page; see status, held orders, errors and settings; preview imports, products and retries (dry runs write nothing) |
| `wix_integration_manage` | Also switch Mintsoft writes on and off, import, retry, create products, edit the courier map and carrier names, resolve errors, push despatches |
| Owner | Everything, plus adding Wix clients (the Wix API key goes straight to the Worker and isn't stored by the Hub) and granting access under **Wix Integration → Access** |

Owners hold both permissions automatically. The Worker also enforces its own guardrails whatever the Hub allows: the deploy-level writes master, the page's writes switch, and the Mintsoft client allowlist.
