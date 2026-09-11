/**
 * `pages/Mcp.tsx` (WEB-47): the panel's own MCP setup instructions — a
 * connector URL a reader can copy, one step per client, and a plain
 * sentence on what connecting grants. No connection-state assertions here:
 * MCP-7's own read has not landed (`pages/Mcp.tsx`'s own module comment),
 * so this file only proves the instructions half.
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
    // What connecting grants, plainly, without overstating it.
    expect(
      screen.getByText(/can reach only the courses you can already reach/)
    ).toBeInTheDocument()
  })

  // Fails without the change: before this component read a configured
  // value at all, there was nothing for this test to distinguish — a
  // literal string would still pass with the deployment's own URL edited
  // out entirely.
  it('the connector URL comes from configuration, not a literal', () => {
    const { rerender } = render(
      <Mcp connectorUrl="https://first.example.edu/mcp" />
    )
    expect(screen.getByTestId('mcp-connector-url')).toHaveTextContent(
      'https://first.example.edu/mcp'
    )

    rerender(<Mcp connectorUrl="https://second.example.edu/mcp" />)
    expect(screen.getByTestId('mcp-connector-url')).toHaveTextContent(
      'https://second.example.edu/mcp'
    )
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
