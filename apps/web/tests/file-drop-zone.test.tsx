/**
 * The drop zone's contract, which is mostly about the routes in that are NOT
 * dragging: a zone that only works for somebody with a mouse and a file
 * manager open is the failure this component exists to avoid.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { FileDropZone } from '../src/components/FileDropZone.js'

const file = (name: string, bytes = 4, type = 'text/plain'): File =>
  new File(['x'.repeat(bytes)], name, { type })

/** A drop carrying real files, the way a browser delivers one. */
function dropFile(target: Element, dropped: File): void {
  const dataTransfer = {
    files: [dropped],
    items: [{ kind: 'file', type: dropped.type }],
    types: ['Files'],
  }
  fireEvent.drop(target, { dataTransfer })
}

describe('FileDropZone', () => {
  it('takes a dropped file', () => {
    const onFileChosen = vi.fn()
    render(<FileDropZone label="Course file" onFileChosen={onFileChosen} />)

    dropFile(
      screen.getByRole('button', { name: /Course file/ }),
      file('notes.md')
    )

    expect(onFileChosen).toHaveBeenCalledTimes(1)
    expect(onFileChosen.mock.calls[0]?.[0]).toMatchObject({ name: 'notes.md' })
  })

  it('opens the picker on click, so dragging is never the only way in', () => {
    render(<FileDropZone label="Course file" onFileChosen={vi.fn()} />)
    const picker = vi.spyOn(HTMLInputElement.prototype, 'click')

    fireEvent.click(screen.getByRole('button', { name: /Course file/ }))

    expect(picker).toHaveBeenCalled()
    picker.mockRestore()
  })

  it('is a real button, so the keyboard reaches it (WEB-17)', () => {
    render(<FileDropZone label="Course file" onFileChosen={vi.fn()} />)
    const zone = screen.getByRole('button', { name: /Course file/ })

    // A `<button>` is focusable and activates on Enter/Space without any
    // handler of our own — which is the whole reason this is not a `<div>`
    // with an `onClick`. Assert the properties that make that true, since a
    // regression here would be someone swapping the element out.
    expect(zone.tagName).toBe('BUTTON')
    expect(zone).not.toHaveAttribute('tabindex', '-1')
    zone.focus()
    expect(zone).toHaveFocus()
  })

  it('clears its drag state when the pointer leaves without dropping', () => {
    render(<FileDropZone label="Course file" onFileChosen={vi.fn()} />)
    const zone = screen.getByRole('button', { name: /Course file/ })

    fireEvent.dragEnter(zone, { dataTransfer: { types: ['Files'] } })
    expect(zone).toHaveAttribute('data-dragging', 'true')

    fireEvent.dragLeave(zone)
    expect(zone).not.toHaveAttribute('data-dragging')
  })

  it('refuses a file over the limit, on the field, rather than silently', async () => {
    const onFileChosen = vi.fn()
    render(
      <FileDropZone
        label="Course file"
        maxBytes={8}
        onFileChosen={onFileChosen}
      />
    )

    dropFile(
      screen.getByRole('button', { name: /Course file/ }),
      file('huge.md', 64)
    )

    expect(await screen.findByText(/The limit is 8 bytes/)).toBeInTheDocument()
    expect(onFileChosen).not.toHaveBeenCalled()
  })

  it("refuses a file the caller's own rule rejects, with that rule's words", async () => {
    const onFileChosen = vi.fn()
    render(
      <FileDropZone
        label="Course file"
        validate={(candidate) =>
          candidate.name.endsWith('.exe')
            ? 'That kind of file is not accepted.'
            : undefined
        }
        onFileChosen={onFileChosen}
      />
    )

    dropFile(
      screen.getByRole('button', { name: /Course file/ }),
      file('installer.exe')
    )

    expect(
      await screen.findByText('That kind of file is not accepted.')
    ).toBeInTheDocument()
    expect(onFileChosen).not.toHaveBeenCalled()
  })

  it('stops a file dropped elsewhere navigating the page away to it', async () => {
    render(<FileDropZone label="Course file" onFileChosen={vi.fn()} />)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Course file/ })
      ).toBeInTheDocument()
    )

    // The browser's default for a drop anywhere on the document is to open
    // the file, discarding whatever the person was in the middle of.
    const stray = new Event('drop', { cancelable: true, bubbles: true })
    window.dispatchEvent(stray)

    expect(stray.defaultPrevented).toBe(true)
  })

  it('accepts nothing while an upload is in flight', () => {
    const onFileChosen = vi.fn()
    render(
      <FileDropZone label="Course file" disabled onFileChosen={onFileChosen} />
    )

    dropFile(
      screen.getByRole('button', { name: /Course file/ }),
      file('notes.md')
    )

    expect(onFileChosen).not.toHaveBeenCalled()
  })
})
