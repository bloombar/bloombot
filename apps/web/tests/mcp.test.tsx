/**
 * `pages/Mcp.tsx` (WEB-47): the panel's own MCP setup instructions — a
 * layman's explanation of what this is and why anyone would want it, a
 * connector URL a reader can copy, one step per client, and a link to the
 * still-working manual (token-paste) fallback. Rewritten once MCP-7
 * (OAuth) and MCP-8 (the chat tools) merged, so the copy this file pins
 * describes what actually exists now, not a hedge. No connection-state
 * assertions here: MCP-7 added the OAuth flow and its consent screen, not
 * a status read the panel could call (`pages/Mcp.tsx`'s own module
 * comment), so this file only proves the explanation, instructions and the
 * fallback link.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Mcp, type McpProps } from '../src/pages/Mcp.js'

/** `organizationId`/`navigate` every render needs (`Mcp`'s own required props) — a fresh `vi.fn()` per call, and `connectorUrl` deliberately *not* defaulted here: a caller that wants the env-read default path omits the key entirely, the same `'in' in props` distinction `pages/SignIn.tsx`'s own `googleClientId` draws. */
function mcpProps(overrides: Partial<McpProps> = {}): McpProps {
  return { organizationId: 'org-1', navigate: vi.fn(), ...overrides }
}

beforeEach(() => {
  // jsdom carries no `navigator.clipboard` by default — stubbed here the
  // same way `join-links.test.tsx` already does for the identical
  // `clipboard_unavailable` handling this screen reuses.
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
  // Rework finding (must-fix 3): `defaultIconUrl` now reads
  // `VITE_PUBLIC_APP_URL` too, the same `import.meta.env` carrying whatever
  // vite loaded from the developer's own `.env` that `d47f17d` already
  // fixed for `VITE_MCP_PUBLIC_URL` below — on a machine configured for the
  // real deployment this would otherwise make the icon-URL assertions read
  // a live origin and fail, while CI (no `.env`) passes. Cleared here, for
  // every test in this file, not only the connector-URL describe block
  // below; each case that wants a value still stubs its own.
  vi.stubEnv('VITE_PUBLIC_APP_URL', '')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Mcp (WEB-47)', () => {
  it('renders the connector URL and setup steps for both clients when configured', () => {
    render(
      <Mcp {...mcpProps({ connectorUrl: 'https://panel.example.edu/mcp' })} />
    )

    expect(screen.getByTestId('mcp-connector-url')).toHaveTextContent(
      'https://panel.example.edu/mcp'
    )
    expect(screen.getByText(/ChatGPT:/)).toBeInTheDocument()
    expect(screen.getByText(/Claude:/)).toBeInTheDocument()
  })

  // ChatGPT's current Plugins flow asks for these exact field values — a
  // reader who cannot find them cannot complete setup. Each value must
  // render as text a reader can find and copy by hand, distinguishable from
  // the surrounding prose (`<code>`, the same treatment the connector URL
  // itself already gets).
  it("renders ChatGPT's Plugins path and the exact field values to enter", () => {
    render(
      <Mcp {...mcpProps({ connectorUrl: 'https://panel.example.edu/mcp' })} />
    )

    expect(
      screen.getByText(/Settings → Plugins → Browse plugins/)
    ).toBeInTheDocument()
    expect(screen.getByText('Bloombot')).toBeInTheDocument()
    expect(screen.getByText('Course Assistant')).toBeInTheDocument()
    expect(screen.getByText('OAuth')).toBeInTheDocument()
  })

  // The copy must not pin a menu path as if it were permanent — the same
  // mistake being fixed here — so it must say plainly that the wording
  // drifts between clients and versions.
  it('says the menu names vary by client and version', () => {
    render(
      <Mcp {...mcpProps({ connectorUrl: 'https://panel.example.edu/mcp' })} />
    )

    expect(
      screen.getByText(/menu names below may differ from what you see/)
    ).toBeInTheDocument()
  })

  // The icon URL falls back to `${window.location.origin}/icon-512.png`
  // when `VITE_PUBLIC_APP_URL` is unset — this file's own `beforeEach`
  // clears that key, so this exercises the fallback specifically, not
  // whichever value a developer's own `.env` happens to set. jsdom's
  // default test origin is `http://localhost:3000`, so a hardcoded
  // `https://bloombot.wonkledge.com/icon-512.png` (or any other fixed
  // string) would fail this assertion; only a genuine `window.location
  // .origin` read produces it.
  it("renders the icon URL, derived from this app's own origin when VITE_PUBLIC_APP_URL is unset", () => {
    render(
      <Mcp {...mcpProps({ connectorUrl: 'https://panel.example.edu/mcp' })} />
    )

    expect(screen.getByTestId('mcp-icon-url')).toHaveTextContent(
      `${window.location.origin}/icon-512.png`
    )
  })

  // Rework finding, must-fix 3: `defaultIconUrl` used to read only
  // `window.location.origin`, an address the *reader's* browser resolves
  // but ChatGPT's own servers — the actual fetcher of this URL — cannot,
  // on a bare droplet IP, an internal hostname, or `vite preview`'s local
  // origin. `VITE_PUBLIC_APP_URL` is this deployment's declared public
  // origin (`prerender-plugin.ts` already reads it for the same reason)
  // and must be preferred when set.
  describe('the default icon URL, preferring VITE_PUBLIC_APP_URL', () => {
    it('prefers VITE_PUBLIC_APP_URL over window.location.origin when set', () => {
      vi.stubEnv('VITE_PUBLIC_APP_URL', 'https://panel.example.edu')
      render(
        <Mcp {...mcpProps({ connectorUrl: 'https://mcp.example.edu/mcp' })} />
      )
      expect(screen.getByTestId('mcp-icon-url').textContent).toBe(
        'https://panel.example.edu/icon-512.png'
      )
    })

    // The unset case — this file's own `beforeEach` already clears
    // `VITE_PUBLIC_APP_URL`, so this is a second, explicit assertion of the
    // same fact the test above's "when VITE_PUBLIC_APP_URL is unset" case
    // relies on implicitly.
    it('falls back to window.location.origin when VITE_PUBLIC_APP_URL is unset', () => {
      render(
        <Mcp {...mcpProps({ connectorUrl: 'https://mcp.example.edu/mcp' })} />
      )
      expect(screen.getByTestId('mcp-icon-url').textContent).toBe(
        `${window.location.origin}/icon-512.png`
      )
    })

    // `toHaveTextContent` is a substring match — the unstripped value
    // contains the stripped one as a prefix, so exact-equality on
    // `.textContent` is what actually proves the slash was stripped,
    // the same distinction `defaultConnectorUrl`'s own trailing-slash test
    // (below) already relies on.
    it('strips a trailing slash from VITE_PUBLIC_APP_URL', () => {
      vi.stubEnv('VITE_PUBLIC_APP_URL', 'https://panel.example.edu/')
      render(
        <Mcp {...mcpProps({ connectorUrl: 'https://mcp.example.edu/mcp' })} />
      )
      expect(screen.getByTestId('mcp-icon-url').textContent).toBe(
        'https://panel.example.edu/icon-512.png'
      )
    })
  })

  // The connector URL and the icon URL are two independently copyable
  // values — copying one must not claim the other was copied, and each
  // button must copy its own value.
  it('copies the icon URL, not the connector URL, from its own copy control', async () => {
    render(
      <Mcp {...mcpProps({ connectorUrl: 'https://panel.example.edu/mcp' })} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy icon URL' }))

    await screen.findByRole('button', { name: 'Icon URL copied' })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `${window.location.origin}/icon-512.png`
    )
    // The connector URL's own copy control is unaffected — still offering
    // to copy, not claiming it already did.
    expect(
      screen.getByRole('button', { name: 'Copy connector URL' })
    ).toBeInTheDocument()
  })

  // A stable phrase from the top explanation, not the whole paragraph, so
  // a copy edit does not fail this suite unnecessarily.
  it("explains what this is and why anyone would want it, in layman's terms", () => {
    render(
      <Mcp {...mcpProps({ connectorUrl: 'https://panel.example.edu/mcp' })} />
    )

    expect(
      screen.getByText(/chat with Bloombot from an AI chat app you already use/)
    ).toBeInTheDocument()
  })

  // MCP-7 removed the token-paste step for this path entirely — worth
  // stating plainly, since `pages/Connect.tsx`'s own form still offers the
  // token-based alternative (this file's own "manual fallback" describe
  // block, below) and a reader who has seen that elsewhere should not
  // wonder which one is current.
  it('says there is no token to copy or paste', () => {
    render(
      <Mcp {...mcpProps({ connectorUrl: 'https://panel.example.edu/mcp' })} />
    )

    expect(screen.getByText(/no token to copy or paste/)).toBeInTheDocument()
  })

  // The same explanation must render even when there is nothing configured
  // to copy — it says what the tab is, not how to use it.
  it('renders the explanation even when the connector is not configured', () => {
    render(<Mcp {...mcpProps({ connectorUrl: undefined })} />)

    expect(
      screen.getByText(/chat with Bloombot from an AI chat app you already use/)
    ).toBeInTheDocument()
  })

  // MCP-8's own course-selection behaviour, stated once it is real — this
  // note only renders alongside the setup steps (it describes what the
  // tools do once connected, not why anyone would connect).
  it('describes how the assistant picks a course once there is more than one', () => {
    render(
      <Mcp {...mcpProps({ connectorUrl: 'https://panel.example.edu/mcp' })} />
    )

    expect(
      screen.getByText(/it will ask which course you mean/)
    ).toBeInTheDocument()
  })

  // Review finding: re-rendering with two different `connectorUrl` *props*
  // proves only that this component renders its prop — true of any
  // component, and it exercised nothing `<Mcp organizationId=... navigate=... />`
  // (no `connectorUrl` prop, `Shell.tsx`'s own render) actually takes in
  // production. `Mcp` reads `import.meta.env['VITE_MCP_PUBLIC_URL']` only
  // when `connectorUrl` is omitted entirely (the `'in' in props` check) —
  // `vi.stubEnv` is what exercises that path for real, the same way
  // `sign-in.test.tsx` already does for `VITE_GOOGLE_CLIENT_ID`. Renaming
  // the env key, or reading a different one, fails every case below
  // without failing the tests above.
  describe('the default connector URL, read from VITE_MCP_PUBLIC_URL (no prop)', () => {
    // Every case below asserts what `Mcp` renders for a *given* value of
    // `VITE_MCP_PUBLIC_URL`, including the two that assert "not configured"
    // for a deployment that never set it. `import.meta.env` carries whatever
    // vite loaded from the developer's own `.env`, so on a machine where that
    // file sets `VITE_MCP_PUBLIC_URL` — a machine running the real
    // deployment, which is precisely the common case — those two cases read
    // the real URL and fail, while CI (no `.env`) passes. Clearing the key
    // first makes "unset" an actual fact of the test rather than an accident
    // of the machine; each case that wants a value still stubs its own.
    beforeEach(() => {
      vi.stubEnv('VITE_MCP_PUBLIC_URL', '')
    })

    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('renders the exact value of VITE_MCP_PUBLIC_URL when set', () => {
      vi.stubEnv('VITE_MCP_PUBLIC_URL', 'https://mcp.example.edu/mcp')
      render(<Mcp {...mcpProps()} />)
      expect(screen.getByTestId('mcp-connector-url')).toHaveTextContent(
        'https://mcp.example.edu/mcp'
      )
    })

    // Pins the exact key name: a rename (or reading some other variable
    // instead) leaves this env stubbed under the wrong key, and this test
    // catches that by asserting "not configured" — the correct answer for
    // an environment that never actually set the real key.
    it('ignores a similarly-named variable that is not VITE_MCP_PUBLIC_URL', () => {
      vi.stubEnv('VITE_MCP_URL', 'https://wrong-key.example.edu/mcp')
      render(<Mcp {...mcpProps()} />)
      expect(
        screen.getByText(
          'The MCP connector is not configured for this deployment.'
        )
      ).toBeInTheDocument()
      expect(screen.queryByTestId('mcp-connector-url')).not.toBeInTheDocument()
    })

    // Review finding: an earlier version of this component fell back to
    // `${VITE_PUBLIC_APP_URL}/mcp` when `VITE_MCP_PUBLIC_URL` was unset —
    // that origin is documented for `robots.txt`/canonical links, proves
    // nothing about whether MCP is actually exposed there, and today's own
    // reference nginx config does not proxy `/mcp` at all
    // (`docs/DEPLOY_DROPLET.md` §5.4). Guessing it returned `index.html`
    // with HTTP 200 instead of a refusal — worse than no URL. Fails
    // against that fallback (it would render the derived URL here instead
    // of "not configured").
    it('never falls back to VITE_PUBLIC_APP_URL, even when that is set and VITE_MCP_PUBLIC_URL is not', () => {
      vi.stubEnv('VITE_PUBLIC_APP_URL', 'https://panel.example.edu')
      render(<Mcp {...mcpProps()} />)
      expect(
        screen.getByText(
          'The MCP connector is not configured for this deployment.'
        )
      ).toBeInTheDocument()
      expect(screen.queryByTestId('mcp-connector-url')).not.toBeInTheDocument()
    })

    // `toHaveTextContent` alone is a substring match — the unstripped value
    // itself contains the stripped one as a prefix, so it would pass either
    // way. Reading `.textContent` directly and asserting exact equality is
    // what actually tells the two apart.
    it('strips a trailing slash from a configured value', () => {
      vi.stubEnv('VITE_MCP_PUBLIC_URL', 'https://mcp.example.edu/mcp/')
      render(<Mcp {...mcpProps()} />)
      expect(screen.getByTestId('mcp-connector-url').textContent).toBe(
        'https://mcp.example.edu/mcp'
      )
    })
  })

  it('renders "not configured" rather than a guessed URL when none is given', () => {
    render(<Mcp {...mcpProps({ connectorUrl: undefined })} />)

    expect(
      screen.getByText(
        'The MCP connector is not configured for this deployment.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByTestId('mcp-connector-url')).not.toBeInTheDocument()
  })

  it('copies the connector URL to the clipboard', async () => {
    render(
      <Mcp {...mcpProps({ connectorUrl: 'https://panel.example.edu/mcp' })} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy connector URL' }))

    await screen.findByRole('button', { name: 'Connector URL copied' })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'https://panel.example.edu/mcp'
    )
  })

  // The same clipboard-failure path `join-links.test.tsx` already proves
  // for WEB-20 — reused, not reimplemented, here.
  it('a clipboard that cannot be reached is reported, and the URL stays visible to copy by hand', async () => {
    // Standing in for a non-secure origin, where the browser never defines
    // `navigator.clipboard` at all — overriding this test file's own
    // `beforeEach` stub.
    Object.assign(navigator, { clipboard: undefined })

    render(
      <Mcp {...mcpProps({ connectorUrl: 'https://panel.example.edu/mcp' })} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy connector URL' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not copy the link — copy it from the text above by hand.'
    )
    expect(
      screen.queryByRole('button', { name: 'Connector URL copied' })
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('mcp-connector-url')).toHaveTextContent(
      'https://panel.example.edu/mcp'
    )
  })

  // Rework finding, must-fix 1: a failed *icon* copy used to render its
  // error beside the *connector* URL, since both controls shared one
  // `copyError` rendered only in the connector row — pointing the reader
  // at the wrong value with no feedback at all on the button they actually
  // clicked. This fails against that shared-state version: the alert would
  // not appear in the icon row's own `queryAllByRole('alert')` result, or
  // would appear twice (once per row) if both rendered it.
  it('an icon-copy failure renders its error beside the icon URL, not the connector URL', async () => {
    Object.assign(navigator, { clipboard: undefined })

    render(
      <Mcp {...mcpProps({ connectorUrl: 'https://panel.example.edu/mcp' })} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy icon URL' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'Could not copy the link — copy it from the text above by hand.'
    )
    // Both `<code>`s sit earlier in the same document than the alert
    // either way (the icon row is nested inside the connector section), so
    // document order alone cannot tell "beside the icon" from "beside the
    // connector" — what distinguishes them is which element the alert
    // renders immediately *next to*. The icon URL's own `<dd>` must be
    // followed directly by the alert; the connector row's own wrapping
    // `<div>` must not be (the old, shared-state version rendered it
    // there for every failure, including one on the icon field).
    const iconRow = screen.getByTestId('mcp-icon-url').closest('dd')
    expect(iconRow?.nextElementSibling).toBe(alert)
    const connectorRow = screen.getByTestId('mcp-connector-url').closest('div')
    expect(connectorRow?.nextElementSibling).not.toBe(alert)
    expect(connectorRow?.nextElementSibling).not.toHaveAttribute(
      'role',
      'alert'
    )
    // Exactly one alert on screen — the connector row must not also render
    // a (stale, shared) copy of the same error.
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  // Rework finding, must-fix 2: the `catch` used to set `copyError` without
  // ever clearing `copiedField`, so once a field's copy had succeeded once,
  // a *later failure on that same field* — a `navigator.clipboard` that
  // stops working mid-session, e.g. focus leaving the window and a browser
  // throwing `NotAllowedError` — left the button still reading "Copied!"
  // while a failure alert sat right beside it. Copying the icon URL
  // successfully, then failing on a second click of the *same* button, is
  // what this fails against: `copiedField` stays `'icon'` forever once set,
  // so `'Icon URL copied'` remains the accessible name even though the
  // click that just ran failed.
  it('a failed copy does not leave a stale "Copied!" for the field that failed', async () => {
    render(
      <Mcp {...mcpProps({ connectorUrl: 'https://panel.example.edu/mcp' })} />
    )

    // Succeed once, on the icon URL.
    fireEvent.click(screen.getByRole('button', { name: 'Copy icon URL' }))
    await screen.findByRole('button', { name: 'Icon URL copied' })

    // Then fail on that same field.
    Object.assign(navigator, { clipboard: undefined })
    fireEvent.click(screen.getByRole('button', { name: 'Icon URL copied' }))
    await screen.findByRole('alert')

    // The button must not go on claiming success for the copy that just
    // failed.
    expect(
      screen.queryByRole('button', { name: 'Icon URL copied' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Copy icon URL' })
    ).toBeInTheDocument()
  })

  // The complementary case: a failure on one field must not erase a
  // genuine, still-current success already showing on the *other* field.
  it('a failure on one field leaves the other field\'s "Copied!" alone', async () => {
    render(
      <Mcp {...mcpProps({ connectorUrl: 'https://panel.example.edu/mcp' })} />
    )

    // Succeed once, on the connector URL.
    fireEvent.click(screen.getByRole('button', { name: 'Copy connector URL' }))
    await screen.findByRole('button', { name: 'Connector URL copied' })

    // Then fail on the icon URL.
    Object.assign(navigator, { clipboard: undefined })
    fireEvent.click(screen.getByRole('button', { name: 'Copy icon URL' }))
    await screen.findByRole('alert')

    expect(
      screen.getByRole('button', { name: 'Connector URL copied' })
    ).toBeInTheDocument()
  })

  // The coordinator's own addition: MCP-7 kept `pages/Connect.tsx`'s own
  // token-paste form working, for a client that cannot open a sign-in
  // redirect — this tab must link to it, clearly labelled as the fallback
  // it is, rather than leave it reachable only by typing its address.
  describe('the manual-connection fallback', () => {
    it('is offered, labelled as a fallback for a client that cannot use a sign-in redirect', () => {
      render(<Mcp {...mcpProps({ connectorUrl: undefined })} />)

      expect(
        screen.getByRole('button', {
          name: /Can't use a sign-in redirect\? Connect an assistant manually instead\./,
        })
      ).toBeInTheDocument()
    })

    // Renders regardless of whether a connector URL is configured — a
    // deployment with no MCP server exposed yet still has the token-paste
    // path available (`pages/Connect.tsx`'s own form does not depend on
    // this tab's own `VITE_MCP_PUBLIC_URL` at all).
    it('is offered even when the connector itself is not configured', () => {
      render(<Mcp {...mcpProps({ connectorUrl: undefined })} />)

      expect(
        screen.getByRole('button', {
          name: /Connect an assistant manually instead/,
        })
      ).toBeInTheDocument()
    })

    it("navigates to this organization's own /connect address", () => {
      const navigate = vi.fn()
      render(
        <Mcp
          {...mcpProps({
            organizationId: 'org-42',
            navigate,
            connectorUrl: undefined,
          })}
        />
      )

      fireEvent.click(
        screen.getByRole('button', {
          name: /Connect an assistant manually instead/,
        })
      )

      expect(navigate).toHaveBeenCalledWith({
        kind: 'connect',
        organizationId: 'org-42',
      })
    })
  })
})
