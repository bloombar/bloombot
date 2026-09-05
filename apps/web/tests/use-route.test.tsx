/**
 * WEB-32/WEB-34: `routing/useRoute.ts` itself — the hook that owns browser
 * history for this app. `tests/routing.test.ts` covers the pure
 * `parseRoute`/`buildPath` pair; this file covers the parts that only exist
 * once a real `window.history` is involved: what a `popstate` does while a
 * dirty form is registered, and what `navigate` does when asked to go where
 * it already is.
 *
 * Both are review findings against the slice that introduced the router,
 * and both are behaviour a unit test on the pure functions cannot see.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useEffect } from 'react'

import {
  NavigationGuardProvider,
  useNavigationGuard,
} from '../src/hooks/navigation-guard.js'
import { useRoute } from '../src/routing/useRoute.js'
import { buildPath, type Route } from '../src/routing/route.js'

/**
 * Renders the hook and exposes what it currently holds, plus buttons that
 * drive it — the same "a harness, not a mock" shape `tests/navigation-guard.test.tsx`
 * already uses for the guard primitive.
 */
function Harness({ target }: { target: Route }) {
  const { route, navigate } = useRoute()
  return (
    <div>
      <p data-testid="route-kind">{route.kind}</p>
      <p data-testid="path">{window.location.pathname}</p>
      <p data-testid="history-length">{String(window.history.length)}</p>
      <button type="button" onClick={() => navigate(target)}>
        navigate
      </button>
    </div>
  )
}

const ORG_PROJECTS: Route = { kind: 'projects', organizationId: 'org-1' }
const ORG_CHAT: Route = { kind: 'chat', organizationId: 'org-1' }

beforeEach(() => {
  window.history.replaceState(null, '', buildPath(ORG_PROJECTS))
})

afterEach(() => {
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('useRoute (WEB-32, WEB-34)', () => {
  it('a navigation to the address already on screen is not a navigation at all', () => {
    const pushState = vi.spyOn(window.history, 'pushState')

    render(<Harness target={ORG_PROJECTS} />)
    fireEvent.click(screen.getByRole('button', { name: 'navigate' }))
    fireEvent.click(screen.getByRole('button', { name: 'navigate' }))

    // Fails without the fix: `navigate` pushed unconditionally, so clicking
    // the drawer item for the screen already on display (they stay
    // clickable) stacked one identical entry per click and left Back
    // apparently inert for as many presses as the person had made.
    expect(pushState).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe(buildPath(ORG_PROJECTS))
  })

  it('a navigation somewhere else still pushes exactly one entry', () => {
    const pushState = vi.spyOn(window.history, 'pushState')

    render(<Harness target={ORG_CHAT} />)
    fireEvent.click(screen.getByRole('button', { name: 'navigate' }))

    expect(pushState).toHaveBeenCalledTimes(1)
    expect(window.location.pathname).toBe(buildPath(ORG_CHAT))
    expect(screen.getByTestId('route-kind')).toHaveTextContent('chat')
  })

  describe('a dirty form and the browser back button (WEB-16)', () => {
    /**
     * `popstate` is the one navigation this app does not start, so the
     * guard has to be consulted from the hook rather than from whichever
     * control was clicked. Before the fix, `popstate` set the route
     * directly: the panel used to push no history entries at all, so Back
     * left the document and the browser's own `beforeunload` prompt asked;
     * once Back became an in-app navigation, nothing asked at all and the
     * edits were simply gone.
     */
    function GuardedHarness({
      guardResult,
      onGuardAsked,
    }: {
      guardResult: boolean
      onGuardAsked: () => void
    }) {
      return (
        <NavigationGuardProvider>
          <DirtyForm guardResult={guardResult} onGuardAsked={onGuardAsked} />
        </NavigationGuardProvider>
      )
    }

    function DirtyForm({
      guardResult,
      onGuardAsked,
    }: {
      guardResult: boolean
      onGuardAsked: () => void
    }) {
      const { route, navigate } = useRoute()
      return (
        <div>
          <p data-testid="route-kind">{route.kind}</p>
          <p data-testid="path">{window.location.pathname}</p>
          <button type="button" onClick={() => navigate(ORG_CHAT)}>
            navigate
          </button>
          <RegisterGuard
            guardResult={guardResult}
            onGuardAsked={onGuardAsked}
          />
        </div>
      )
    }

    /**
     * Moves the harness to `/o/org-1/chat` through the hook itself (so the
     * hook knows where it is), then reproduces what a browser does on Back:
     * the address is *already* the previous one by the time `popstate`
     * fires.
     */
    async function goThenPressBack() {
      fireEvent.click(screen.getByRole('button', { name: 'navigate' }))
      window.history.replaceState(null, '', buildPath(ORG_PROJECTS))
      await act(async () => {
        window.dispatchEvent(new PopStateEvent('popstate'))
        await Promise.resolve()
      })
    }

    it('asks before honouring a back that would leave a dirty form, and stays put when the answer is "keep editing"', async () => {
      const onGuardAsked = vi.fn()
      render(<GuardedHarness guardResult={false} onGuardAsked={onGuardAsked} />)

      await goThenPressBack()

      expect(onGuardAsked).toHaveBeenCalledTimes(1)
      // Refused: the address is put back, so the screen on display and the
      // address bar still agree.
      expect(window.location.pathname).toBe(buildPath(ORG_CHAT))
    })

    it('honours the back once the person confirms discarding', async () => {
      const onGuardAsked = vi.fn()
      render(<GuardedHarness guardResult={true} onGuardAsked={onGuardAsked} />)

      await goThenPressBack()

      expect(onGuardAsked).toHaveBeenCalledTimes(1)
      expect(window.location.pathname).toBe(buildPath(ORG_PROJECTS))
      expect(screen.getByTestId('route-kind')).toHaveTextContent('projects')
    })
  })

  /**
   * WEB-35 (rework round 1, must-fix 2/7) — a Back/Forward that only moves
   * a course editor's own tab must bypass the guard entirely, even with
   * one registered: nothing unmounts for that move
   * (`pages/CourseEditor.tsx` keeps every visited tab mounted, hidden), so
   * consulting the guard produced a modal that lied either way — "Discard
   * changes" discarded nothing, "Keep editing" stranded the reader on
   * whichever tab the address had already moved to.
   */
  describe('a same-screen tab move bypasses the guard entirely (WEB-35, WEB-16)', () => {
    const COURSE_GENERAL: Route = {
      kind: 'course-editor',
      organizationId: 'org-1',
      projectId: 'proj-1',
      courseId: 'course-1',
      tab: 'general',
    }
    const COURSE_AI: Route = { ...COURSE_GENERAL, tab: 'ai' }

    function CourseTabHarness({ onGuardAsked }: { onGuardAsked: () => void }) {
      const { route, navigate } = useRoute()
      return (
        <div>
          <p data-testid="route-tab">
            {route.kind === 'course-editor' ? route.tab : ''}
          </p>
          <button type="button" onClick={() => navigate(COURSE_AI)}>
            go to ai
          </button>
          <RegisterGuard guardResult={false} onGuardAsked={onGuardAsked} />
        </div>
      )
    }

    it('a Back that only changes the tab moves the tab directly, without ever asking the guard', async () => {
      window.history.replaceState(null, '', buildPath(COURSE_GENERAL))
      const onGuardAsked = vi.fn()
      render(
        <NavigationGuardProvider>
          <CourseTabHarness onGuardAsked={onGuardAsked} />
        </NavigationGuardProvider>
      )

      fireEvent.click(screen.getByRole('button', { name: 'go to ai' }))
      expect(screen.getByTestId('route-tab')).toHaveTextContent('ai')

      // The browser's own Back — the address is already back at General by
      // the time `popstate` fires, same as `goThenPressBack` above.
      window.history.replaceState(null, '', buildPath(COURSE_GENERAL))
      await act(async () => {
        window.dispatchEvent(new PopStateEvent('popstate'))
        await Promise.resolve()
      })

      // Fails without the fix: a guard registered here (`guardResult:
      // false`, "refused") would have pushed the address back to `ai` and
      // shown a modal for a move that unmounts nothing at all.
      expect(onGuardAsked).not.toHaveBeenCalled()
      expect(screen.getByTestId('route-tab')).toHaveTextContent('general')
      expect(window.location.pathname).toBe(buildPath(COURSE_GENERAL))
    })
  })
})

/** Registers a guard on mount, the way `useUnsavedChangesGuard` does while a form is dirty. */
function RegisterGuard({
  guardResult,
  onGuardAsked,
}: {
  guardResult: boolean
  onGuardAsked: () => void
}) {
  const { registerGuard } = useNavigationGuard()
  useEffect(() => {
    registerGuard(() => {
      onGuardAsked()
      return Promise.resolve(guardResult)
    })
    return () => registerGuard(null)
  }, [registerGuard, guardResult, onGuardAsked])
  return null
}
