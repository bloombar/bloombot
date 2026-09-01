/**
 * Test helper: a loopback stand-in for Google's OIDC discovery and JWKS
 * endpoints, bound to `127.0.0.1:0` so the OS picks a free port and no test
 * reaches the real network — the same shape
 * `packages/openai/tests/helpers/fake-openai-server.ts` uses for OpenAI.
 *
 * `google.ts#createGoogleIdTokenVerifier` is tested against this, not
 * against Google: point `issuer` at `server.baseUrl` and `fetchFn` at
 * nothing special (the global `fetch` reaches loopback fine) to prove the
 * real verifier's discovery, signature, issuer and audience checks all work
 * without ever leaving the process.
 */

import { createServer, type Server } from 'node:http'

import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from 'jose'

export interface FakeGoogleIdentityClaims {
  sub: string
  email: string
  email_verified: boolean
}

export class FakeGoogleServer {
  private server: Server
  private publicJwk: JWK
  private privateKey: CryptoKey
  private readonly kid = 'fake-key-1'

  private constructor(server: Server, publicJwk: JWK, privateKey: CryptoKey) {
    this.server = server
    this.publicJwk = publicJwk
    this.privateKey = privateKey
  }

  /** Start listening and generate the RSA key pair the fake signs tokens with. */
  static async start(): Promise<FakeGoogleServer> {
    const { publicKey, privateKey } = await generateKeyPair('RS256', {
      extractable: true,
    })
    const publicJwk = await exportJWK(publicKey)

    return new Promise((resolve) => {
      const server = createServer()
      const instance = new FakeGoogleServer(
        server,
        { ...publicJwk, kid: 'fake-key-1', alg: 'RS256', use: 'sig' },
        privateKey
      )
      server.on('request', (req, res) => {
        void instance.handle(req.url ?? '', res)
      })
      server.listen(0, '127.0.0.1', () => resolve(instance))
    })
  }

  get baseUrl(): string {
    const address = this.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('FakeGoogleServer.baseUrl read before listening')
    }
    return `http://127.0.0.1:${address.port}`
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  /**
   * Sign an ID token as this fake's own key would — `issuer`/`audience`
   * default to this server's own values so a caller only has to override
   * them for the specific negative tests that need a mismatch.
   */
  async signIdToken(
    claims: FakeGoogleIdentityClaims,
    options: {
      issuer?: string
      audience?: string
      expiresInSeconds?: number
    } = {}
  ): Promise<string> {
    return this.signClaims(claims.sub, { ...claims }, options)
  }

  /**
   * Sign a token with arbitrary claims, `sub` set separately — for the
   * negative tests that need a token missing a claim `signIdToken`'s typed
   * `claims` parameter would not let them omit (a malformed `email`, say).
   */
  async signClaims(
    subject: string,
    claims: Record<string, unknown>,
    options: {
      issuer?: string
      audience?: string
      expiresInSeconds?: number
    } = {}
  ): Promise<string> {
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: this.kid })
      .setIssuer(options.issuer ?? this.baseUrl)
      .setAudience(options.audience ?? 'test-client-id')
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime(
        Math.floor(Date.now() / 1000) + (options.expiresInSeconds ?? 3600)
      )
      .sign(this.privateKey)
  }

  private handle(url: string, res: import('node:http').ServerResponse): void {
    if (url === '/.well-known/openid-configuration') {
      this.respondJson(res, { jwks_uri: `${this.baseUrl}/certs` })
      return
    }
    if (url === '/certs') {
      this.respondJson(res, { keys: [this.publicJwk] })
      return
    }
    res.writeHead(404)
    res.end()
  }

  private respondJson(
    res: import('node:http').ServerResponse,
    body: unknown
  ): void {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
}
