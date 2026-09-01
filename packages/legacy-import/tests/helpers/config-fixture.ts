/** Test helper: a small, two-course legacy config, already in `legacyBotConfigSchema`'s normalized output shape (QA-3). */

import type { LegacyBotConfig } from '@bloombot/schemas'

export function twoCourseConfig(serverName = 'Test Server'): LegacyBotConfig {
  return {
    server: {
      name: serverName,
      courses: [
        {
          title: 'Web Design',
          file_prefix: 'wd',
          openai_assistant: {
            prompt_id: 'pmpt_wd',
            tools: [],
            limits: { max_requests_per_day: 20 },
          },
          roles: { admins: 'admins-wd', students: 'students-wd' },
          categories: [
            {
              name: 'Web Design - GLOBAL',
              channels: [
                { name: 'admins', admins_only: true },
                { name: 'general', admins_only: false },
              ],
            },
            { name: 'Web Design - STUDENTS 01', channels: [] },
          ],
        },
        {
          title: 'Python',
          file_prefix: 'py',
          openai_assistant: {
            prompt_id: 'pmpt_py',
            tools: [],
            limits: {},
          },
          roles: { admins: 'admins-py', students: 'students-py' },
          categories: [{ name: 'Python - GLOBAL', channels: [] }],
        },
      ],
    },
  }
}
