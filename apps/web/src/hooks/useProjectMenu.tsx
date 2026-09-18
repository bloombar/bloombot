/**
 * WEB-61: the row-level project menu — Archive/Restore, Duplicate, Import,
 * Rename, Delete — factored out of `pages/Projects.tsx` (its own original
 * home) so `pages/Courses.tsx` (the project's own screen,
 * `/o/:organizationId/projects/:projectId`) can offer the identical menu,
 * with the identical confirmations, rather than a second copy of Delete's
 * typed-name confirmation drifting away from the first. Every message,
 * label and icon below is unchanged from `Projects.tsx`'s own former
 * inline handlers — `tests/projects.test.tsx` still pins them, unmoved.
 *
 * A hook, not a component (unlike `components/CourseRows.tsx`, which *is*
 * one): `pages/Projects.tsx` calls this once, at its own top level, and
 * builds each row's own `KebabMenuItem[]` by calling `itemsFor(project)` —
 * legal only because the hook itself is called once per render, not once
 * per row inside a `.map()` (which would call a hook from a callback,
 * rather than from the component's own top level, and break the rules of
 * hooks). `pages/Courses.tsx` calls it the same way, for the one project
 * its own screen names.
 *
 * `onChanged`/`onDeleted` split the same way `pages/Projects.tsx`'s own
 * `refresh()` used to double as both: `onDeleted` fires only once Delete
 * actually succeeds, since the project is gone and a caller whose own
 * screen names it (`pages/Courses.tsx`) has to navigate elsewhere rather
 * than refetch a project that no longer exists — `pages/Projects.tsx`'s own
 * list can treat the two identically (a deleted row is just one more row a
 * relist no longer returns). `onChanged` is handed the best available
 * picture of the project after Archive/Restore/Rename — `projects.archive`
 * returns only `{ archived: boolean }` (`api/client.ts`), so that one case
 * is reconstructed from the project already in hand rather than a field the
 * action never returns; Duplicate and Import both leave *this* project
 * untouched (Duplicate creates a second one, Import adds a course to this
 * one) and so never call it at all — only their own notice, below, says
 * anything happened.
 */

import { type ReactNode, useState } from 'react'

import {
  archiveProject,
  deleteProject,
  duplicateProject,
  previewDeleteProject,
  renameProject,
  unarchiveProject,
} from '../api/client.js'
import { ApiError } from '../api/client.js'
import type { ImportCourseResult, Project } from '../api/types.js'
import { CourseImportDialog } from '../components/CourseImportDialog.js'
import type { KebabMenuItem } from '../components/KebabMenu.js'
import { useModal } from '../components/modal/ModalProvider.js'
import {
  ArchiveIcon,
  DeleteIcon,
  DuplicateIcon,
  EditIcon,
  ImportIcon,
  RestoreIcon,
} from '../icons.js'

/** A blank or whitespace-only name is refused the same way everywhere a project name is typed (finding 7 of the WEB-7 rework) — shared here since both `Projects.tsx`'s own "New project" prompt and this hook's Rename/Duplicate prompts need it. */
export function requireName(value: string): string | undefined {
  return value.trim().length === 0 ? 'Enter a project name.' : undefined
}

/**
 * D-23's reasoning, said in one sentence a person can act on: a duplicate's
 * courses carry the same category and role names as their originals — the
 * exact collision PROJ-3 forbids among enabled courses — so every one of
 * them is created disabled, and stays that way until an instructor confirms
 * (or edits) those names and enables it.
 */
function duplicateDisabledMessage(
  newProjectName: string,
  coursesCopied: number
): string {
  if (coursesCopied === 0) {
    return `Copied "${newProjectName}" — it had no courses to bring with it.`
  }
  const plural = coursesCopied === 1 ? 'course' : 'courses'
  return (
    `Copied ${coursesCopied} ${plural} into "${newProjectName}", every one disabled: ` +
    `a copy shares its original's category and role names, so enabling one immediately ` +
    `would collide with the course it was copied from. Confirm or edit those names, then enable each.`
  )
}

export interface UseProjectMenuResult {
  /** WEB-26/WEB-61 — this project's own kebab items, in the one order every caller shows them: Archive/Restore, Duplicate, Import, Rename, Delete. */
  itemsFor: (project: Project) => KebabMenuItem[]
  /** The one project a mutation is currently in flight for, if any — the same single-slot `busyProjectId` `pages/Projects.tsx` kept before this extraction (only one row is ever busy at a time). */
  busyProjectId: string | undefined
  error: ApiError | undefined
  duplicateNotice: string | undefined
  /** `CourseImportDialog`, open for whichever project's own Import item was chosen, or `null` — render this once, anywhere in the caller's own tree (it is a modal; position does not matter). */
  importDialog: ReactNode
}

export function useProjectMenu(
  organizationId: string,
  onChanged: (project: Project) => void,
  onDeleted: () => void
): UseProjectMenuResult {
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [duplicateNotice, setDuplicateNotice] = useState<string | undefined>(
    undefined
  )
  const [busyProjectId, setBusyProjectId] = useState<string | undefined>(
    undefined
  )
  // WEB-39 — which project's Import dialog is open, or none. The project
  // itself rather than its id, since the dialog names it on screen.
  const [importingInto, setImportingInto] = useState<Project | undefined>(
    undefined
  )
  const { prompt, confirm } = useModal()

  const handleArchive = async (project: Project) => {
    // WEB-15 — archiving and deleting must never look alike (PROJ-2:
    // archiving is reversible, Restore is right there), so this confirms
    // through the *non-destructive* path — a plain, primary-styled
    // confirm, not the danger-red one `destructive: true` renders — while
    // still confirming at all, because archiving a whole term stops every
    // course inside it routing. Restoring undoes exactly this, so it never
    // needs to ask first.
    if (project.archivedAt === null) {
      const confirmed = await confirm({
        title: `Archive ${project.name}?`,
        description: 'Its courses stop routing. You can restore it.',
        confirmLabel: 'Archive',
      })
      if (!confirmed) return
    }
    setError(undefined)
    setBusyProjectId(project.id)
    try {
      if (project.archivedAt === null) {
        await archiveProject(organizationId, project.id)
        // `projects.archive` returns only `{ archived: boolean }` (unlike
        // `unarchive`/`rename`, below) — this hook's own module comment on
        // why `onChanged` is handed a reconstructed project rather than one
        // the action actually returned.
        onChanged({ ...project, archivedAt: Date.now() })
      } else {
        const restored = await unarchiveProject(organizationId, project.id)
        onChanged(restored)
      }
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setBusyProjectId(undefined)
    }
  }

  // PROJ-6/WEB-26: rename, over the `projects.rename` action — a refusal
  // (the name collides with another active project) surfaces the same way
  // every other refusal here does, through `error`, naming the colliding
  // project.
  const handleRename = async (project: Project) => {
    const name = await prompt({
      title: `Rename "${project.name}"`,
      label: 'Project name',
      initialValue: project.name,
      confirmLabel: 'Rename',
      validate: requireName,
    })
    if (name === undefined) return
    setError(undefined)
    setBusyProjectId(project.id)
    try {
      const renamed = await renameProject(
        organizationId,
        project.id,
        name.trim()
      )
      onChanged(renamed)
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setBusyProjectId(undefined)
    }
  }

  const handleDuplicate = async (project: Project) => {
    const name = await prompt({
      title: `Duplicate "${project.name}"`,
      label: 'New project name',
      placeholder: 'new project name',
      confirmLabel: 'Duplicate',
      validate: requireName,
    })
    if (name === undefined) return
    setError(undefined)
    setDuplicateNotice(undefined)
    setBusyProjectId(project.id)
    try {
      const result = await duplicateProject(
        organizationId,
        project.id,
        name.trim()
      )
      // Duplicate leaves *this* project untouched — a second, new project
      // is what actually changed, and nothing here names its list to
      // refresh, so `onChanged` is not called; the notice alone says what
      // happened.
      setDuplicateNotice(
        duplicateDisabledMessage(result.project.name, result.coursesCopied)
      )
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setBusyProjectId(undefined)
    }
  }

  /**
   * PROJ-9/WEB-50: preview, then confirm by typing the project's own name,
   * then permanently delete — the same shape `pages/Admin.tsx#handleDelete`
   * already gives ADMIN-5's own tenant deletion, and the same one
   * `components/CourseRows.tsx#handleDelete` gives one course at a time.
   * `onDeleted()` — not `onChanged` — is the caller's cue: the project is
   * gone, not merely different.
   */
  const handleDelete = async (project: Project) => {
    setError(undefined)
    let preview
    try {
      preview = await previewDeleteProject(organizationId, project.id)
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
      return
    }

    const typed = await prompt({
      title: `Delete ${project.name}?`,
      description:
        `This permanently deletes ${preview.courses} course(s), ` +
        `${preview.conversations} conversation(s), ${preview.messages} message(s), ` +
        `${preview.enrolments} enrolment(s) and ${preview.courseAttachments} ` +
        'knowledge file(s). Spending already recorded survives. Discord channels ' +
        'and roles are not touched. This cannot be undone. Type the project’s ' +
        'name to confirm.',
      label: 'Project name',
      placeholder: project.name,
      confirmLabel: 'Delete',
      destructive: true,
      validate: (value) =>
        value === project.name
          ? undefined
          : 'Type the name exactly to confirm.',
    })
    if (typed === undefined) return

    setBusyProjectId(project.id)
    try {
      await deleteProject(organizationId, project.id)
      onDeleted()
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setBusyProjectId(undefined)
    }
  }

  const itemsFor = (project: Project): KebabMenuItem[] => [
    {
      key: 'archive',
      label: project.archivedAt === null ? 'Archive' : 'Restore',
      icon:
        project.archivedAt === null ? (
          <ArchiveIcon aria-hidden="true" className="size-4" />
        ) : (
          <RestoreIcon aria-hidden="true" className="size-4" />
        ),
      onSelect: () => void handleArchive(project),
    },
    {
      key: 'duplicate',
      label: 'Duplicate',
      icon: <DuplicateIcon aria-hidden="true" className="size-4" />,
      onSelect: () => void handleDuplicate(project),
    },
    {
      key: 'import',
      label: 'Import',
      icon: <ImportIcon aria-hidden="true" className="size-4" />,
      onSelect: () => setImportingInto(project),
    },
    {
      key: 'rename',
      label: 'Rename',
      icon: <EditIcon aria-hidden="true" className="size-4" />,
      onSelect: () => void handleRename(project),
    },
    // PROJ-9/WEB-50 — Delete, last, styled destructive: the row's most
    // severe action sits at the end of the menu.
    {
      key: 'delete',
      label: 'Delete',
      icon: <DeleteIcon aria-hidden="true" className="size-4" />,
      destructive: true,
      onSelect: () => void handleDelete(project),
    },
  ]

  const importDialog = importingInto && (
    <CourseImportDialog
      open={true}
      organizationId={organizationId}
      project={importingInto}
      onClose={() => setImportingInto(undefined)}
      // A course imported into a project a caller's own list does not
      // itself show the courses of still deserves a line saying it
      // happened — the same notice slot Duplicate above writes into,
      // rather than a second one grown beside it.
      onImported={(result: ImportCourseResult) =>
        setDuplicateNotice(
          `Imported "${result.title}" into "${importingInto.name}", disabled — open the project to enable it.`
        )
      }
    />
  )

  return { itemsFor, busyProjectId, error, duplicateNotice, importDialog }
}
