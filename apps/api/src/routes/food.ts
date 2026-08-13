import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getUsdaFood, searchUsdaFoods } from '../lib/usda-fdc.js'
import { requireUser } from './auth.js'

const searchQuery = z.object({
  q: z.string().trim().min(1).max(120),
})

const foodParams = z.object({
  fdcId: z.coerce.number().int().positive(),
})

export async function foodRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireUser)

  app.get('/food/search', async (request, reply) => {
    const parsed = searchQuery.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid search', issues: parsed.error.issues })
    }
    try {
      const results = await searchUsdaFoods(parsed.data.q)
      return { results }
    } catch (err) {
      request.log.warn({ err }, 'USDA food search failed')
      return reply.code(502).send({ error: 'Could not search the USDA food database.' })
    }
  })

  app.get('/food/:fdcId', async (request, reply) => {
    const parsed = foodParams.safeParse(request.params)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid food id' })
    }
    try {
      const food = await getUsdaFood(parsed.data.fdcId)
      if (!food) return reply.code(404).send({ error: 'Food not found' })
      return { food }
    } catch (err) {
      request.log.warn({ err }, 'USDA food lookup failed')
      return reply.code(502).send({ error: 'Could not load that food from USDA.' })
    }
  })
}
