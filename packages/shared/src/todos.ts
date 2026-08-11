import { z } from 'zod'

export const TODO_STATUSES = ['open', 'done', 'cancelled'] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

export const TODO_SOURCES = ['manual', 'import'] as const
export type TodoSource = (typeof TODO_SOURCES)[number]

export const todoCreateSchema = z.object({
  title: z.string().min(1).max(300),
  notes: z.string().max(4000).nullable().default(null),
  dueAt: z.coerce.date().nullable().default(null),
  status: z.enum(TODO_STATUSES).default('open'),
})
export type TodoCreate = z.infer<typeof todoCreateSchema>

export const todoPatchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  notes: z.string().max(4000).nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
  status: z.enum(TODO_STATUSES).optional(),
})
export type TodoPatch = z.infer<typeof todoPatchSchema>

/** Follow-up / action item extracted from an imported document. */
export const extractedTodoSchema = z.object({
  title: z.string().min(1).max(300),
  notes: z.string().max(4000).nullish(),
  dueAt: z.string().nullish(),
})
export type ExtractedTodo = z.infer<typeof extractedTodoSchema>
