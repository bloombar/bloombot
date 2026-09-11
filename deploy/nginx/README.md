# `deploy/nginx`

nginx configuration this deployment needs but `scripts/deploy.sh` cannot apply.

Everything here requires root on the droplet. The deploy user (`DEPLOY_USER`) has
no passwordless `sudo`, deliberately — a deploy that could rewrite the web
server's own configuration is a much larger blast radius than a deploy that
restarts four Node processes. So these files are committed, reviewed and
versioned here, and applied by hand.

## `mcp.conf` — required before the MCP connector works

MCP-7 (OAuth 2.1) and MCP-8 (the chat tools) are merged and deployed, but the
MCP server's port is **not proxied**: `docs/DEPLOY_DROPLET.md` §5.4 says so
outright. Until `mcp.conf` is applied, `https://<host>/mcp` falls through to the
SPA fallback and answers an MCP client with `index.html` and an HTTP **200** —
the confusing failure, not a clean one.

Apply it:

```bash
sudo cp /etc/nginx/sites-enabled/bloombot /etc/nginx/sites-enabled/bloombot.bak
sudo nano /etc/nginx/sites-enabled/bloombot    # paste mcp.conf inside the
                                              # `listen 443 ssl` server block,
                                              # above `location / {`
sudo nginx -t                                 # MUST pass before reloading
sudo systemctl reload nginx
```

If `nginx -t` fails, restore and reload:

```bash
sudo cp /etc/nginx/sites-enabled/bloombot.bak /etc/nginx/sites-enabled/bloombot
sudo systemctl reload nginx
```

Then set these in the droplet's **repository-root** `.env` — the same file
every other deployment setting lives in, not `apps/web/.env*` — and redeploy so
the processes pick them up (both must agree — see below):

```
PUBLIC_MCP_URL=https://<host>
VITE_MCP_PUBLIC_URL=https://<host>/mcp
```

`PUBLIC_MCP_URL` is the OAuth **issuer** that `apps/mcp` publishes in its
metadata documents (`packages/config/src/env.ts`). `VITE_MCP_PUBLIC_URL` is the
connector URL the panel's MCP tab shows a person to paste, which is the
**resource identifier** — `new URL('/mcp', issuerUrl)`. They are two variables
describing one deployment, so a mismatch shows one URL in the panel while the
server advertises another, and the connector fails with nothing explaining why.
`VITE_MCP_PUBLIC_URL` is read at `apps/web`'s **build** time, not at process
start — changing it needs a rebuild of `apps/web` (redeploy), not merely a
process restart (`apps/web/vite.config.ts`'s own module comment, WEB-47
defect). An `apps/web/.env`/`.env.production` entry for the same key, if one
exists, still wins over the root `.env`'s value.

## Verifying it worked

From anywhere, with no MCP client involved:

```bash
# The discovery document a connector reads first. Expect JSON, not HTML.
curl -s https://<host>/.well-known/oauth-authorization-server | head -c 400

# The resource document. Expect JSON naming the authorization server.
curl -s https://<host>/.well-known/oauth-protected-resource/mcp | head -c 400

# The endpoint itself. Expect a JSON-RPC error about a missing session or
# method — NOT `text/html`, which means the SPA answered instead.
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://<host>/mcp

# The consent screen. Expect HTML from apps/api (an "expired or unknown"
# message for a made-up id), not the SPA shell.
curl -s 'https://<host>/oauth/mcp/authorize?request=made-up' | head -c 200

# Unchanged by this config — confirm nothing regressed:
curl -s https://<host>/health            # {"ready":true,...} from apps/api
```

The last check matters: `mcp.conf` deliberately does not route `/health` (apps/api
owns it, and the deploy's own health check depends on it) or
`/.well-known/acme-challenge` (Certbot owns it, and renewal breaks if it is
shadowed).

Once those pass, add the connector in ChatGPT or Claude using
`VITE_MCP_PUBLIC_URL`'s value. The client discovers the rest itself.
