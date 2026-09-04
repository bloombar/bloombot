/**
 * `responses.ts` — the request/response mapping, tested as plain
 * synchronous functions with no network at all (MDL-2, MDL-3, MDL-6).
 */

import { describe, expect, it } from 'vitest'

import {
  buildResponsesRequestBody,
  DEFAULT_MODEL,
  extractOutputText,
  extractUsage,
  MAX_OUTPUT_TOKENS,
  stripCitationMarkers,
} from '../src/responses.js'

describe('buildResponsesRequestBody (MDL-2): stored prompt vs. inline instructions', () => {
  it('sends the stored-prompt shape when the course has a promptId, and no instructions field', () => {
    const body = buildResponsesRequestBody({
      model: 'gpt-4.1',
      promptId: 'pmpt_abc123',
      instructions: 'ignored because promptId wins (D-3)',
      vectorStoreId: null,
      webSourceDomains: [],
      conversationId: 'conv_1',
      question: 'When is the midterm?',
    })

    expect(body.prompt).toEqual({ id: 'pmpt_abc123' })
    expect(body.instructions).toBeUndefined()
  })

  it('sends instructions inline when the course has no promptId', () => {
    const body = buildResponsesRequestBody({
      model: 'gpt-4.1',
      promptId: null,
      instructions: 'You are a helpful teaching assistant.',
      vectorStoreId: null,
      webSourceDomains: [],
      conversationId: 'conv_1',
      question: 'When is the midterm?',
    })

    expect(body.instructions).toBe('You are a helpful teaching assistant.')
    expect(body.prompt).toBeUndefined()
  })

  it('sends neither prompt nor instructions when the course has configured neither', () => {
    // answer.ts (CORE-1, finding 3) never calls the model for a course with
    // neither set, but the request builder itself should not invent one.
    const body = buildResponsesRequestBody({
      model: 'gpt-4.1',
      promptId: null,
      instructions: null,
      vectorStoreId: null,
      webSourceDomains: [],
      conversationId: 'conv_1',
      question: 'hi',
    })

    expect(body.prompt).toBeUndefined()
    expect(body.instructions).toBeUndefined()
  })

  it("bounds output at MAX_OUTPUT_TOKENS and stores on OpenAI's side (AI-4/MDL-5)", () => {
    const body = buildResponsesRequestBody({
      model: 'gpt-4.1',
      promptId: 'pmpt_abc123',
      instructions: null,
      vectorStoreId: null,
      webSourceDomains: [],
      conversationId: 'conv_1',
      question: 'hi',
    })

    expect(body.max_output_tokens).toBe(MAX_OUTPUT_TOKENS)
    expect(MAX_OUTPUT_TOKENS).toBe(2048)
    expect(body.store).toBe(true)
    expect(body.conversation).toBe('conv_1')
    expect(body.input).toEqual([{ role: 'user', content: 'hi' }])
  })
})

describe('buildResponsesRequestBody (MDL-3): file search only when the course has a vector store', () => {
  it("sends the file_search tool with the course's vector store id when set", () => {
    const body = buildResponsesRequestBody({
      model: 'gpt-4.1',
      promptId: 'pmpt_abc123',
      instructions: null,
      vectorStoreId: 'vs_course_1',
      webSourceDomains: [],
      conversationId: 'conv_1',
      question: 'hi',
    })

    expect(body.tools).toEqual([
      { type: 'file_search', vector_store_ids: ['vs_course_1'] },
    ])
  })

  it('sends no tools field at all when the course has no vector store', () => {
    const body = buildResponsesRequestBody({
      model: 'gpt-4.1',
      promptId: 'pmpt_abc123',
      instructions: null,
      vectorStoreId: null,
      webSourceDomains: [],
      conversationId: 'conv_1',
      question: 'hi',
    })

    expect(body.tools).toBeUndefined()
  })
})

describe('buildResponsesRequestBody (MDL-9/FILE-6): web search only when the course has named websites, restricted to exactly those domains (WEB-31)', () => {
  it('sends the web_search tool restricted to the course own domains when set', () => {
    const body = buildResponsesRequestBody({
      model: 'gpt-4.1',
      promptId: 'pmpt_abc123',
      instructions: null,
      vectorStoreId: null,
      webSourceDomains: ['example.edu', 'docs.python.org'],
      conversationId: 'conv_1',
      question: 'hi',
    })

    expect(body.tools).toEqual([
      {
        type: 'web_search',
        filters: { allowed_domains: ['example.edu', 'docs.python.org'] },
      },
    ])
  })

  it('sends no tools field at all when the course has no vector store and no websites', () => {
    const body = buildResponsesRequestBody({
      model: 'gpt-4.1',
      promptId: 'pmpt_abc123',
      instructions: null,
      vectorStoreId: null,
      webSourceDomains: [],
      conversationId: 'conv_1',
      question: 'hi',
    })

    expect(body.tools).toBeUndefined()
  })

  it('sends both file_search and web_search when a course has both a vector store and websites', () => {
    const body = buildResponsesRequestBody({
      model: 'gpt-4.1',
      promptId: 'pmpt_abc123',
      instructions: null,
      vectorStoreId: 'vs_course_1',
      webSourceDomains: ['example.edu'],
      conversationId: 'conv_1',
      question: 'hi',
    })

    expect(body.tools).toEqual([
      { type: 'file_search', vector_store_ids: ['vs_course_1'] },
      { type: 'web_search', filters: { allowed_domains: ['example.edu'] } },
    ])
  })
})

describe('DEFAULT_MODEL (AI-4)', () => {
  it('is gpt-4o, the platform default when a course has never configured its own model', () => {
    expect(DEFAULT_MODEL).toBe('gpt-4o')
  })
})

describe('extractOutputText', () => {
  it('concatenates every output_text part of every message-typed output item, in order', () => {
    const payload = {
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'Part one. ' },
            { type: 'output_text', text: 'Part two.' },
          ],
        },
        // Non-message output items (e.g. a file_search call trace) are
        // skipped entirely rather than stringified into the answer.
        { type: 'file_search_call', content: 'irrelevant' },
      ],
    }

    expect(extractOutputText(payload)).toBe('Part one. Part two.')
  })

  it('returns an empty string when there is no output array at all', () => {
    expect(extractOutputText({})).toBe('')
  })
})

describe('stripCitationMarkers (MDL-6)', () => {
  it('strips a single marker', () => {
    expect(
      stripCitationMarkers('See the syllabus【4:0†syllabus.pdf】 for details.')
    ).toBe('See the syllabus for details.')
  })

  it('strips several markers in one answer', () => {
    const text =
      'The exam is Friday【4:0†syllabus.pdf】 and covers chapters 1-3【7:2†schedule.pdf】.'
    expect(stripCitationMarkers(text)).toBe(
      'The exam is Friday and covers chapters 1-3.'
    )
  })

  it('strips a marker whose content spans a newline', () => {
    const text = 'Office hours are Tuesday【4:0†syllabus\n.pdf】 at 2pm.'
    expect(stripCitationMarkers(text)).toBe('Office hours are Tuesday at 2pm.')
  })

  it('leaves text with no markers untouched', () => {
    expect(stripCitationMarkers('No citations here.')).toBe(
      'No citations here.'
    )
  })
})

describe('extractUsage (MDL-5)', () => {
  it('returns the token counts the provider reported', () => {
    const usage = extractUsage({
      usage: { input_tokens: 12, output_tokens: 34 },
    })
    expect(usage).toEqual({ inputTokens: 12, outputTokens: 34 })
  })

  it('returns undefined when the provider reported no usage at all', () => {
    expect(extractUsage({})).toBeUndefined()
  })
})
