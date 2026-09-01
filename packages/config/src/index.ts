/** Public surface of `@bloombot/config`. */

export {
  CONFIG,
  EnvValidationError,
  envSchema,
  loadConfig,
  parseEnv,
  resetConfigCache,
  type Env,
} from './env.js'
export { adminEmails, isAdminEmail } from './admin.js'
export {
  getModelPricingTable,
  DEFAULT_PRICING_JSON,
  type ModelRate,
  type PricingTable,
} from './pricing.js'
