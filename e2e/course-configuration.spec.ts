/**
 * QA-8: "the product's central claim is tested end to end." Phase 7's own
 * point, from `docs/ROADMAP.md`: "a tenant creates a project, defines a
 * course in it, and the bot answers in their server without anyone editing
 * a file in this repository." This spec drives every step of that sentence
 * except the very last hop.
 *
 * **What is real, and what is a harness stand-in — read this before trusting
 * what this test proves:**
 *
 *  - Real: the browser (`pages/Projects.tsx`, `pages/Courses.tsx`,
 *    `pages/CourseEditor.tsx`), a real `apps/api` (`e2e/support/start-api.ts`),
 *    a real throwaway SQLite database, and every action this UI drives —
 *    `projects.create`, `courses.save`, `courses.enable`,
 *    `courseInstructions.save` (WEB-19) — reached exactly the way any other
 *    caller reaches them (WEB-7/PROJ-5's own point).
 *  - Real: `@bloombot/discord`'s own `handleMention` (SURF-1..6) and
 *    `@bloombot/core`'s `answerQuestion`/`routeMessage` underneath it — the
 *    actual routing and answering pipeline, unmodified, running against the
 *    same database file the browser and `apps/api` just wrote to.
 *  - **Not real, and this is the harness's own stand-in, not `apps/bot`'s**:
 *    there is no discord.js client anywhere in this spec, no gateway
 *    connection, and no Discord server was ever created. The Discord server
 *    binding this test needs is inserted directly with
 *    `discordServers.claimDiscordServerBinding` — the same repository
 *    function TEN-4's real install flow calls, just invoked here instead of
 *    walked through Discord's own OAuth consent screen, which this harness
 *    has no way to automate. The "message arriving in Discord" is a plain
 *    `InboundMention` object this spec constructs by hand
 *    (`e2e/support/fake-reply-port.ts`'s own module comment has the same
 *    caveat) and hands to `handleMention` *in this test process*, not
 *    posted to any real channel.
 *  - **Not real**: the model. `e2e/support/fake-model-client.ts` answers
 *    with a fixed string — no OpenAI call happens anywhere in this run
 *    (QA-3's own "no network beyond loopback").
 *
 * So this test proves: a course defined entirely through the panel's own
 * screens, with no file in this repository touched and no process
 * restarted, is exactly the configuration `handleMention` routes and
 * answers a matching message with — the database round trip the whole
 * migration exists to make true. It does not prove discord.js itself wires
 * correctly to `handleMention` (`apps/bot`, untouched by this slice) or that
 * a real OpenAI call succeeds (`packages/openai`, also untouched).
 */

import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import {
  accounts,
  closeDatabase,
  conversations,
  courses,
  discordServers,
  memberships,
  openDatabase,
  people,
  projects,
} from '@bloombot/db'
import { handleMention, type InboundMention } from '@bloombot/discord'

import { E2E_DATABASE_PATH } from './support/env.js'
import { navigateTo } from './support/navigate.js'
import { createFakeLogger } from './support/fake-logger.js'
import { FakeModelClient } from './support/fake-model-client.js'
import { FakeReplyPort } from './support/fake-reply-port.js'
import { signIn } from './support/sign-in.js'

test('a project and course defined entirely in the panel route and answer a matching message (QA-8)', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `qa8-${suffix}@example.edu`
  const projectName = `Fall 2026 — ${suffix}`
  const courseTitle = `Web Design — ${suffix}`
  const categoryName = `Web Design - GLOBAL - ${suffix}`
  const studentsRole = `students-wd-${suffix}`
  const adminsRole = `admins-wd-${suffix}`
  const courseInstructions =
    'Answer student questions about the course clearly and concisely.'

  // 1. Sign in — the same emailed-link flow `auth-flow.spec.ts` exercises,
  //    which also creates this account's own personal organization (TEN-1).
  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  // 2. Create a project (WEB-7/PROJ-1), through the panel alone.
  await navigateTo(page, 'Projects')
  // WEB-27: "New project" opens a modal that asks for the name.
  await page.getByRole('button', { name: 'New project' }).click()
  const newProjectDialog = page.getByRole('dialog', { name: 'New project' })
  await newProjectDialog.getByLabel('Project name').fill(projectName)
  await newProjectDialog.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: projectName, exact: true }).click()

  // 3. Define a course in it (WEB-8): title, roles (CFG-3), one category
  //    (CFG-4) — the two names that decide routing (WEB-9) — and enable it.
  await page.getByRole('button', { name: 'New course' }).click()
  await page.getByLabel('Title').fill(courseTitle)
  await page.getByLabel('Admins role').fill(adminsRole)
  await page.getByLabel('Students role').fill(studentsRole)
  await page.getByRole('button', { name: 'Add category' }).click()
  await page.getByLabel('Category name').fill(categoryName)
  await page.getByLabel('Enabled').check()
  await page.getByRole('button', { name: 'Save course' }).click()

  // The save succeeded once the settings tabs appear — they only render
  // once `courseId` is set, i.e. once `courses.save` actually returned a
  // saved course rather than a refusal.
  await expect(page.getByRole('tab', { name: 'General' })).toBeVisible()

  // WEB-19/FILE-4: instructions (CFG-2: D-3's escape hatch — a course with
  // neither `instructions` nor `promptId` set answers nothing at all,
  // `answerQuestion`'s own "not-configured" result) are saved through their
  // own versioned action, `courseInstructions.save`, not `courses.save` —
  // `components/CourseInstructions.tsx`'s own section, offered only once the
  // course exists (the same "existing record only" gate the knowledge-files
  // and Discord-channels sections below it use). "Current" only renders
  // once `courseInstructions.list` actually reads back the revision this
  // save just recorded.
  // WEB-35: Instructions now lives on its own AI tab, not the single
  // scrolling form this course editor used to be.
  await page.getByRole('tab', { name: 'AI' }).click()
  await page.getByLabel('Instructions').fill(courseInstructions)
  await page.getByRole('button', { name: 'Save instructions' }).click()
  // WEB-40: the History section is collapsed by default — open it before
  // looking for "Current".
  await page.getByRole('button', { name: /Show history/ }).click()
  await expect(page.getByText('Current')).toBeVisible()

  // 4. This is where the browser's own part ends. Everything from here
  //    reads back the same database `apps/api` just wrote to, and drives
  //    `@bloombot/discord`'s real `handleMention` directly (this module's
  //    own comment: no discord.js, no gateway, no OpenAI call).
  const db = openDatabase(E2E_DATABASE_PATH)
  try {
    const account = accounts.getAccountByEmail(email, db)
    if (!account) throw new Error('setup failed: account not found')
    const [membership] = memberships.listMembershipsForAccount(account.id, db)
    if (!membership) throw new Error('setup failed: membership not found')
    const organizationId = membership.organizationId

    const project = projects
      .listProjects(organizationId, db)
      .find((candidate) => candidate.name === projectName)
    if (!project) throw new Error('setup failed: project not found')
    const course = courses
      .listCourses(organizationId, db, { projectId: project.id })
      .find((candidate) => candidate.title === courseTitle)
    if (!course) throw new Error('setup failed: course not found')
    expect(course.enabled).toBe(true)

    // Bind a Discord server directly (see this file's own module comment
    // for why: TEN-4's real OAuth consent screen cannot be automated here) —
    // the same repository function the real install flow calls.
    const guildId = `e2e-guild-${suffix}`
    const claimed = discordServers.claimDiscordServerBinding(
      organizationId,
      { serverId: guildId, installedByAccountId: account.id },
      db
    )
    if (!claimed) throw new Error('setup failed: could not bind guild')

    const model = new FakeModelClient('The midterm is on the 14th.')
    const reply = new FakeReplyPort()
    const logger = createFakeLogger()
    const botId = 'e2e-bot'
    const studentDiscordId = `e2e-student-${suffix}`

    // LINK-1 — an unconnected identity is invited to connect, not answered;
    // this test is proving CORE-2/CORE-1's routing and answering pipeline
    // (QA-8's own scope, this file's own module comment), not LINK-1 itself,
    // so the student is connected the same way a real proof would leave
    // them (`@bloombot/db`'s `people.ts#mergePeople`, called by
    // `@bloombot/auth`'s `person-link.ts` once a real proof succeeds) —
    // merging a second, throwaway identity onto the Discord one this
    // mention is about to arrive under.
    const student = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'discord', externalId: studentDiscordId },
      db
    )
    const other = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'web', externalId: `e2e-web-${suffix}` },
      db
    )
    const merged = people.mergePeople(organizationId, student.id, other.id, db)
    if (!merged)
      throw new Error('setup failed: could not connect the e2e student')

    // authorRoleNames is deliberately empty: the requirement under test is
    // that a message in *this course's own category* is routed to it, and
    // `handleMention` falls back to role names only when the category
    // matches no course (`packages/discord/src/dto.ts`'s own comment on
    // `authorRoleNames`) — leaving the role populated let it carry the whole
    // route while the category the instructor typed went unchecked (finding
    // 1 of the WEB-7 rework).
    const mention: InboundMention = {
      guildId,
      channelName: 'announcements',
      categoryName,
      authorId: studentDiscordId,
      authorDisplayName: 'QA Student',
      authorRoleNames: [],
      text: `<@${botId}> When is the midterm?`,
      botId,
      authorIsBot: false,
      repliesToBot: false,
    }

    const result = await handleMention(mention, {
      db,
      model,
      logger,
      reply,
      day: '2026-09-01',
      connectUrl: 'https://e2e.bloombot.test',
    })

    // Routed to, and answered by, exactly the course this test just defined
    // through the panel — nothing here is a fixture or a seed script.
    expect(result.kind).toBe('answered')
    if (result.kind !== 'answered') {
      throw new Error(`expected "answered", got "${result.kind}"`)
    }
    expect(model.calls).toHaveLength(1)
    // The instructions the model was asked with are the ones the instructor
    // typed into the panel, not merely *some* non-null value — proves the
    // saved course's own configuration reached `handleMention`, not a
    // default (finding 1 of the WEB-7 rework).
    expect(model.calls[0]?.instructions).toBe(courseInstructions)
    expect(reply.sent).toEqual(['The midterm is on the 14th.'])

    // Both directions are in the transcript (CONV-2).
    const transcript = conversations.getTranscript(
      organizationId,
      result.conversationId,
      db
    )
    expect(transcript.map((message) => message.direction)).toEqual([
      'from_person',
      'to_person',
    ])
    expect(transcript[0]?.content).toContain('When is the midterm?')
    expect(transcript[1]?.content).toBe('The midterm is on the 14th.')
  } finally {
    closeDatabase(db)
  }
})

/**
 * WEB-35, end to end: the course editor's five settings tabs are real
 * addresses — a click changes the address bar, a reload holds the tab, and
 * an edit made on one tab is not lost switching to (and saving from)
 * another. `e2e/routing.spec.ts` already covers the course editor's own
 * address round trip (WEB-32/WEB-34); this is the tab-specific slice of
 * that same guarantee.
 */
test("a course's settings tabs are real addresses — switching, reloading and saving from another tab (WEB-35)", async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web35-${suffix}@example.edu`

  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  // A course seeded directly against the database — this test is about the
  // tabs, not re-driving the create-course UI a second time (QA-8's own
  // test, above, already covers that).
  const db = openDatabase(E2E_DATABASE_PATH)
  let organizationId: string
  let projectId: string
  let courseId: string
  try {
    const account = accounts.getAccountByEmail(email, db)
    if (!account) throw new Error('setup failed: account not found')
    const [membership] = memberships.listMembershipsForAccount(account.id, db)
    if (!membership) throw new Error('setup failed: membership not found')
    organizationId = membership.organizationId
    const project = projects.createProject(
      organizationId,
      { name: `Fall 2026 — ${suffix}` },
      db
    )
    projectId = project.id
    const created = courses.createCourse(
      organizationId,
      {
        projectId: project.id,
        title: `Web Design — ${suffix}`,
        enabled: true,
        adminsRole: `admins-${suffix}`,
        studentsRole: `students-${suffix}`,
        promptId: 'prompt-1',
        categories: [],
      },
      db
    )
    if (!created.ok) throw new Error('setup failed: course creation refused')
    courseId = created.course.id
  } finally {
    closeDatabase(db)
  }

  // A bare course address (no tab segment) lands on General.
  await page.goto(
    `/o/${organizationId}/projects/${projectId}/courses/${courseId}`
  )
  await expect(page.getByRole('tab', { name: 'General' })).toHaveAttribute(
    'aria-selected',
    'true'
  )

  // Switching to AI changes the address itself — a tab is a real address,
  // not only local component state.
  await page.getByRole('tab', { name: 'AI' }).click()
  await expect(page).toHaveURL(
    `/o/${organizationId}/projects/${projectId}/courses/${courseId}/ai`
  )
  await expect(page.getByRole('tab', { name: 'AI' })).toHaveAttribute(
    'aria-selected',
    'true'
  )

  // A reload holds the tab — still AI, not bounced back to General. Done
  // with nothing unsaved in the form, so this is purely about the address,
  // not about surviving a reload's own full remount (which — a real
  // browser reload, unlike an in-panel tab switch — legitimately does
  // discard whatever was not yet saved).
  await page.reload()
  await expect(page).toHaveURL(
    `/o/${organizationId}/projects/${projectId}/courses/${courseId}/ai`
  )
  await expect(page.getByRole('tab', { name: 'AI' })).toHaveAttribute(
    'aria-selected',
    'true'
  )

  // Edit Title on General, then try to leave the tab: with something
  // unsaved, a tab switch asks first — save it, discard it, or stay put.
  const editedTitle = `Web Design — ${suffix} (edited)`
  await page.getByRole('tab', { name: 'General' }).click()
  await page.getByLabel('Title').fill(editedTitle)
  await page.getByRole('tab', { name: 'Roster' }).click()

  // "Cancel" keeps both the tab and the edit — nothing moved, nothing was
  // sent.
  await expect(
    page.getByRole('dialog', { name: 'Save your changes?' })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('tab', { name: 'General' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(page.getByLabel('Title')).toHaveValue(editedTitle)

  // "Save changes" writes it through `courses.save` and then goes where
  // the click was headed — the saved title is what the heading reads.
  await page.getByRole('tab', { name: 'Roster' }).click()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(
    page.getByRole('heading', { name: editedTitle, level: 1 })
  ).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Roster' })).toHaveAttribute(
    'aria-selected',
    'true'
  )

  // The form is clean again, so moving between tabs asks nothing at all,
  // and the saved edit is still on General.
  await page.getByRole('tab', { name: 'General' }).click()
  await expect(
    page.getByRole('dialog', { name: 'Save your changes?' })
  ).toBeHidden()
  await expect(page.getByLabel('Title')).toHaveValue(editedTitle)

  // "Discard changes" throws the edit away and goes anyway — the field is
  // back to what was last saved.
  await page.getByLabel('Title').fill(`${editedTitle} (abandoned)`)
  await page.getByRole('tab', { name: 'Roster' }).click()
  await page.getByRole('button', { name: 'Discard changes' }).click()
  await expect(page.getByRole('tab', { name: 'Roster' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await page.getByRole('tab', { name: 'General' }).click()
  await expect(page.getByLabel('Title')).toHaveValue(editedTitle)

  // Where focus lands once the dialog closes. `goToTab` focuses the newly
  // selected tab, but `Modal`'s own `dialog.close()` runs afterwards and
  // the browser's restoration hands focus back to whatever *opened* the
  // dialog. Round 2, finding 3: asserting this after a mouse click proves
  // nothing, because the clicked tab is both the opener and the
  // destination, so either mechanism satisfies it — the reviewer deleted
  // `goToTab`'s own `.focus()`, rebuilt the bundle and watched that
  // version still pass.
  //
  // The keyboard path is the one where the two differ: arrow keys move
  // selection to the *next* tab while focus (and so the dialog's opener)
  // is still on the current one. jsdom's `<dialog>` polyfill cannot see
  // any of this, so a real browser is the only place it can be checked.
  await page.getByLabel('Title').fill(`${editedTitle} (abandoned again)`)
  await page.getByRole('tab', { name: 'General' }).focus()
  await page.keyboard.press('ArrowRight')
  await page.getByRole('button', { name: 'Discard changes' }).click()
  await expect(page.getByRole('tab', { name: 'AI' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  // Fails if `goToTab` stops moving focus itself: restoration would put it
  // back on General, the tab that opened the dialog and is no longer
  // selected — leaving the next Left/Right to move from somewhere the
  // reader is not.
  await expect(page.getByRole('tab', { name: 'AI' })).toBeFocused()
})

/**
 * WEB-40: the channel row's name input, "Admins only" checkbox and remove
 * button used to wrap onto three lines because `textInputClasses`'s own
 * `w-full` let the name input claim the whole row — no unit test can see
 * this (`apps/web/tests/course-editor.test.tsx`'s own comment on why:
 * jsdom has no layout engine, so the DOM shape is identical whether the
 * row wraps or not). A real bounding box, at more than one width, is the
 * only way to prove the fix rather than merely describe it.
 */
test("a channel row's name input, checkbox and remove button stay on one line, at a wide viewport and a narrow one (WEB-40)", async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const email = `web40-${suffix}@example.edu`

  await signIn(page, email)
  await expect(page.getByTestId('organization-switcher')).toBeVisible()

  await navigateTo(page, 'Projects')
  await page.getByRole('button', { name: 'New project' }).click()
  const newProjectDialog = page.getByRole('dialog', { name: 'New project' })
  await newProjectDialog
    .getByLabel('Project name')
    .fill(`Fall 2026 — ${suffix}`)
  await newProjectDialog.getByRole('button', { name: 'Create' }).click()
  await page
    .getByRole('button', { name: `Fall 2026 — ${suffix}`, exact: true })
    .click()

  await page.getByRole('button', { name: 'New course' }).click()
  await page.getByLabel('Title').fill(`Web Design — ${suffix}`)
  await page.getByLabel('Admins role').fill(`admins-wd-${suffix}`)
  await page.getByLabel('Students role').fill(`students-wd-${suffix}`)
  await page.getByRole('button', { name: 'Add category' }).click()
  await page.getByLabel('Category name').fill(`Web Design - GLOBAL - ${suffix}`)
  await page.getByRole('button', { name: 'Add channel' }).click()
  await page.getByLabel('Channel name').fill('announcements')

  const channelRow = page.getByLabel('Channel name').locator('xpath=..')

  // A wide viewport first — the row's own natural width, well above the
  // panel's own narrowest breakpoint.
  await page.setViewportSize({ width: 1200, height: 800 })
  const wideBox = await channelRow.boundingBox()
  if (!wideBox) throw new Error('expected the channel row to have a layout box')
  // One line of text plus its own padding is nowhere near the ~82px three
  // stacked controls used to take — 60px is comfortably below that and
  // comfortably above one real line.
  expect(wideBox.height).toBeLessThan(60)

  // A narrow viewport — `flex-wrap` stays on the row, so if this ever
  // needs to wrap again at some width, it still can; the row must still
  // fit rather than overflowing horizontally.
  await page.setViewportSize({ width: 320, height: 800 })
  const narrowOverflows = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: Document }).document
    return doc.documentElement.scrollWidth > doc.documentElement.clientWidth
  })
  expect(narrowOverflows).toBe(false)
})
