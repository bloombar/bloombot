/**
 * WEB-12: one icon set (Lucide React), and one icon per recurring intent —
 * every place this panel means "edit," "delete," "add," or any of the
 * others named below, it reaches for the same import from this file rather
 * than picking a Lucide icon ad hoc at the call site. That is the whole
 * point of naming them here at all: two components editing the same kind
 * of thing with two different pencils is exactly the drift WEB-11's own
 * module comment describes for a second styling system, one icon at a
 * time.
 *
 * Every icon this panel uses is re-exported under an intent name, not
 * Lucide's own component name — `Edit` rather than `Pencil` — so a call
 * site reads "edit" and a future change of *which* icon means "edit" is
 * one line here, not a search-and-replace across every page.
 *
 * WEB-12 also requires an icon never carry meaning alone: every place one
 * of these is used with no visible text label, the call site supplies an
 * `aria-label` (or `aria-hidden` on the icon itself, with a labelled
 * sibling) — this file only names *which* icon a screen reader would
 * otherwise have nothing to say about, not the label text, which is the
 * call site's own job because only it knows what the control does.
 */

import {
  AlertCircle,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Ban,
  CheckCircle2,
  ChevronDown,
  Clock,
  Copy,
  ExternalLink,
  Hammer,
  Home,
  Info,
  Loader2,
  LogOut,
  Menu,
  MessageSquare,
  Pencil,
  Plus,
  Power,
  Send,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'

/** Open the navigation drawer on a narrow screen (WEB-13/WEB-14). */
export const MenuIcon = Menu
/** Return to the panel's own landing screen — sits beside the menu control in the fixed header (WEB-14). */
export const HomeIcon = Home
/** Dismiss a dialog, a drawer, or clear a value. */
export const CloseIcon = X
/** Sign out of the account. */
export const SignOutIcon = LogOut

/** Edit an existing record (a course, a category, a channel name). */
export const EditIcon = Pencil
/** Create a new record (a project, a category, a channel, a join link). */
export const AddIcon = Plus
/** Permanently remove a record — always paired with a confirmation (WEB-15). */
export const DeleteIcon = Trash2
/** Remove one item from a list without deleting the record it names (e.g. a channel from a category being edited, before saving). */
export const RemoveFromListIcon = X
/** Turn a course, a membership or a binding off. */
export const DisableIcon = Ban
/** Turn a course, a membership or a binding on. */
export const EnableIcon = Power
/** Duplicate a project (PROJ-4). */
export const DuplicateIcon = Copy
/** Archive a project. */
export const ArchiveIcon = Archive
/** Restore an archived project. */
export const RestoreIcon = ArchiveRestore
/** Run the scaffold job for a course's Discord categories and channels (SRV-6). */
export const ScaffoldIcon = Hammer
/** Leave this panel for another site (Discord's own consent screen, a footer link). */
export const ExternalLinkIcon = ExternalLink
/** A collapsible section, or a select control, is closed and can be opened. */
export const ExpandIcon = ChevronDown

/** The chat surface itself (WEB-10) — a course's assistant. */
export const ChatIcon = MessageSquare
/** Send a chat message. */
export const SendIcon = Send

/** A refusal or a validation failure (WEB-16), rendered next to the message it belongs to. */
export const ErrorIcon = AlertCircle
/** A warning that falls short of a refusal — a job still queued, a course not yet enabled. */
export const WarningIcon = AlertTriangle
/** A plain, neutral notice — the duplicate-project notice, a status update. */
export const InfoIcon = Info
/** Something succeeded — a save, an enrolment, a completed job. */
export const SuccessIcon = CheckCircle2
/** Something failed outright — a failed job, a failed save shown inline next to a retry. */
export const FailureIcon = XCircle
/** A job is still queued or running — paired with `Loader2`'s own spin animation where the state is actively in progress. */
export const PendingIcon = Clock
/** A background operation is in progress right now (spins via the `animate-spin` utility at the call site). */
export const SpinnerIcon = Loader2
