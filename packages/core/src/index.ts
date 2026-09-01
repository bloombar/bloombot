/** Public surface of `@bloombot/core`. */

export type { ModelClient, ModelRequest, ModelAnswer } from './ports.js'

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
