/**
 * `pages/Mcp.tsx` (WEB-47): the panel's own MCP setup instructions — a
 * layman's explanation of what this is and why anyone would want it, a
 * connector URL a reader can copy, and one step per client. No
 * connection-state assertions here: MCP-7's own read has not landed
 * (`pages/Mcp.tsx`'s own module comment), so this file only proves the
 * explanation and instructions.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Mcp } from '../src/pages/Mcp.js'

beforeEach(() => {
  // jsdom carries no `navigator.clipboard` by default — stubbed here the
  // same way `join-links.test.tsx` already does for the identical
  // `clipboard_unavailable` handling this screen reuses.
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Mcp (WEB-47)', () => {
  it('renders the connector URL and setup steps for both clients when configured', () => {
    render(<Mcp connectorUrl="https://panel.example.edu/mcp" />)

    expect(screen.getByTestId('mcp-connector-url')).toHaveTextContent(
      'https://panel.example.edu/mcp'
    )
    expect(screen.getByText(/ChatGPT:/)).toBeInTheDocument()
    expect(screen.getByText(/Claude:/)).toBeInTheDocument()
  })

  // The coordinator's own addition: a plain-language explanation for a
  // reader who has never heard of MCP, ahead of any setup detail. Asserted
  // by a stable phrase rather than the whole paragraph, so a copy edit does
  // not fail this suite unnecessarily.
  it("explains what this is and why anyone would want it, in layman's terms", () => {
    render(<Mcp connectorUrl="https://panel.example.edu/mcp" />)

    expect(
      screen.getByText(/chat with Bloombot from an AI chat app you already use/)
    ).toBeInTheDocument()
  })

  // The same explanation must render even when there is nothing configured
  // to copy — it says what the tab is, not how to use it.
  it('renders the explanation even when the connector is not configured', () => {
    render(<Mcp connectorUrl={undefined} />)

    expect(
      screen.getByText(/chat with Bloombot from an AI chat app you already use/)
    ).toBeInTheDocument()
  })

  // Review finding: re-rendering with two different `connectorUrl` *props*
  // proves only that this component renders its prop — true of any
  // component, and it exercised nothing `<Mcp />` (no prop, `Shell.tsx`'s
  // own render, `Shell.tsx:845`) actually takes in production. `Mcp`
  // reads `import.meta.env['VITE_MCP_PUBLIC_URL']` only when `connectorUrl`
  // is omitted entirely (the `'in' in props` check) — `vi.stubEnv` is what
  // exercises that path for real, the same way `sign-in.test.tsx` already
  // does for `VITE_GOOGLE_CLIENT_ID`. Renaming the env key, or reading a
  // different one, fails every case below without failing the tests above.
  describe('the default connector URL, read from VITE_MCP_PUBLIC_URL (no prop)', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('renders the exact value of VITE_MCP_PUBLIC_URL when set', () => {
      vi.stubEnv('VITE_MCP_PUBLIC_URL', 'https://mcp.example.edu/mcp')
      render(<Mcp />)
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
      render(<Mcp />)
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
      render(<Mcp />)
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
      render(<Mcp />)
      expect(screen.getByTestId('mcp-connector-url').textContent).toBe(
        'https://mcp.example.edu/mcp'
      )
    })
  })

  it('renders "not configured" rather than a guessed URL when none is given', () => {
    render(<Mcp connectorUrl={undefined} />)

    expect(
      screen.getByText(
        'The MCP connector is not configured for this deployment.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByTestId('mcp-connector-url')).not.toBeInTheDocument()
  })

  it('copies the connector URL to the clipboard', async () => {
    render(<Mcp connectorUrl="https://panel.example.edu/mcp" />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

    await screen.findByRole('button', { name: 'Copied!' })
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

    render(<Mcp connectorUrl="https://panel.example.edu/mcp" />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not copy the link — copy it from the text above by hand.'
    )
    expect(
      screen.queryByRole('button', { name: 'Copied!' })
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('mcp-connector-url')).toHaveTextContent(
      'https://panel.example.edu/mcp'
    )
  })
})
