/**
 * A browser `File`'s text, via `FileReader#readAsText`.
 *
 * `FileReader` rather than `Blob#text()`: the latter is not available in
 * every environment this bundle runs or is tested in (jsdom's own `File` has
 * no `text()` at all), and a file-reading path that works in the browser but
 * throws in every component test is a path nothing can cover.
 * `CourseAttachments.tsx`'s own `fileToBase64` uses the same device for the
 * same reason, reading a data URL instead of text.
 *
 * Shared by every caller that uploads a text file — a roster CSV (WEB-21)
 * and a course export (WEB-39) — rather than reimplemented per component.
 */
export function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('FileReader did not return text'))
        return
      }
      resolve(result)
    }
    reader.onerror = () =>
      reject(reader.error ?? new Error('could not read the selected file'))
    reader.readAsText(file)
  })
}
