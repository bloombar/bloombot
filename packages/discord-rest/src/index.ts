/** Public surface of `@bloombot/discord-rest` — Discord's OAuth2 and REST API behind a port (TEN-4). */

export {
  createDiscordRestClient,
  DiscordRequestError,
  type CreateDiscordRestClientOptions,
  type DiscordChannel,
  type DiscordGuildMember,
  type DiscordOAuthToken,
  type DiscordRestClient,
  type DiscordRole,
} from './client.js'

export { buildDiscordAuthorizationUrl } from './authorize-url.js'
export type { BuildDiscordAuthorizationUrlInput } from './authorize-url.js'

export { administersGuild, type DiscordGuildSummary } from './permissions.js'

export {
  allowMemberOverwrite,
  allowRoleOverwrite,
  denyEveryoneOverwrite,
  overwriteAllowsView,
  overwriteDeniesView,
  type DiscordOverwriteType,
  type DiscordPermissionOverwrite,
} from './channel-overwrites.js'

export { DiscordTransportError } from './http.js'
