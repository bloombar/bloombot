/**
 * Test helper: `buildApp` with every dependency defaulted to something a
 * test can run against with no network and no listening port — a real
 * throwaway database, a recording mail port, a fake Google verifier, and a
 * fixed `publicAppUrl` every origin-check test compares against. A test
 * overrides only the one field its own scenario needs.
 */

import type {
  GoogleIdTokenVerificationResult,
  GoogleIdTokenVerifier,
} from '@bloombot/auth'
import { RecordingEmailSender } from '@bloombot/auth'
import type { Database } from '@bloombot/db'
import type { Express } from 'express'

import { buildApp, type ServerDependencies } from '../../src/server.js'
import { createFakeLogger } from './fake-logger.js'

/** The origin every origin-check test treats as "this site" — never a real host, since nothing here reaches the network. */
export const TEST_PUBLIC_APP_URL = 'https://app.bloombot.test'

/** A `GoogleIdTokenVerifier` that never reaches a network — always refuses, unless a test replaces `verifyIdToken` with its own. */
export function createFakeGoogleVerifier(
  result: GoogleIdTokenVerificationResult = {
    ok: false,
    reason: 'fake verifier: no token configured to verify',
  }
): GoogleIdTokenVerifier {
  return {
    verifyIdToken: () => Promise.resolve(result),
  }
}

export function buildTestApp(
  db: Database,
  overrides: Partial<ServerDependencies> = {}
): Express {
  return buildApp({
    db,
    logger: createFakeLogger(),
    publicAppUrl: TEST_PUBLIC_APP_URL,
    emailSender: new RecordingEmailSender(),
    buildSignInLink: (token) => `${TEST_PUBLIC_APP_URL}/sign-in/${token}`,
    googleVerifier: createFakeGoogleVerifier(),
    ...overrides,
  })
}
