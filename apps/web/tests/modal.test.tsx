/**
 * WEB-15/WEB-16/WEB-17: the modal primitive (`Modal.tsx` + `useModal()`
 * from `ModalProvider.tsx`) — alert, confirm and prompt, all one dialog
 * markup. `install-button.test.tsx` and `course-editor.test.tsx` cover a
 * real destructive flow through it; this file tests the primitive itself.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  ModalProvider,
  useModal,
} from '../src/components/modal/ModalProvider.js'

function AlertHarness() {
  const { alert } = useModal()
  return (
    <button type="button" onClick={() => void alert({ title: 'Saved' })}>
      trigger alert
    </button>
  )
}

function ConfirmHarness({
  onResult,
  destructive = false,
}: {
  onResult: (result: boolean) => void
  destructive?: boolean
}) {
  const { confirm } = useModal()
  return (
    <button
      type="button"
      onClick={() =>
        void confirm({
          title: 'Delete this course?',
          description: 'This cannot be undone.',
          destructive,
        }).then(onResult)
      }
    >
      trigger confirm
    </button>
  )
}

function PromptHarness({
  onResult,
  destructive = false,
}: {
  onResult: (result: string | undefined) => void
  destructive?: boolean
}) {
  const { prompt } = useModal()
  return (
    <button
      type="button"
      onClick={() =>
        void prompt({
          title: 'Type the course name',
          label: 'Course name',
          destructive,
        }).then(onResult)
      }
    >
      trigger prompt
    </button>
  )
}

describe('Modal primitive (WEB-15/WEB-16/WEB-17)', () => {
  it('confirm(): cancelling resolves false and never runs the caller-supplied action', async () => {
    const onResult = vi.fn()
    render(
      <ModalProvider>
        <ConfirmHarness onResult={onResult} />
      </ModalProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'trigger confirm' }))

    const dialog = await screen.findByRole('dialog', {
      name: 'Delete this course?',
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel', hidden: false })
    )
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false))
    expect(dialog).not.toBeVisible()
  })

  it('confirm(): confirming resolves true exactly once', async () => {
    const onResult = vi.fn()
    render(
      <ModalProvider>
        <ConfirmHarness onResult={onResult} />
      </ModalProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'trigger confirm' }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true))
    expect(onResult).toHaveBeenCalledTimes(1)
  })

  it('a destructive confirm renders the confirm button in the destructive style, and does not default-focus it', async () => {
    render(
      <ModalProvider>
        <ConfirmHarness onResult={vi.fn()} destructive />
      </ModalProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'trigger confirm' }))
    await screen.findByRole('dialog')
    const confirmButton = screen.getByRole('button', { name: 'Confirm' })
    const cancelButton = screen.getByRole('button', { name: 'Cancel' })
    // WEB-15: destructive is styled distinctly from primary — asserted
    // through the class this app's own `Button.tsx` gives `variant="destructive"`.
    expect(confirmButton.className).toContain('danger')
    // WEB-15/coordinator instruction: never default-focused.
    expect(cancelButton).toHaveFocus()
  })

  it('alert(): acknowledging resolves the promise', async () => {
    render(
      <ModalProvider>
        <AlertHarness />
      </ModalProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'trigger alert' }))
    const dialog = await screen.findByRole('dialog', { name: 'Saved' })
    // An alert offers no Cancel — one way out.
    expect(
      screen.queryByRole('button', { name: 'Cancel' })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(dialog).not.toBeVisible())
  })

  // ADMIN-5's own rework finding: `PromptOptions` carried no `destructive`
  // flag, so a severe prompt (typing a tenant's own name to delete it)
  // rendered its submit button primary, identically to an ordinary save —
  // the same distinct styling `confirm`'s own `destructive` already gets.
  it('a destructive prompt renders the confirm button in the destructive style', async () => {
    render(
      <ModalProvider>
        <PromptHarness onResult={vi.fn()} destructive />
      </ModalProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'trigger prompt' }))
    await screen.findByRole('dialog')
    const confirmButton = screen.getByRole('button', { name: 'Confirm' })
    expect(confirmButton.className).toContain('danger')
  })

  it('prompt(): confirming resolves the typed value; cancelling resolves undefined', async () => {
    const onResult = vi.fn()
    render(
      <ModalProvider>
        <PromptHarness onResult={onResult} />
      </ModalProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'trigger prompt' }))
    await screen.findByRole('dialog')
    const field = screen.getByLabelText('Course name')
    expect(field).toHaveFocus()
    fireEvent.change(field, { target: { value: 'Intro to Testing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith('Intro to Testing')
    )
  })

  it('Escape cancels a confirm dialog', async () => {
    const onResult = vi.fn()
    render(
      <ModalProvider>
        <ConfirmHarness onResult={onResult} />
      </ModalProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'trigger confirm' }))
    const dialog = await screen.findByRole('dialog')
    // jsdom's own `<dialog>` gap (`tests/setup.ts`'s own module comment) —
    // this polyfill does not simulate `Escape` dispatching the native
    // `cancel` event the way a real browser does, so this test drives the
    // same `onCancel` path `Modal.tsx` wires that event to directly. The
    // real key-driven path is `e2e/keyboard.spec.ts`'s own job, against a
    // real browser (WEB-17's own "a keyboard test that clicks is not a
    // keyboard test").
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false))
  })
})
