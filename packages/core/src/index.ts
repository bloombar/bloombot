/** Public surface of `@bloombot/core`. */

export type { ModelClient, ModelRequest, ModelAnswer } from './ports.js'
export { ModelAskError } from './ports.js'

export {
  routeMessage,
  type RoutableCourse,
  type ArrivalContext,
  type RoutingResult,
  type RoutingAmbiguity,
} from './routing.js'

export {
  answerQuestion,
  type AnswerQuestionInput,
  type AnswerDependencies,
  type AnswerResult,
} from './answer.js'

export {
  computeCost,
  type ComputedCost,
  type ModelRate,
  type PricingTable,
} from './pricing.js'

export {
  createCountingModelClient,
  type CountingModelClient,
  type ModelCallStats,
} from './model-stats.js'
