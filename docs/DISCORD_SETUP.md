# Setting up Bloombot in a Discord server

Everything a server administrator does, in order, from an empty Discord application to a bot that
answers a student's question. Each step says what it is for and how to tell it worked.

This documents the **platform** (the TypeScript system on `feat/PLAT-1-multi-surface-platform`), not the
Python bot currently running in production. Where the two differ, the difference is noted.

**Who does what.** Steps 1 and 2 are done once per deployment, by whoever operates the platform. Steps 3
onward are done by each instructor, per server, and need no access to the server the platform runs on.

---

## 1. Create the Discord application (once per deployment)

At <https://discord.com/developers/applications> → **New Application**.

1. **Bot** → add a bot user. Copy the **token**. It is shown once; a lost token has to be regenerated,
   which invalidates the old one.
2. On the same page, enable both **privileged gateway intents**:
   - **Message Content Intent** — without it Discord withholds message text entirely, and the bot has
     nothing to check a mention against. Everything still connects; nothing is ever answered.
   - **Server Members Intent** — the author's roles are how a question routes when its category does not
     match a course.
3. **OAuth2** → copy the **Client ID** and generate a **Client Secret**. The client id is the same value as
   the application id: the platform passes it as both `BOT_APP_ID` and the OAuth `client_id`, which is why
   there is no separate variable for it.
4. **OAuth2 → Redirects** → add the platform's install callback, which is your panel's address followed by
   the Discord callback path. It must match exactly, including scheme and any port.
5. Decide the bot's **permissions integer** — the value used when the bot is invited. It needs at least
   **Manage Channels** if instructors will use the platform to create a course's categories and channels,
   plus the ordinary send/read permissions. Discord's own permission calculator on the **Bot** page
   produces the number.

## 2. Configure the platform (once per deployment)

In the platform's `.env` — see `env.example`, which lists every variable with a comment:

| variable | what it is |
| --- | --- |
| `BOT_TOKEN` | the bot token from step 1.1 |
| `BOT_APP_ID` | the application id, **also used as the OAuth client id** |
| `DISCORD_CLIENT_SECRET` | the OAuth client secret from step 1.3 |
| `BOT_PERMISSIONS` | the permissions integer from step 1.5 |
| `OPENAI_API_KEY` | the model provider key |
| `PUBLIC_APP_URL` | the panel's public address — also what the API checks requests' `Origin` against |
| `DATABASE_PATH` | the platform's SQLite file |

Credentials deliberately live only in `.env` and never in the configuration schema (CFG-5), which is why
`env.example` carries them as empty values. A tracked template holding a real value is a leaked secret, and
a test enforces that every credential-named key in it stays empty.

**Check it worked:** start the API and the bot. The bot's health endpoint reports the gateway as connected,
and the API's reports ready. A bot that is running but not connected is exactly the state those endpoints
exist to distinguish.

## 3. Install the bot into a server (per server, by an instructor)

1. Sign in to the control panel.
2. **Install to Discord**. You are sent to Discord's own authorization screen, which asks you to pick a
   server.
3. Choose the server and approve.

**What the platform checks before it binds anything:** that the account installing genuinely administers
that server — owner, or **Manage Server** — read from Discord itself rather than taken from the request. A
server already bound to another organization is refused, and the refusal says nothing about who holds it.
The user access token from the exchange is discarded immediately: nothing needs it afterwards, and storing
it would be a liability.

**Check it worked:** the panel lists the server. In Discord, the bot appears in the member list.

**If it is refused:** you do not administer that server, or somebody else has already installed the bot
there. Those two produce the same message on purpose — telling them apart would disclose whether a server
is known to the platform.

## 4. Set up the Discord side (per course)

The bot decides which course a question belongs to by **where it was asked** and **who asked it**, so the
server's structure is part of the configuration rather than decoration.

1. **Create the roles** a course will use — one for staff, one for students, e.g. `admins-wd-su26` and
   `students-wd-su26`. Semester-scoped names are the convention: next term's roles can be created without
   disturbing this term's.
2. **Create the categories** the course will use, e.g. `Web Design - GLOBAL` for shared channels and
   `Web Design - STUDENTS 01` for per-student ones. Discord caps a category at 50 channels, which is why
   student categories are numbered.
3. **Give students their role.** Discord's own onboarding can assign it automatically when someone accepts
   an invite; that is the instructor's admission decision and the platform treats it as one.

Names must be unique across every **enabled** course in the server, regardless of which project they belong
to — a question arriving in a category can only belong to one course. The panel refuses a save that would
collide and names the course and project it collides with.

## 5. Create a project and define the course (per course, in the panel)

1. **Projects → Create project.** A project is usually a term — "Fall 2026". Courses live in projects, and
   archiving the project at the end of term stops its courses routing without deleting anything.
2. Open the project and **add a course**. What each field does:
   - **Title** — what the course is called in the panel.
   - **Admin role** and **student role** — the Discord role *names* from step 4.1. These are the fallback
     routing signal, used when a question's category matches no course.
   - **Categories and channels** — the category *names* from step 4.2. These are the **primary** routing
     signal: a question asked in one of them belongs to this course.
   - **Instructions** — what the assistant is told about its persona and how to answer. An instructor
     writes these in the panel; nothing here requires a vendor dashboard.
   - **Prompt id** — optional, and it *wins over instructions when set*. It exists so the two courses
     running today behave exactly as they do now; a new course leaves it empty.
   - **Model** and **vector store id** — optional. Empty means the platform's defaults.
   - **Max requests per day** — the per-student daily allowance for this course. Empty means the platform
     default of 10.
   - **Enabled** — whether this course routes at all.
3. **Save**, then **enable** the course.

**Rolling a term forward:** duplicate the project. The copies arrive **disabled** on purpose — a duplicate
carries the same category and role names as the original, which is exactly the collision the uniqueness rule
forbids among enabled courses. Rename them for the new term, then enable, which is when the check runs.

## 6. Verify it answers

In a channel inside one of the course's categories, mention the bot with a question.

You should get a reply **to your message**, in that channel, split across several messages if it is long.
Both your question and the answer are recorded in the course's transcript.

**When it does not answer, the reason is one of these:**

| what you see | what it means |
| --- | --- |
| nothing at all, in any channel | the server is not bound to an organization, or the message did not mention the bot |
| nothing, and the category is one you declared | the course is disabled, or its project is archived |
| nothing, and the category is *not* declared | no course matches the category, and your roles match none either — the bot stays silent outside the courses it is configured for rather than answering from general knowledge |
| "cannot answer right now… see the course admins" | the model call failed; the question is still recorded |
| a note that you have reached the day's maximum | the per-student daily allowance for this course is spent; it resets at the local calendar day |
| a reply saying the course is not configured to answer | the course has neither instructions nor a prompt id |

The bot only ever answers a **direct mention** or a reply to one of its own messages. It ignores its own
messages and other bots'.

## 7. Removing the bot

Remove it from the panel, or remove it from the server in Discord.

**Removal marks the binding inactive. It deletes nothing** — not the courses, not the rosters, not the
transcripts. A transcript is a record an instructor may be required to retain, and deleting a tenant's data
is a separate, explicitly confirmed and audited operation. Re-installing restores a working setup.

---

## Troubleshooting

**The bot is online but never answers anything.** Almost always the Message Content Intent (step 1.2).
Without it Discord delivers events with empty message text, so no mention is ever recognized.

**Questions route to the wrong course.** Two enabled courses declare the same category or role name. The
panel refuses that on save, but a course *enabled* after another took its names can reach the same state —
check both courses' categories in the panel.

**Everything worked, then stopped after a deploy.** Check the bot's health endpoint. It distinguishes
"running" from "connected"; a process that is up with a dead gateway is the state that otherwise looks
healthy from the outside.

**A student says they have hit the limit but should not have.** The allowance is per student, per course,
per **local** calendar day. Note that the platform answers ten questions a day where the Python bot answered
eleven — the Python bot refused only *after* the count exceeded the limit. That is a deliberate difference,
recorded in `docs/DECISIONS.md`.
