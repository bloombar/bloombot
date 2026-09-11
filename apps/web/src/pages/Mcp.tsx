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
 * **What is actually true as of MCP-7/MCP-8, and what this copy no longer
 * has to hedge about:**
 *  - **OAuth, not a pasted token.** MCP-7 made the MCP server its own
 *    authorization server — it publishes both `/.well-known` metadata
 *    documents and runs a real authorization-code-with-PKCE flow
 *    (`apps/mcp/src/oauth-provider.ts`). A client that adds the connector
 *    URL discovers all of that itself and sends the person to a Bloombot
 *    sign-in and consent screen (`apps/api/src/routes/mcp-oauth-consent.ts`)
 *    — there is no token to copy or paste for this path, unlike the one
 *    `pages/Connect.tsx`'s own `McpConnectForm` still offers (below).
 *  - **There is something to chat with, now.** MCP-8 added
 *    `chat.listCourses`/`chat.ask` (`apps/mcp/src/tool-surface.ts`'s own
 *    `MCP_CHAT_TOOL_SURFACE`) — the first lists every course the account
 *    may ask in, across every organization it can reach; the second asks
 *    one, through the same pipeline the web and Discord surfaces already
 *    use, grounded in the same course materials, recorded in the same
 *    transcripts. Before this landed, the tool surface was administration
 *    only — there was nothing to "chat with courses" about, and saying so
 *    would have been untrue. `chat.ask` resolves which course is meant on
 *    its own when there is exactly one available, and otherwise refuses
 *    and names the admitted courses rather than guessing — every answer
 *    also says which course it came from.
 *
 * **What connecting grants, precisely — unchanged, and still true:** the
 * client acts as the connected account, and reaches only the courses that
 * account could already reach (an enrolment, a membership whose course
 * settings allow it, or ownership of the organization) — connecting itself
 * grants nothing new.
 *
 * **No connection state here, still.** Reviewed again once MCP-7 landed:
 * it added the OAuth flow and the consent screen, not a status a caller
 * can read back — `apps/api/src/routes/` has `mcp-oauth-consent.ts` for the
 * flow itself and nothing that reports whether an account has a live
 * connection, the same gap this file's own module comment already found
 * before MCP-7 merged. Inventing that read here would still be a second
 * implementation of whatever eventually owns it — this screen renders
 * setup instructions alone, the same way `pages/SignIn.tsx` renders "not
 * configured" rather than guessing at a Google client id it was not given.
 * (Worth having, as a follow-up — noted in this slice's own report, not
 * built here.)
 *
 * **The connector URL, only when a deployment actually says so, and it
 * must be the server's own address.** MCP-7's resource identifier is
 * `new URL('/mcp', issuerUrl)` (`apps/mcp/src/index.ts`), where `issuerUrl`
 * is `CONFIG.PUBLIC_MCP_URL` — so the address a real client needs is
 * `${PUBLIC_MCP_URL}/mcp`, not this deployment's own `PUBLIC_APP_URL` (an
 * earlier version of this file derived from that instead, a review
 * finding: today's reference nginx config does not proxy `/mcp` at all,
 * so that guess fell through to the SPA's own catch-all and returned
 * `index.html` with HTTP 200 — a client expecting JSON-RPC got HTML,
 * silently, which is worse than no URL at all). `VITE_MCP_PUBLIC_URL`
 * (`docs/CONTRIBUTING.md` documents the exact relationship) must be set to
 * that same `${PUBLIC_MCP_URL}/mcp` value — two variables that can disagree
 * is a trap this file does not try to paper over by deriving one from the
 * other. `defaultConnectorUrl`, below, reads `VITE_MCP_PUBLIC_URL` alone,
 * and renders "not configured" when it is unset.
 */

import { useState } from 'react'

import { ApiError } from '../api/client.js'
import { Button } from '../components/Button.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { CopyIcon } from '../icons.js'
import type { Route } from '../routing/route.js'

export interface McpProps {
  /** The organization this tab is open under — the same `activeOrganizationId` `pages/Shell.tsx` threads into every other tab, needed here only to build the manual-connection link below (`{ kind: 'connect', organizationId }`). */
  organizationId: string
  /** `pages/Shell.tsx`'s own `navigate` (WEB-32/WEB-34), threaded straight through, the same unguarded way `pages/Transcripts.tsx` already takes it — nothing in this screen is a dirty form a navigation guard would need to interrupt. */
  navigate: (route: Route, options?: { replace?: boolean }) => void
  /**
   * `defaultConnectorUrl()` by default — a prop so a test can supply,
   * explicitly withhold (`undefined`, the "not configured" case), or omit
   * it without stubbing Vite's env, the same `'in' in props` distinction
   * `pages/SignIn.tsx`'s own `googleClientId` prop already draws.
   */
  connectorUrl?: string | undefined
}

/**
 * `VITE_MCP_PUBLIC_URL` alone — `undefined` when it is not set, which is
 * what an unconfigured build actually is: nothing else this app knows
 * proves the MCP server is reachable at all, so there is nothing true to
 * print, and this module's own caller renders "not configured" rather
 * than a guessed string. A trailing slash is stripped the same way
 * `packages/config`'s own `stripTrailingSlashes` normalises
 * `PUBLIC_APP_URL`/`PUBLIC_MCP_URL` — a deployment that sets this with one
 * still gets a URL that reads and copies as this connector's own address,
 * not one with a dangling `/`.
 */
function defaultConnectorUrl(): string | undefined {
  const configured = import.meta.env['VITE_MCP_PUBLIC_URL']
  return configured ? configured.replace(/\/+$/, '') : undefined
}

export function Mcp({ organizationId, navigate, ...props }: McpProps) {
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
          uses. Renders whether or not `connectorUrl` is configured — this
          is what the tab is, not instructions for using it. Names "MCP"
          once, in passing, since that is what the tab itself is called.
          "No token to copy or paste" is the one thing that changed under
          this reader's feet since MCP-7 — worth saying plainly, since the
          previous, token-based direction is still what
          `pages/Connect.tsx`'s own form below offers as a fallback, and a
          reader who has seen that elsewhere should not wonder which one is
          current. */}
      <p className="text-sm text-neutral-600">
        You can chat with Bloombot from an AI chat app you already use —
        ChatGPT, Claude, or something else that supports connectors — instead of
        coming to this site. Add the connector below, sign in and approve when
        the client asks — no token to copy or paste — and from then on, ask your
        course questions there and get the same answers, grounded in the same
        course materials, that you would get here or in Discord. Connecting
        grants no new access: the client acts as your account, and reaches only
        the courses you can already reach.
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
              connector, paste the URL above, then sign in and approve on the
              screen that opens.
            </li>
            <li>
              <strong>Claude:</strong> open Settings → Connectors → Add custom
              connector, paste the URL above, then sign in and approve on the
              screen that opens.
            </li>
          </ol>

          {/* With more than one course, the assistant asks rather than
              guesses — stated here, not in the top explanation, since it is
              how the tools behave once connected rather than why anyone
              would connect at all. */}
          <p className="text-sm text-neutral-500">
            With one course available, it just answers. With more than one, it
            will ask which course you mean — and every answer says which course
            it came from.
          </p>
        </section>
      ) : (
        <p className="text-sm text-neutral-500">
          The MCP connector is not configured for this deployment.
        </p>
      )}

      {/* MCP-7 kept the session-token bearer path (`bloombot_connectAssistant`,
          `/mcp/preview`/`/mcp/confirm`) alongside OAuth for a client that
          cannot open a sign-in redirect at all — `pages/Connect.tsx`'s own
          `McpConnectForm` is where that flow already lives, reachable today
          only by typing its address or following Discord's own invitation
          text. Linked here, clearly labelled as the fallback it is, rather
          than left unfindable — retiring it outright (the OAuth flow above
          removes the only reason it existed) is a separate, deliberately
          out-of-scope change. */}
      <button
        type="button"
        onClick={() => navigate({ kind: 'connect', organizationId })}
        className="self-start text-left text-sm text-brand-600 underline"
      >
        Can't use a sign-in redirect? Connect an assistant manually instead.
      </button>
    </div>
  )
}
