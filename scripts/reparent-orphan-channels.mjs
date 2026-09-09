/**
 * Moves orphaned Discord channels back into a category, runnable as
 * `npm run discord:reparent`.
 *
 * A category deleted in Discord's own UI does not take its channels with it —
 * they survive, uncategorised, keeping the permission overwrites they were
 * created with. That happened here: a hand-made student category was deleted
 * and ~100 per-student channels were left loose at the bottom of the guild.
 * Re-filing them by hand is a hundred drags; this does it by asking each
 * orphan which admins role can see it and filing it under that role's
 * category.
 *
 * A channel already inside a category is never touched, and an orphan whose
 * overwrites name none of the configured roles is reported and left where it
 * is — the script only ever *sets a parent*, never creates, renames or
 * deletes anything, so the worst a wrong rule can do is put a channel in the
 * wrong category, which is a drag to undo rather than a loss.
 *
 * `parent_id` is set on its own, without Discord's `lock_permissions`, so a
 * moved channel keeps its own overwrites instead of inheriting the new
 * parent's. That is the whole point for per-student channels: syncing to the
 * category would replace each student's individual grant with the category's
 * role-level one. (The same trap waits in the UI afterwards — "Sync Now" on
 * the category undoes exactly this.)
 *
 * Dry run by default; `--apply` is what actually writes. Rules come from
 * `--rule <roleName>=<categoryName>`, repeatable, and `--exclude <name>`
 * skips a channel by name.
 *
 * Deliberately dependency-free from the workspace's own TypeScript packages,
 * the same reason `scripts/check-discord-oauth.mjs` gives: this must run on a
 * droplet without a build.
 */

import { loadDotEnvOnce } from './load-dotenv.mjs'

/** Discord's `VIEW_CHANNEL` permission bit — a role "has access" to a channel when its overwrite allows this. */
export const VIEW_CHANNEL_BIT = 0x400n

/** Discord's channel type for a category (`GUILD_CATEGORY`). */
export const CATEGORY_TYPE = 4

/**
 * Parse the command line into `{ apply, rules, exclude }`.
 *
 * Rules are `roleName=categoryName`; a role name may itself contain no `=`,
 * but a category name may, so only the first `=` splits.
 */
export function parseArgs(argv) {
  const rules = []
  const exclude = []
  let apply = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') {
      apply = true
    } else if (arg === '--rule') {
      const value = argv[(i += 1)]
      if (!value || !value.includes('=')) {
        throw new Error(`--rule needs <roleName>=<categoryName>, got: ${value}`)
      }
      const split = value.indexOf('=')
      rules.push({
        role: value.slice(0, split),
        category: value.slice(split + 1),
      })
    } else if (arg === '--exclude') {
      const value = argv[(i += 1)]
      if (!value) throw new Error('--exclude needs a channel name')
      exclude.push(value)
    } else {
      throw new Error(`unrecognised argument: ${arg}`)
    }
  }
  return { apply, rules, exclude }
}

/**
 * Resolve each rule's role name and category name against a guild's actual
 * roles and channels, returning a role-id-keyed map of destinations plus a
 * per-rule report of what did and did not resolve.
 *
 * A rule naming a role or category the guild does not have is reported rather
 * than thrown: a guild that satisfies one rule and not the other is a normal
 * state (a course whose category has not been made yet), and refusing the
 * whole run over it would help nobody.
 */
export function resolveRules(rules, roles, channels) {
  const roleIdsByName = new Map(roles.map((role) => [role.name, role.id]))
  const categoriesByName = new Map(
    channels
      .filter((channel) => channel.type === CATEGORY_TYPE)
      .map((channel) => [channel.name, channel.id])
  )

  const targets = new Map()
  const report = []
  for (const rule of rules) {
    const roleId = roleIdsByName.get(rule.role)
    const categoryId = categoriesByName.get(rule.category)
    if (!roleId) {
      report.push({ ...rule, status: 'role missing' })
    } else if (!categoryId) {
      report.push({ ...rule, status: 'category missing' })
    } else {
      targets.set(roleId, { categoryId, categoryName: rule.category })
      report.push({ ...rule, status: 'ok' })
    }
  }
  return { targets, report }
}

/**
 * Which category, if any, a single channel should be moved into.
 *
 * Returns `null` for a channel that is itself a category, one that already has
 * a parent, one whose name is excluded, or one no rule's role can see. The
 * first matching overwrite wins — a channel granted to two admins roles is not
 * a case this repairs, and picking one deterministically beats guessing.
 */
export function planChannel(channel, targets, exclude = []) {
  if (channel.type === CATEGORY_TYPE) return null
  if (channel.parent_id) return null
  if (exclude.includes(channel.name)) return null

  for (const overwrite of channel.permission_overwrites ?? []) {
    // `type: 0` is a role overwrite; `1` is a single member's.
    if (overwrite.type !== 0) continue
    const target = targets.get(overwrite.id)
    if (!target) continue
    if (BigInt(overwrite.allow ?? '0') & VIEW_CHANNEL_BIT) return target
  }
  return null
}

/**
 * Plan a whole guild: every channel that should move, and every orphan that
 * matched nothing. Pure, so the interesting decisions are testable without a
 * network.
 */
export function planGuild(channels, targets, exclude = []) {
  const moves = []
  const skipped = []
  for (const channel of channels) {
    if (channel.type === CATEGORY_TYPE || channel.parent_id) continue
    const target = planChannel(channel, targets, exclude)
    if (target) {
      moves.push({ channel, target })
    } else {
      skipped.push(channel)
    }
  }
  return { moves, skipped }
}

/**
 * Count what each destination category would hold after the plan is applied,
 * so a run that would breach Discord's 50-channels-per-category limit says so
 * before it half-fills a category and starts failing.
 */
export function projectedCategorySizes(channels, moves) {
  const sizes = new Map()
  for (const channel of channels) {
    if (channel.type === CATEGORY_TYPE || !channel.parent_id) continue
    sizes.set(channel.parent_id, (sizes.get(channel.parent_id) ?? 0) + 1)
  }
  for (const move of moves) {
    const id = move.target.categoryId
    sizes.set(id, (sizes.get(id) ?? 0) + 1)
  }
  return sizes
}

/** Discord's own hard limit on how many channels one category may hold. */
export const CATEGORY_CHANNEL_LIMIT = 50

// --- the network half ------------------------------------------------------

const DEFAULT_API_BASE = 'https://discord.com/api/v10'

/** One Discord API call, waiting out a 429 rather than failing on it. */
async function call(method, path, { token, apiBase, body } = {}) {
  for (;;) {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        'User-Agent': 'bloombot-reparent/1.0',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (response.status === 429) {
      const retryAfter = await response
        .json()
        .then((json) => json.retry_after ?? 1)
        .catch(() => 1)
      await new Promise((resolve) =>
        setTimeout(resolve, (retryAfter + 0.5) * 1000)
      )
      continue
    }
    if (!response.ok) {
      throw new Error(
        `${method} ${path} -> ${response.status}: ${await response.text()}`
      )
    }
    return response.status === 204 ? null : response.json()
  }
}

/** Run the whole repair against every guild the bot is in. */
async function main() {
  loadDotEnvOnce()

  const { apply, rules, exclude } = parseArgs(process.argv.slice(2))
  if (rules.length === 0) {
    console.error(
      'Usage: node scripts/reparent-orphan-channels.mjs \\\n' +
        '  --rule "<roleName>=<categoryName>" [--rule ...] [--exclude <channelName>] [--apply]'
    )
    process.exitCode = 1
    return
  }

  const token = process.env.BOT_TOKEN
  if (!token) {
    console.error('BOT_TOKEN is not set.')
    process.exitCode = 1
    return
  }
  const apiBase = (process.env.DISCORD_API_BASE ?? DEFAULT_API_BASE).replace(
    /\/+$/,
    ''
  )
  const options = { token, apiBase }

  for (const guild of await call('GET', '/users/@me/guilds', options)) {
    const channels = await call('GET', `/guilds/${guild.id}/channels`, options)
    const roles = await call('GET', `/guilds/${guild.id}/roles`, options)
    const { targets, report } = resolveRules(rules, roles, channels)
    if (targets.size === 0) continue

    console.log(`\n=== ${guild.name} (${guild.id}) ===`)
    for (const rule of report) {
      console.log(`  rule ${rule.role} -> ${rule.category}: ${rule.status}`)
    }

    const { moves, skipped } = planGuild(channels, targets, exclude)

    // Refuse a plan that would breach Discord's per-category limit rather than
    // discovering it partway through and leaving the guild half-repaired.
    const categoryNames = new Map(
      channels
        .filter((channel) => channel.type === CATEGORY_TYPE)
        .map((channel) => [channel.id, channel.name])
    )
    let overfull = false
    for (const [categoryId, size] of projectedCategorySizes(channels, moves)) {
      if (size > CATEGORY_CHANNEL_LIMIT) {
        console.error(
          `  OVER LIMIT: ${categoryNames.get(categoryId) ?? categoryId} would hold ${size} channels (max ${CATEGORY_CHANNEL_LIMIT})`
        )
        overfull = true
      }
    }
    if (overfull) {
      console.error('  Refusing to move anything in this guild.')
      process.exitCode = 1
      continue
    }

    for (const channel of skipped) {
      console.log(`  SKIP  #${channel.name} (${channel.id})`)
    }
    for (const { channel, target } of moves) {
      console.log(
        `  MOVE  #${channel.name} (${channel.id}) -> ${target.categoryName}`
      )
      if (apply) {
        // No `lock_permissions`: the channel keeps its own overwrites rather
        // than syncing to the new parent (see this file's module comment).
        await call('PATCH', `/channels/${channel.id}`, {
          ...options,
          body: { parent_id: target.categoryId },
        })
      }
    }
    console.log(
      `  -- ${moves.length} to move, ${skipped.length} orphans skipped`
    )
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing changed. Re-run with --apply to move.')
  }
}

// Only run when invoked directly, so the test can import the pure functions.
if (process.argv[1]?.endsWith('reparent-orphan-channels.mjs')) {
  await main()
}
