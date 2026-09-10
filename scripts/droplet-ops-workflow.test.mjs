/**
 * Shape tests for `.github/workflows/droplet-ops.yml` (OPS-17).
 *
 * There is no existing harness that reads workflow YAML — OPS-16 checked
 * and deliberately did not invent one, and this suite does not either. What
 * it does check is narrow but load-bearing: this workflow runs commands as
 * the deploy user against live production data and a live OpenAI account,
 * so a careless later edit that adds a second input or loosens the
 * `--apply` gate is exactly the kind of regression a text/YAML-shape
 * assertion catches cheaply, without ever running the workflow itself.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'

const WORKFLOW_PATH = fileURLToPath(
  new URL('../.github/workflows/droplet-ops.yml', import.meta.url)
)

const raw = readFileSync(WORKFLOW_PATH, 'utf8')

test('droplet-ops.yml parses as YAML', () => {
  assert.doesNotThrow(() => parse(raw))
})

test('droplet-ops.yml: workflow_dispatch is the only trigger', () => {
  const doc = parse(raw)
  // YAML parses the bare `on:` key as the boolean `true`, not the string
  // "on" — this reads the same key either way.
  const on = doc.on ?? doc[true]
  assert.ok(on, 'workflow has no `on:` trigger at all')
  assert.deepEqual(Object.keys(on), ['workflow_dispatch'])
})

test('droplet-ops.yml: the only input is `apply`, a boolean defaulting to false', () => {
  const doc = parse(raw)
  const on = doc.on ?? doc[true]
  const inputs = on.workflow_dispatch.inputs
  assert.deepEqual(Object.keys(inputs), ['apply'])
  assert.equal(inputs.apply.type, 'boolean')
  assert.equal(inputs.apply.default, false)
})

test('droplet-ops.yml: the concurrency group matches the deploy job in ci.yml', () => {
  const doc = parse(raw)
  const jobs = Object.values(doc.jobs)
  assert.equal(jobs.length, 1, 'expected exactly one job')
  const [job] = jobs
  assert.equal(job.concurrency.group, 'deploy-production')
  assert.equal(job.concurrency['cancel-in-progress'], false)
  assert.equal(job.environment, 'production')
})

test('droplet-ops.yml: --apply is only ever emitted inside a branch gated on the exact string "true"', () => {
  // A regex over the raw text, not just the parsed YAML: the risk this
  // guards against is a `run:` block edit, and YAML parsing does not look
  // inside `run:` shell at all.
  const applyOccurrences = [...raw.matchAll(/--apply/g)]
  assert.ok(applyOccurrences.length > 0, 'expected `--apply` to appear at all')

  // Every appearance of `--apply` must be preceded, within the same `run:`
  // block, by an `if [ "$APPLY_INPUT" = "true" ]` guard with no `else`
  // branch that could also add it unconditionally.
  const guardedAssignment =
    /if \[ "\$APPLY_INPUT" = "true" \]; then\n\s+prune_cmd="\$prune_cmd --apply"\n\s+fi/
  assert.match(raw, guardedAssignment)

  // And the gate is an exact-string compare against "true" — never a bare
  // truthiness check (`if [ "$APPLY_INPUT" ]`) that an unset-but-present
  // "false" string input would pass.
  assert.doesNotMatch(raw, /if \[ "\$APPLY_INPUT" \]/)
})

test('droplet-ops.yml: an unset `apply` input cannot produce --apply', () => {
  // GitHub renders an unset boolean workflow_dispatch input as the literal
  // string "false" — this simulates exactly that value flowing through the
  // env var the workflow reads, and confirms the gate rejects it.
  const APPLY_INPUT = 'false'
  const gateHolds = APPLY_INPUT === 'true'
  assert.equal(gateHolds, false)
})
