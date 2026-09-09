/**
 * WEB-39/PORT-4..PORT-7: the dialog a project's **Import** menu item opens —
 * one large drop zone that takes a course export file, and, once the import
 * has run, the report of what actually arrived.
 *
 * This renders `<Modal>` directly rather than going through
 * `ModalProvider`'s `confirm()`/`prompt()`. That API answers one question and
 * resolves; this dialog holds state across several steps (a file chosen, an
 * import in flight, a report to read, a refusal to correct and retry) and has
 * a middle that is a control rather than a sentence. It is still the same
 * `<Modal>` component every other dialog in this app uses — the thing
 * `ModalProvider`'s own module comment forbids is a *second `<dialog>`
 * implementation*, which this is not.
 *
 * Two things the screen says before the import runs, rather than after
 * (WEB-39): which project the course is going into, and that an imported
 * course arrives disabled (PORT-6). An instructor who learns the second of
 * those only from the result has already been surprised.
 */

import { useState, type ReactElement } from 'react'

import { ApiError, importCourse } from '../api/client.js'
import type { ImportCourseResult, Project } from '../api/types.js'
import { ErrorMessage } from './ErrorMessage.js'
import { FileDropZone } from './FileDropZone.js'
import { fileToText } from './file-text.js'
import { Modal } from './modal/Modal.js'

/**
 * A course export is a small YAML document — a title, some role names,
 * categories and instructions. A megabyte is far more than one has ever
 * needed and still small enough that a mis-dropped video is refused here,
 * in the dialog, rather than sent and refused by the API.
 */
const MAX_IMPORT_BYTES = 1024 * 1024

export interface CourseImportDialogProps {
  open: boolean
  organizationId: string
  project: Project
  /** Closes the dialog — the caller owns `open`, so this is the only way out. */
  onClose: () => void
  /** Called once an import has succeeded, so the caller can refresh whatever list is showing. */
  onImported: (result: ImportCourseResult) => void
}

/**
 * PORT-7's report, as sentences: the title the course was given, and each
 * thing the file said it could not bring. Written as separate lines rather
 * than one paragraph because they are separate pieces of follow-up work — a
 * missing vector store and a missing Discord server are fixed in different
 * places.
 */
function reportLines(result: ImportCourseResult): string[] {
  const lines: string[] = []
  if (result.titleChanged) {
    lines.push(
      `A course of that name was already here, so it was imported as "${result.title}".`
    )
  }
  const { notCarried } = result
  if (notCarried.attachments > 0) {
    lines.push(
      notCarried.attachments === 1
        ? 'Its knowledge file did not travel with the file — attach it again.'
        : `Its ${notCarried.attachments} knowledge files did not travel with the file — attach them again.`
    )
  }
  if (notCarried.vectorStore) {
    lines.push(
      'It answered from a knowledge base belonging to the organization it came from, which this course does not have.'
    )
  }
  if (notCarried.storedPrompt) {
    lines.push(
      'It used a stored prompt, which does not travel between organizations.'
    )
  }
  if (notCarried.discordServer) {
    lines.push(
      'It named a Discord server, which this organization does not have — choose one before enabling it.'
    )
  }
  return lines
}

export function CourseImportDialog({
  open,
  organizationId,
  project,
  onClose,
  onImported,
}: CourseImportDialogProps): ReactElement {
  const [file, setFile] = useState<File | undefined>(undefined)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [result, setResult] = useState<ImportCourseResult | undefined>(
    undefined
  )

  /** Back to an empty dialog, so reopening it never shows the last import's report. */
  const reset = (): void => {
    setFile(undefined)
    setImporting(false)
    setError(undefined)
    setResult(undefined)
  }

  const close = (): void => {
    reset()
    onClose()
  }

  const runImport = async (): Promise<void> => {
    if (!file) return
    setError(undefined)
    setImporting(true)
    try {
      // The action takes the file's text itself (PORT-8 — an import is an
      // action, not an upload route); `fileToText` is the shared reader the
      // roster import already uses.
      const content = await fileToText(file)
      const imported = await importCourse(organizationId, project.id, content)
      setResult(imported)
      onImported(imported)
    } catch (caught) {
      // A refused file (PORT-7) leaves the dialog open with the reason, so
      // the next drop replaces it rather than starting the flow again.
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setImporting(false)
    }
  }

  const body = result ? (
    <div className="flex flex-col gap-2" data-testid="course-import-report">
      <p className="text-sm text-neutral-800">
        Imported <strong>{result.title}</strong> into &ldquo;{project.name}
        &rdquo;, disabled.
      </p>
      {reportLines(result).length > 0 && (
        <ul className="list-disc pl-5 text-sm text-neutral-600">
          {reportLines(result).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  ) : (
    <>
      <FileDropZone
        label="Course export file"
        help="A .yml file exported from a course. Its settings, roles, categories, channels and websites travel; students, transcripts and knowledge files do not."
        accept=".yml,.yaml,application/yaml,text/yaml"
        maxBytes={MAX_IMPORT_BYTES}
        {...(file ? { selectedFile: file } : {})}
        onFileChosen={(chosen) => {
          setError(undefined)
          setFile(chosen)
        }}
        disabled={importing}
      />
      {error && <ErrorMessage error={error} />}
    </>
  )

  return (
    <Modal
      open={open}
      kind={result ? 'alert' : 'confirm'}
      title={
        result ? 'Course imported' : `Import a course into "${project.name}"`
      }
      {...(result
        ? {}
        : {
            // `exactOptionalPropertyTypes` — an absent optional is spread in
            // rather than passed as an explicit `undefined`.
            description:
              'The course arrives disabled, so it cannot collide with a course already routing. Enable it once you have checked its roles and categories.',
          })}
      body={body}
      confirmLabel={result ? 'Done' : importing ? 'Importing…' : 'Import'}
      cancelLabel="Cancel"
      confirmDisabled={!result && (!file || importing)}
      onConfirm={() => {
        if (result) close()
        else void runImport()
      }}
      onCancel={close}
    />
  )
}
