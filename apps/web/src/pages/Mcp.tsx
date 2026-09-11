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
 *
 * **WEB-47 defect fix — ChatGPT's setup path, and copy that survives the
 * next vendor rename.** The two-line "open Settings → Connectors" list this
 * file used to carry went stale: ChatGPT moved this to
 * Settings → Plugins → Browse plugins → the `+` icon, and now asks for
 * per-field values (a name, a description, the connection URL, an
 * authentication mode, and an optional icon) rather than a single paste.
 * Rather than pin that path as if it were permanent — the same mistake this
 * copy is being rewritten to fix — the instructions below say plainly that
 * the menu names drift between clients and versions ("Plugin",
 * "Connector", and "MCP server" have all meant the same thing at different
 * points) and tell the reader what to look for rather than exactly where to
 * click. Claude's own current path is not something this slice's author
 * could confirm, so its entry says only what is actually true — add a
 * custom connector by URL, sign in, approve — rather than inventing a menu
 * that might already be wrong by the time this ships.
 *
 * **The icon URL comes from `window.location.origin`, not `PUBLIC_APP_URL`
 * — deliberately the opposite rule from the connector URL just above.** The
 * connector URL has to name the MCP server's own address, which is why
 * deriving it from anything about *this* app (this deployment's own origin
 * included) is wrong — the two need not even share a host. The icon is the
 * opposite case: `/icon-512.png` is a static asset genuinely served by this
 * very app, at whatever origin it is actually reached on, so
 * `window.location.origin` is definitionally correct and has nothing to
 * misconfigure — there is no separate "where is the icon really served"
 * question the way there is for the MCP server. `Mcp` is not one of
 * `prerender-plugin.ts`'s three prerendered paths (`/`, `/privacy`,
 * `/terms` — it renders `Home`/`StaticDocument` directly, never `App`, and
 * never this page), so `window` is always defined wherever this component
 * actually renders today; `iconUrl` below still guards for it being
 * undefined rather than assume that stays true forever.
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

/**
 * The optional icon field's own value — `${window.location.origin}/icon-512.png`,
 * this app's own 512×512 icon, served by this same app at whatever origin
 * it is actually reached on. Unlike `defaultConnectorUrl` above, there is
 * no separate config key to read here on purpose: the icon is a static
 * asset of *this* deployment, so the deployment's own origin is
 * definitionally where it lives, with nothing to misconfigure. Returns
 * `undefined` rather than a bare `/icon-512.png` when `window` itself is
 * missing — `Mcp` is not one of `prerender-plugin.ts`'s three prerendered
 * paths, so this should not happen today, but a relative path copied to a
 * client's icon field would resolve against *that client's* origin, not
 * this app's, which is worse than omitting it.
 */
function defaultIconUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined
  return `${window.location.origin}/icon-512.png`
}

export function Mcp({ organizationId, navigate, ...props }: McpProps) {
  const connectorUrl =
    'connectorUrl' in props ? props.connectorUrl : defaultConnectorUrl()
  const iconUrl = defaultIconUrl()

  // Two independently copyable values (the connector URL, the icon URL)
  // share one `ApiError` slot — a clipboard failure is a clipboard failure
  // regardless of which value triggered it — but need separate "Copied!"
  // affordances, so each tracks which *field* was last copied rather than
  // a single boolean that would claim both were copied at once.
  const [copiedField, setCopiedField] = useState<
    'connector' | 'icon' | undefined
  >(undefined)
  const [copyError, setCopyError] = useState<ApiError | undefined>(undefined)

  // WEB-20's own clipboard handling (`components/JoinLinks.tsx#handleCopy`):
  // `navigator.clipboard` is `undefined` on a non-secure origin, which
  // throws before any promise exists to await — caught here the same way,
  // and reported through the same synthesized `ApiError` so it reads
  // through `describeApiError`'s own `clipboard_unavailable` case rather
  // than a bespoke message.
  const handleCopy = async (value: string, field: 'connector' | 'icon') => {
    setCopyError(undefined)
    try {
      await navigator.clipboard.writeText(value)
      setCopiedField(field)
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
              aria-label={
                copiedField === 'connector'
                  ? 'Connector URL copied'
                  : 'Copy connector URL'
              }
              icon={<CopyIcon aria-hidden="true" className="size-4" />}
              onClick={() => void handleCopy(connectorUrl, 'connector')}
            >
              {copiedField === 'connector' ? 'Copied!' : 'Copy'}
            </Button>
          </div>
          {copyError && <ErrorMessage error={copyError} />}

          {/* Menu names drift between clients and between versions of the
              same client — "Plugin", "Connector" and "MCP server" have all
              meant this exact setting at different points, which is why the
              two-step list this replaced went stale. Said once, up front,
              rather than re-litigated per client below. */}
          <p className="text-sm text-neutral-600">
            The exact menu names below may differ from what you see — look for
            whichever your client calls a "connector", a "plugin", or an "MCP
            server"; they are the same thing.
          </p>

          <div className="flex flex-col gap-4 text-sm text-neutral-700">
            <div>
              <p>
                <strong>ChatGPT:</strong> Settings → Plugins → Browse plugins →
                the <code className="rounded bg-neutral-100 px-1">+</code> icon
                to add a new plugin, then fill in:
              </p>
              <dl className="mt-2 flex flex-col gap-1 pl-4">
                <div className="flex flex-wrap gap-2">
                  <dt className="text-neutral-500">Name</dt>
                  <dd>
                    <code className="rounded bg-neutral-100 px-1">
                      Bloombot
                    </code>
                  </dd>
                </div>
                <div className="flex flex-wrap gap-2">
                  <dt className="text-neutral-500">Description</dt>
                  <dd>
                    <code className="rounded bg-neutral-100 px-1">
                      Course Assistant
                    </code>
                  </dd>
                </div>
                <div className="flex flex-wrap gap-2">
                  <dt className="text-neutral-500">Connection</dt>
                  <dd>the connector URL above</dd>
                </div>
                <div className="flex flex-wrap gap-2">
                  <dt className="text-neutral-500">Authentication</dt>
                  <dd>
                    <code className="rounded bg-neutral-100 px-1">OAuth</code>
                  </dd>
                </div>
                {iconUrl && (
                  <div className="flex flex-wrap items-center gap-2">
                    <dt className="text-neutral-500">Icon (optional)</dt>
                    <dd className="flex flex-wrap items-center gap-2">
                      <code
                        data-testid="mcp-icon-url"
                        className="break-all rounded bg-neutral-100 px-2 py-1 text-neutral-900"
                      >
                        {iconUrl}
                      </code>
                      <Button
                        variant="secondary"
                        aria-label={
                          copiedField === 'icon'
                            ? 'Icon URL copied'
                            : 'Copy icon URL'
                        }
                        icon={
                          <CopyIcon aria-hidden="true" className="size-4" />
                        }
                        onClick={() => void handleCopy(iconUrl, 'icon')}
                      >
                        {copiedField === 'icon' ? 'Copied!' : 'Copy'}
                      </Button>
                    </dd>
                  </div>
                )}
              </dl>
              <p className="mt-2 text-neutral-500">
                Then sign in and approve on the screen that opens.
              </p>
            </div>
            <p>
              <strong>Claude:</strong> add a custom connector by URL, using the
              connector URL above, then sign in and approve on the screen that
              opens.
            </p>
          </div>

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
