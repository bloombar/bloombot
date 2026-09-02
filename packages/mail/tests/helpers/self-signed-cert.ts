/**
 * Test helper: a throwaway, self-signed TLS certificate for `127.0.0.1`,
 * generated fresh by shelling out to `openssl` — the same "a real tool,
 * not a hand-rolled stand-in" precedent `apps/web/tests/bundle.test.ts`
 * already sets for its own `vite build`. Exists for one reason:
 * `requireTLS: false` (the override every other test in this package uses)
 * proves this adapter refuses to send without STARTTLS, but it cannot prove
 * a real STARTTLS handshake actually *completes* — that needs a fake server
 * that genuinely offers TLS, which needs a certificate.
 *
 * Written under this repo's own `tmp/` (gitignored), never the OS tmpdir —
 * the same convention `packages/db/tests/helpers/test-db.ts` uses for a
 * throwaway path. `openssl` is assumed present (CI runs on `ubuntu-latest`,
 * which ships it; every developer machine building this repo already has it
 * for local HTTPS or git).
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SelfSignedCert {
  keyPem: string
  certPem: string
  /** Removes the scratch directory the key and certificate were written into. */
  cleanup: () => void
}

/** Generate a fresh RSA key and a one-day, self-signed certificate for `127.0.0.1` (as a SAN, not merely a CN — a modern Node TLS client checks the SAN, not the legacy CN, when verifying a hostname). */
export function generateSelfSignedCert(): SelfSignedCert {
  const dir = join(
    process.cwd(),
    'tmp',
    'mail-tests',
    `cert-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  mkdirSync(dir, { recursive: true })
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')
  const configPath = join(dir, 'san.cnf')

  const config = [
    '[req]',
    'distinguished_name = req_distinguished_name',
    'x509_extensions = v3_req',
    'prompt = no',
    '[req_distinguished_name]',
    'CN = 127.0.0.1',
    '[v3_req]',
    'subjectAltName = @alt_names',
    '[alt_names]',
    'IP.1 = 127.0.0.1',
    '',
  ].join('\n')
  writeFileSync(configPath, config, 'utf8')

  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-nodes',
      '-config',
      configPath,
    ],
    { stdio: 'pipe' }
  )

  return {
    keyPem: readFileSync(keyPath, 'utf8'),
    certPem: readFileSync(certPath, 'utf8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
