# Usage Report Plan — Bloombot, Fall 2026 and the Preceding Year

A plan for turning the interaction log into a short, honest, general-audience presentation of how
students actually used the bot: what they asked about, how often they came back, and how long a
visit lasted. Written for whoever builds the deck and the analysis behind it.

The dataset is small. That is a constraint on claims, not a reason to skip the work — the plan below
says what the data can support, what has to be labelled as an impression rather than a finding, and
how to present both without overselling.

## 0. What Bloombot is — the opening slides

A general audience needs to know what they are looking at before any number means anything. This is
four or five slides, five minutes, no charts. The content below is the substance each slide carries;
the deck phrases it in the presenter's own words.

### Slide A — An AI course assistant, in the places students already are

Bloombot answers students' questions about a specific course — its schedule, its assignments, its
setup instructions, its policies — in the student's own words, at whatever hour they ask. It is not a
general chatbot: every answer is grounded in the instructor's own course material, and it knows which
course the student is asking about.

Students reach it three ways:

- **In Discord**, where the course already lives — in a shared channel or in the student's own private
  channel, by mentioning the bot.
- **On the web**, through a course chat page they sign into with an emailed link. New this fall.
- **Through a chat assistant** (Claude, or any MCP-capable client) connected to their course, so a
  student already working in an AI assistant can ask the course bot without leaving it. Also new this
  fall.

All three reach the same assistant, with the same course instructions and the same memory of what
that student has asked before.

### Slide B — How it answers

The model is commercially hosted — currently OpenAI's `gpt-4.1`, configurable per course, with a
cheaper model (`gpt-4o-mini`) used only for the offline topic classification behind this report. We
train nothing and fine-tune nothing; the intelligence is rented, and the course-specific part is the
instructions and materials the instructor supplies.

Three points worth making explicitly, because audiences ask:

- **Conversation memory is per student, per course.** The assistant keeps one running conversation
  for each student in each course and each interface. A follow-up question arrives with the student's
  whole prior history in that course already in context — the hosted conversation is carried by id
  rather than re-sent by us, so context is not truncated to a handful of recent turns, and it
  survives restarts and days between visits. (The original Python bot held this in memory only, so a
  restart wiped it; that changed this fall.)
- **Every message, in both directions, is logged** to the instructor's own database. That is what
  makes this report possible, and it is also what an instructor is relying on when they read a
  transcript.
- **There is a daily per-student request cap** and a per-course spending cap, so a runaway loop or an
  enthusiastic student cannot run up an unbounded bill.

### Slide C — How it knows who is asking, and which course they are in

This is the part that makes it a *course* assistant rather than a chatbot, and it is worth a slide
because the three answers carry different privacy implications.

- **By Discord category.** A message in a course's category is a question about that course. This is
  the original mechanism and still the most-used one.
- **By Discord role.** A role on the server marks a member as enrolled in a course, which is what
  grants access to that course's assistant.
- **By roster import.** A CSV of enrolled students (name, email, GitHub, Discord handle) can be
  imported to create the enrolment directly. **We have deliberately not used roster import for our
  own university courses**, because a roster is an education record and handing it to a
  third-party-hosted system raises FERPA questions we chose not to answer by acting first. Students
  arrive by joining the Discord server or by following a join link instead, which keeps the
  institutional roster out of the system. The capability exists for instructors whose institutions
  have cleared it.

Say the FERPA point plainly. It is the question the audience is already forming, and answering it
before it is asked is worth more than any chart in the deck.

### Slide D — Other instructors can run their own courses on it

Bloombot is multi-tenant: another instructor can create an account, set up their own organization and
courses, connect their own Discord server, and run their own assistant, with their own data kept
separate from everyone else's. Sign-up is by emailed link, with no password to manage.

Account creation is **gated on my approval** — deliberately. Each tenant's usage spends real money
against a hosted model, and each new tenant brings student data into the system, so admission is a
decision rather than a signup form. Approvals are recorded in the system.

### Slide E — How it was built

- **One developer. No funding.** No grant, no team, no institutional project.
- **Built by hand first, in Python** — a Discord bot with a SQLite message log and an analytics
  notebook, run across four courses over the past academic year. That version is where most of the
  historical data in this report comes from.
- **Rebuilt and substantially extended for Fall 2026 with Claude Code**, ported to a TypeScript /
  JavaScript stack: the web interface, the chat-assistant (MCP) interface, accounts and sign-in,
  multi-tenancy, per-course instructions and attachments, cost tracking, data retention and deletion,
  and an administration CLI. The Discord bot's behaviour was preserved and its history imported, so
  the year of prior conversations and this fall's sit in one database.
- Worth one sentence on what that says about the cost of building this kind of tool now, since it is
  the most transferable thing in the talk.

## 1. What we actually collect

Everything below already exists in `data/data.db` (schema: `packages/db/src/schema.ts`). Nothing new
needs to be instrumented for this report.

| Source | Columns that matter here |
| --- | --- |
| `messages` | `created_at`, `direction` (`from_person` / `to_person`), `content`, `surface` (`discord` / `web` / `mcp`), `channel_ref`, `category_ref`, `person_id`, `course_id`, `conversation_id`, `sequence` |
| `conversations` | `created_at`, `last_message_at`, `surface`, `person_id`, `course_id`, `deleted_at` |
| `people` / `enrolments` | who is in a course, so volume can be expressed per enrolled student rather than in raw counts |
| `courses` | course name, used for the cross-course comparison |
| `usage_counters` | per-person, per-course, per-day request counts — a cheap independent check on the daily-activity numbers, and the only place the daily cap is visible |
| `cost_ledger_entries` | `model`, `input_tokens`, `output_tokens`, `cost_micros`, `surface`, `created_at` — cost per session and per student, only for the period the ledger covers |
| `data/topic_classifications.json` | cached topic labels for conversations already classified by `analytics.ipynb` |

Three things we do **not** have, and must not imply we have:

- **No outcome data.** Nothing links a conversation to a grade, a submission, or whether the answer
  helped. Every "value" claim in the deck is inference, not measurement.
- **No read receipts or non-use.** A student who never messaged the bot is invisible except through
  the enrolment roster, which is why "share of enrolled students who used it" is worth computing.
- **Uneven surface coverage.** Discord runs back a year; web and the chat assistant only start this
  fall. Any year-over-year line that mixes them is measuring our own feature launch, not student
  behaviour.

### A note on the old data

The Discord history imported through `packages/legacy-import` lands with `surface = 'discord'` and its
original category and channel strings intact, so one query spans the whole period. `analytics.ipynb`
still reads the *pre-migration* column names (`m.category`, `m.channel`, `users.discord_username`,
direction `from`/`to`). Porting it to the current schema is the first work item — everything else in
this plan depends on it.

## 2. Definitions to fix before any number is produced

Put these on a slide. A general audience will accept an arbitrary threshold; it will not forgive an
undisclosed one.

- **Session.** Consecutive messages between one person and the bot in one course, split whenever
  there is a gap of more than **30 minutes** of silence. This is the threshold `analytics.ipynb`
  already uses (`GAP_MINUTES = 30`) and it matches the common web-analytics convention. Group by
  person + course + surface, *not* by the `conversations` row: on web a conversation row is
  long-lived and holds months of chat, so it is not a session.
  - Test the threshold at 15, 30 and 60 minutes. If the headline numbers barely move, say so in one
    line — that is a robustness claim the audience can check.
- **Prompt.** One `from_person` message. Report prompts per session, not total messages, so the
  bot's own replies do not double the count.
- **Active student.** A person with at least one `from_person` message in the period.
- **Period.** "This fall" = the current term's start date through the report date. "Last year" = the
  same span in the preceding academic year, so the comparison is term-to-term rather than a full year
  against a partial one.
- **Exclusions.** Instructor and test accounts, and any conversation with `deleted_at` set (a student
  asked for it to be removed; it stays out of the aggregate). State the exclusion count on the
  methodology slide.

## 3. The measures worth presenting

Grouped by the question each answers. Each is one chart or one number, not both.

**How much was it used?**
1. Sessions and prompts per term, split by surface (Discord / web / chat assistant).
2. Weekly sessions over the whole period, one line per course — the shape (spikes at deadlines,
   decay after week 3) is the most legible thing in the dataset.
3. Share of enrolled students who used the bot at least once, per course. This is the adoption
   number, and it is more honest than raw volume when n is small.

**How did a typical visit go?**
4. Distribution of prompts per session, as a histogram plus the median and the interquartile range.
   Lead with the median; means are hostage to one long session in a dataset this size.
5. Session duration in minutes, same treatment.
6. Return rate: of students who used it once, how many came back on a different day. A simple
   "N of M returned" beats a retention curve at this sample size.

**What did they ask about?**
7. Topic mix across all courses, from the nine-label classifier already in `analytics.ipynb`
   (course material, assignments, syllabus and deadlines, technical setup, grades, office hours,
   team projects, resources, other).
8. Topic mix by course — the differences between a programming course and a design course are the
   most quotable finding available.
9. Topic mix this fall versus last year, to see whether the web and chat interfaces pulled in
   different kinds of questions than Discord did. Expect this to be suggestive, not conclusive.
10. Two or three verbatim exchanges, paraphrased and stripped of any identifying detail, as
    illustration. One per major topic. These do more for a general audience than any chart.

**What did it cost?** (only if `cost_ledger_entries` covers a usable span)
11. Cost per session and per active student, with the period the ledger actually covers stated
    plainly. If it only covers this fall, present it as a fall-only figure and do not extrapolate.

## 4. Handling a small dataset honestly

This is the part that determines whether the presentation holds up under questioning.

- **Always show n.** Every chart caption carries the number of sessions or students behind it. A bar
  built on nine conversations should say nine.
- **Prefer counts and shares to rates and percentages** when the denominator is under ~30. "11 of 24
  students" reads honestly; "45.8%" implies a precision that is not there.
- **No trend lines through fewer than about eight points**, and no forecasting. Show the weekly
  series as plotted points and let the audience see the noise.
- **Separate the launch from the behaviour.** Web and chat-assistant usage starting this fall is a
  fact about us, not about students. Where a year-over-year chart mixes surfaces, annotate the launch
  date directly on the chart.
- **Label speculation as speculation.** Mark interpretive slides with a consistent visual cue and
  phrase them as hypotheses with the evidence attached: "Deadline weeks drive roughly twice the
  sessions of other weeks (n = 6 deadline weeks, 14 other weeks) — consistent with the bot being used
  as a deadline-time reference rather than a study aid."
- **Spot-check the classifier.** Hand-read a sample of about 30 classified conversations and report
  the agreement rate on the methodology slide. A topic chart from an unaudited LLM classifier is an
  assertion; one with a stated agreement rate is a measurement. Where the classifier is wrong in a
  systematic direction (an over-eager "Other" bucket, say), name it.
- **Give "Other" its own moment.** A large "Other" share is itself a finding about what the label set
  misses, not a gap to hide.

## 5. Privacy rules for the output

Non-negotiable, and worth one line on the methodology slide so the audience knows it was considered.

- No names, emails, Discord handles, GitHub usernames, or student ids in any chart, table, or
  speaker note. The per-user charts in `analytics.ipynb` (top-15 by username) do not go in the deck;
  use the anonymous distribution instead.
- Quoted exchanges are paraphrased, with course-specific and personal detail removed, and only from
  conversations with no `deleted_at`.
- Suppress any cell of a breakdown covering fewer than five students — with cohorts this small, a
  course-by-topic cell of one is effectively a named individual.
- The analysis runs against a read-only copy of the database placed under `tmp/`, never against
  `data/data.db` directly; only aggregates leave that environment.

## 6. Presentation outline

Roughly twenty minutes. The outline below is the intent; the **generated report is now the
authoritative running order** — `analysis/examples/mock_report/USAGE_REPORT.md` shows it built from
mock data, as 24 `## S<nn>` slides across four parts (what Bloombot is · method · findings · what
this suggests). Edit the report notebook, not this list, when the order changes.

1. **What Bloombot is, how it works, who built it** — the five slides of §0 (interfaces and model,
   memory and logging, how students and courses are identified including the FERPA choice, the
   approval-gated multi-tenancy, and the one-developer build history).
2. **What we measured and how** — the session definition, the period, the exclusions, and the
   small-n caveat, stated once and up front so the rest of the deck does not have to hedge.
3. **Adoption** — share of enrolled students who used it, per course (measure 3).
4. **Volume over time** — the weekly line chart, with the fall launch annotated (measure 2).
5. **Where they talked to it** — the surface split, fall versus the year before (measure 1).
6. **What a typical session looks like** — median prompts and duration, with the distribution behind
   it (measures 4 and 5).
7. **Did they come back** — the return number (measure 6).
8. **What they asked about** — overall topic mix (measure 7).
9. **How that differed by course** — topic mix by course (measure 8).
10. **In their words** — two or three paraphrased exchanges (measure 10).
11. **What this suggests, and what it does not** — the speculative reading, explicitly labelled,
    alongside the questions the data cannot answer (no outcomes, no non-use signal, small n).
12. **What we would need to know more** — the instrumentation that would make the next version of
    this talk stronger: a thumbs-up on replies, a one-question exit survey, and linking sessions to
    assignment deadlines.

Slide 11 is the one to write first. If it cannot be written convincingly from the numbers, the
analysis is not finished.

## 7. The pipeline that implements this

Built and running against mock data; see `analysis/README.md`.

```
analysis/bloombot_analysis/   library: load & merge, sessions, topics, privacy, charts, report
analysis/notebooks/00–05      build the dataset → volume & adoption → session shape → topics →
                              cost → assemble the report
analysis/mock/                a synthetic two-database dataset exercising every awkward case
analysis/examples/mock_report/ a finished report from that mock data, for review
tests/test_analysis.py        the rules above, as tests
```

Run it with `python analysis/run_all.py --mock --as-of 2026-09-25`. To run it for real, copy the
pre-Fall-2026 database to `tmp/analysis/legacy.db` and the current one to `tmp/analysis/current.db`
and drop `--mock`; nothing in the pipeline opens `data/data.db`.

Four things the implementation added that this plan did not originally anticipate, each of which
would have produced a wrong number silently:

1. **The two databases keep time differently.** The old bot wrote naive local-time strings; the
   platform writes epoch milliseconds in UTC. Without converting to one zone, no duplicate is ever
   detected and every hour-of-day chart is off by the UTC offset.
2. **Imported history is in both databases.** The merge fingerprints each message and keeps the
   platform's copy, and the report prints how many it dropped.
3. **The weekly chart must break between terms.** A zero-filled summer draws a collapse and a
   recovery that never happened; weeks outside any term stay empty.
4. **The topic classifier must read the student's words only.** The bot's replies mention the
   syllabus, deadlines and tools whatever was asked, so classifying the whole transcript drags most
   sessions toward whichever topics the reply templates happen to name.

### What is left to do

1. **Plug in the real databases** and re-run.
2. **Confirm the term dates** in `analysis/bloombot_analysis/config.py`.
3. **Classify with `gpt-4o-mini`** (`--topic-method openai`) rather than the keyword fallback.
4. **Hand-audit ~30 sessions** and record the agreement rate, which the report then prints beside
   every topic chart.
5. **Read and paraphrase the quote candidates** before any of them reaches a slide.
6. **Write slide S22 first** — the speculative reading. If it cannot be argued from the charts, the
   analysis is not finished.
7. **Convert to slides** via The Slide Machine, parsing the `## S<nn>` headings, the takeaway line
   and the confidence field.
