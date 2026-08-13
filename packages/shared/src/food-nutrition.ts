/**
 * USDA FoodData Central numbers scaled to a chosen portion.
 * These are published food-composition estimates, not a lab result or a diet.
 */

export const FOOD_PORTION_CUSTOM_GRAMS = 'grams'
export const FOOD_PORTION_HUNDRED_G = '100g'
export const FOOD_PORTION_SERVING = 'serving'

export interface FoodPortion {
  id: string
  label: string
  /** Gram weight of one of this portion. Null when USDA only published a serving, not grams. */
  grams: number | null
  /** How many labeled servings one of this portion is (usually 1). */
  servings: number
}

export interface FoodNutrition {
  fdcId: number
  name: string
  brand: string | null
  dataType: string
  /**
   * Nutrients below are for this many grams. Null means they are for one labeled
   * serving and we do not know the gram weight.
   */
  basisGrams: number | null
  calories: number | null
  sugarsG: number | null
  carbsG: number | null
  fiberG: number | null
  portions: FoodPortion[]
}

export type SugarSource = 'sugars' | 'carbs_minus_fiber'

export interface ScaledFoodNutrition {
  calories: number | null
  netSugarG: number | null
  sugarSource: SugarSource | null
  grams: number | null
}

const ENERGY_KCAL_IDS = new Set([1008, 2047, 2048])
const ENERGY_KJ_IDS = new Set([1062])
const SUGAR_IDS = new Set([2000, 1063])
const FIBER_IDS = new Set([1079])
const CARB_IDS = new Set([1005])
const GRAMISH_UNITS = new Set(['g', 'grm', 'gram', 'grams', 'ml', 'mlt'])

export function netSugarFromMacros(
  food: Pick<FoodNutrition, 'sugarsG' | 'carbsG' | 'fiberG'>,
): { value: number | null; source: SugarSource | null } {
  if (food.sugarsG != null) return { value: food.sugarsG, source: 'sugars' }
  if (food.carbsG != null) return { value: Math.max(0, food.carbsG - (food.fiberG ?? 0)), source: 'carbs_minus_fiber' }
  return { value: null, source: null }
}

export function scaleFoodNutrition(
  food: FoodNutrition,
  portion: FoodPortion,
  amount: number,
): ScaledFoodNutrition {
  const sugar = netSugarFromMacros(food)
  if (!(amount >= 0) || Number.isNaN(amount)) {
    return { calories: null, netSugarG: null, sugarSource: sugar.source, grams: null }
  }

  let factor: number | null = null
  let grams: number | null = null
  if (food.basisGrams != null && food.basisGrams > 0 && portion.grams != null) {
    grams = portion.grams * amount
    factor = grams / food.basisGrams
  } else if (portion.servings > 0) {
    factor = portion.servings * amount
    grams = food.basisGrams != null ? food.basisGrams * factor : null
  }

  if (factor == null) {
    return { calories: null, netSugarG: null, sugarSource: sugar.source, grams }
  }

  return {
    calories: roundCalories(scale(food.calories, factor)),
    netSugarG: roundTenths(scale(sugar.value, factor)),
    sugarSource: sugar.source,
    grams: grams == null ? null : roundTenths(grams),
  }
}

export function formatFoodLogNote(food: FoodNutrition, portion: FoodPortion, amount: number): string {
  const qty = amount === 1 ? portion.label : `${trimNumber(amount)} × ${portion.label}`
  const brand = food.brand ? ` — ${food.brand}` : ''
  return `${food.name}${brand} (${qty})`
}

/**
 * Turn a USDA food detail (or search hit with nutrients) into the shape the
 * logger scales. Unknown nutrient shapes are skipped rather than guessed.
 */
export function parseUsdaFood(raw: unknown): FoodNutrition | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const fdcId = Number(rec.fdcId)
  const name = String(rec.description ?? rec.lowercaseDescription ?? '').trim()
  if (!Number.isInteger(fdcId) || fdcId <= 0 || !name) return null

  const dataType = String(rec.dataType ?? '').trim() || 'Unknown'
  const brand = nonempty(rec.brandOwner) ?? nonempty(rec.brandName)
  const nutrients = Array.isArray(rec.foodNutrients) ? rec.foodNutrients : []
  const calories = energyKcal(nutrients)
  const sugarsG = firstNutrient(nutrients, SUGAR_IDS)
  const carbsG = firstNutrient(nutrients, CARB_IDS)
  const fiberG = firstNutrient(nutrients, FIBER_IDS)

  const brandedServingG = brandedServingGrams(rec)
  const isBranded = dataType.toLowerCase() === 'branded'
  const basisGrams = isBranded ? brandedServingG : 100
  const portions = buildPortions(rec, basisGrams, brandedServingG)

  return {
    fdcId,
    name,
    brand,
    dataType,
    basisGrams,
    calories,
    sugarsG,
    carbsG,
    fiberG,
    portions,
  }
}

export function dataTypeRank(dataType: string): number {
  const key = dataType.trim().toLowerCase()
  if (key === 'foundation') return 0
  if (key === 'sr legacy') return 1
  if (key === 'survey (fndds)') return 2
  if (key === 'branded') return 3
  return 4
}

function buildPortions(
  rec: Record<string, unknown>,
  basisGrams: number | null,
  brandedServingG: number | null,
): FoodPortion[] {
  const portions: FoodPortion[] = []
  const seenGrams = new Set<string>()

  function add(portion: FoodPortion): void {
    const key = portion.grams == null ? `s:${portion.servings}:${portion.label}` : `g:${roundTenths(portion.grams)}`
    if (seenGrams.has(key)) return
    seenGrams.add(key)
    portions.push(portion)
  }

  const household = nonempty(rec.householdServingFullText)
  if (brandedServingG != null && brandedServingG > 0) {
    add({
      id: FOOD_PORTION_SERVING,
      label: household ? `${household} (${trimNumber(brandedServingG)} g)` : `1 serving (${trimNumber(brandedServingG)} g)`,
      grams: brandedServingG,
      servings: 1,
    })
  } else if (household || String(rec.dataType ?? '').toLowerCase() === 'branded') {
    add({
      id: FOOD_PORTION_SERVING,
      label: household ?? '1 serving',
      grams: null,
      servings: 1,
    })
  }

  const rawPortions = Array.isArray(rec.foodPortions) ? [...rec.foodPortions] : []
  rawPortions.sort((a, b) => {
    const left = Number((a as { sequenceNumber?: unknown })?.sequenceNumber)
    const right = Number((b as { sequenceNumber?: unknown })?.sequenceNumber)
    return (Number.isFinite(left) ? left : 999) - (Number.isFinite(right) ? right : 999)
  })
  for (const item of rawPortions) {
    const parsed = parseUsdaPortion(item)
    if (parsed) add(parsed)
  }

  if (basisGrams != null && basisGrams > 0) {
    add({
      id: FOOD_PORTION_HUNDRED_G,
      label: '100 g',
      grams: 100,
      servings: basisGrams === 100 ? 1 : 100 / basisGrams,
    })
    add({
      id: FOOD_PORTION_CUSTOM_GRAMS,
      label: 'Grams',
      grams: 1,
      servings: 1 / basisGrams,
    })
  }

  return portions
}

function parseUsdaPortion(raw: unknown): FoodPortion | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const grams = Number(rec.gramWeight)
  if (!Number.isFinite(grams) || grams <= 0) return null
  const described = nonempty(rec.portionDescription)
  if (described && /quantity not specified/i.test(described)) return null
  const amount = Number(rec.amount)
  const qty = Number.isFinite(amount) && amount > 0 ? amount : 1
  const unit = measureName(rec.measureUnit)
  const modifierRaw = nonempty(rec.modifier)
  const modifier = modifierRaw && /^\d+$/.test(modifierRaw) ? null : modifierRaw
  const assembled = [qty === 1 ? '1' : trimNumber(qty), unit, modifier].filter(Boolean).join(' ').trim()
  const head = described ?? (assembled || 'Serving')
  const id = String(rec.id ?? `${grams}-${head}`)
  return {
    id: `p:${id}`,
    label: `${head} (${trimNumber(grams)} g)`,
    grams,
    servings: 1,
  }
}

function brandedServingGrams(rec: Record<string, unknown>): number | null {
  const size = Number(rec.servingSize)
  if (!Number.isFinite(size) || size <= 0) return null
  const unit = String(rec.servingSizeUnit ?? '').trim().toLowerCase()
  if (unit && !GRAMISH_UNITS.has(unit)) return null
  return size
}

function energyKcal(nutrients: unknown[]): number | null {
  const kcal = firstNutrient(nutrients, ENERGY_KCAL_IDS)
  if (kcal != null) return kcal
  const kj = firstNutrient(nutrients, ENERGY_KJ_IDS)
  return kj == null ? null : kj / 4.184
}

function firstNutrient(nutrients: unknown[], ids: Set<number>): number | null {
  for (const item of nutrients) {
    const id = nutrientId(item)
    if (id == null || !ids.has(id)) continue
    const value = nutrientValue(item)
    if (value != null) return value
  }
  return null
}

function nutrientId(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const nested = rec.nutrient && typeof rec.nutrient === 'object'
    ? (rec.nutrient as Record<string, unknown>)
    : null
  const id = Number(rec.nutrientId ?? nested?.id)
  return Number.isInteger(id) && id > 0 ? id : null
}

function nutrientValue(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const value = Number(rec.amount ?? rec.value)
  return Number.isFinite(value) ? value : null
}

function measureName(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const name = nonempty(rec.name)
  if (!name || name.toLowerCase() === 'undetermined') return nonempty(rec.abbreviation)
  return name
}

function nonempty(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text ? text : null
}

function scale(value: number | null, factor: number): number | null {
  return value == null ? null : value * factor
}

function roundCalories(value: number | null): number | null {
  return value == null ? null : Math.round(value)
}

function roundTenths(value: number | null): number | null {
  return value == null ? null : Math.round(value * 10) / 10
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(roundTenths(value))
}
