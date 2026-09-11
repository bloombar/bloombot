/**
 * WEB-47 — the panel's own instructions for reaching a course's assistants
 * from an MCP client (ChatGPT, Claude): a layman's explanation of what this
 * is and why anyone would want it, the connector URL, and how to add it in
 * each client.
 *
 * **The same audience as Chat, not narrower.** LINK-10 (`pages/Shell.tsx`'s
 * own module comment) already draws the line this tab follows: a
 * membership gets every tab, a connected-but-not-a-member person (a
 * student, reachable only through a proven identity) gets Chat alone —
 * and this is exactly who most needs to know how to reach an assistant
 * from outside the browser, so it sits beside Chat in `effectiveTab`
 * rather than behind the organization-member group.
 *
 * **No connection state here, deliberately.** `/mcp/preview`/`/mcp/confirm`
 * (`apps/api/src/routes/person-link.ts`, LINK-8) already exist and are what
 * `pages/Connect.tsx`'s own `McpConnectForm` uses to confirm a session from
 * the assistant's side — but `PersonLinkStatusResponse` (`api/types.ts`)
 * carries a `discord` field for LINK-7's own durable status read and
 * nothing equivalent for MCP, and a concurrent slice (MCP-7, unmerged as of
 * this one) is what would add it. Inventing that read here, ahead of the
 * slice that actually owns it, would be a second implementation of the
 * same flow — this screen renders the setup instructions alone until it
 * exists, the same way `pages/SignIn.tsx` renders "not configured" rather
 * than guessing at a Google client id it was not given.
 *
 * **The connector URL, never a literal domain.** `apps/mcp/src/server.ts`
 * mounts its tool endpoint at `/mcp`, on `CONFIG.MCP_PORT`, bound to
 * `127.0.0.1` only — reaching it from outside this box is something a
 * deployment decides for itself, by adding an nginx `location /mcp`
 * proxied to that port at the *same* origin the panel itself is served
 * from (`docs/DEPLOY_DROPLET.md` §5.4's own suggested shape). `apps/web`
 * already has a build-time equivalent of that origin, `VITE_PUBLIC_APP_URL`
 * (documented in `docs/CONTRIBUTING.md`, read the same way
 * `prerender-plugin.ts` already reads it) — `defaultConnectorUrl`, below,
 * derives from that plus the literal `/mcp` apps/mcp itself answers on,
 * rather than guessing this project's own domain. `VITE_MCP_PUBLIC_URL`
 * overrides it outright, for a deployment that exposes the MCP server
 * somewhere else entirely (a distinct subdomain, a different path).
 */

import { useState } from 'react'

import { ApiError } from '../api/client.js'
import { Button } from '../components/Button.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { CopyIcon } from '../icons.js'

export interface McpProps {
  /**
   * `defaultConnectorUrl()` by default — a prop so a test can supply,
   * explicitly withhold (`undefined`, the "not configured" case), or omit
   * it without stubbing Vite's env, the same `'in' in props` distinction
   * `pages/SignIn.tsx`'s own `googleClientId` prop already draws.
   */
  connectorUrl?: string | undefined
}

/**
 * `VITE_MCP_PUBLIC_URL` if a deployment has set one explicitly, otherwise
 * `VITE_PUBLIC_APP_URL` (this deployment's own public origin, already
 * documented for `apps/web`) with the literal `/mcp` path
 * `apps/mcp/src/server.ts` mounts appended — `undefined` when neither is
 * set, which is what an unconfigured build actually is: there is nothing
 * true to print, so this module's own caller renders "not configured"
 * rather than a guessed string.
 */
function defaultConnectorUrl(): string | undefined {
  const explicit = import.meta.env['VITE_MCP_PUBLIC_URL']
  if (explicit) return explicit
  const publicAppUrl = import.meta.env['VITE_PUBLIC_APP_URL']
  return publicAppUrl ? `${publicAppUrl.replace(/\/+$/, '')}/mcp` : undefined
}

export function Mcp(props: McpProps) {
  const connectorUrl =
    'connectorUrl' in props ? props.connectorUrl : defaultConnectorUrl()

  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<ApiError | undefined>(undefined)

  // WEB-20's own clipboard handling (`components/JoinLinks.tsx#handleCopy`):
  // `navigator.clipboard` is `undefined` on a non-secure origin, which
  // throws before any promise exists to await — caught here the same way,
  // and reported through the same synthesized `ApiError` so it reads
  // through `describeApiError`'s own `clipboard_unavailable` case rather
  // than a bespoke message.
  const handleCopy = async () => {
    if (!connectorUrl) return
    setCopyError(undefined)
    try {
      await navigator.clipboard.writeText(connectorUrl)
      setCopied(true)
    } catch {
      setCopyError(new ApiError(0, { error: 'clipboard_unavailable' }))
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid="mcp-screen">
      <h1 className="text-page-title font-semibold text-neutral-900">MCP</h1>

      {/* A layman's explanation first, before any setup detail — a reader
          who has never heard of MCP still needs to know what this tab is
          for and why they would want it, in the same register
          `pages/Connect.tsx`'s own "Connect an assistant" section already
          uses ("This connects ChatGPT, Claude and other AI assistants, so
          you can chat with Bloombot from inside those apps."). Renders
          whether or not `connectorUrl` is configured — this is what the
          tab is, not instructions for using it. Names "MCP" once, in
          passing, since that is what the tab itself is called; nothing
          here leans on the acronym to carry meaning. Never overstates what
          connecting grants: no new access, and no promise beyond "supports
          connectors" for a client this deployment has not named. */}
      <p className="text-sm text-neutral-600">
        You can chat with Bloombot from an AI chat app you already use —
        ChatGPT, Claude, or something else that supports connectors — instead of
        coming to this site. Ask your course questions there and get the same
        answers, grounded in the same course materials. Connect once, using the
        MCP details below, and it reaches only the courses you already have
        access to — nothing more.
      </p>

      {connectorUrl ? (
        <section aria-label="Connector URL" className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-neutral-900">
            Connector URL
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {/* `break-all`, the same `JoinLinks.tsx` treatment, so a long
                URL never forces this row wider than a phone's own viewport
                (WEB-13). */}
            <code
              data-testid="mcp-connector-url"
              className="break-all rounded bg-neutral-100 px-2 py-1 text-neutral-900"
            >
              {connectorUrl}
            </code>
            <Button
              variant="secondary"
              icon={<CopyIcon aria-hidden="true" className="size-4" />}
              onClick={() => void handleCopy()}
            >
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>
          {copyError && <ErrorMessage error={copyError} />}

          <ol className="flex flex-col gap-2 text-sm text-neutral-700">
            <li>
              <strong>ChatGPT:</strong> open Settings → Connectors → Add
              connector, paste the URL above, and sign in with this account when
              prompted.
            </li>
            <li>
              <strong>Claude:</strong> open Settings → Connectors → Add custom
              connector, paste the URL above, and sign in with this account when
              prompted.
            </li>
          </ol>
        </section>
      ) : (
        <p className="text-sm text-neutral-500">
          The MCP connector is not configured for this deployment.
        </p>
      )}
    </div>
  )
}
