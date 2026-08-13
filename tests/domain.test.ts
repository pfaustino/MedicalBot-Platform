import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PHQ9, enrichLabResult, inferTimesFromText, medicationRRule, parseReferenceRange, parseUsdaFood, scaleFoodNutrition, scoreQuestionnaire, upcomingDoseSlots, zonedDate } from '@medbot/shared'
import { evaluateTrend, mergedMetrics, mergedRedFlags, modulesFor } from '@medbot/conditions'

describe('PHQ-9 scoring', () => {
  const allZero = Object.fromEntries(PHQ9.questions.map((q) => [q.id, 0]))

  it('bands a minimal score', () => {
    const result = scoreQuestionnaire(PHQ9, allZero)
    assert.equal(result.total, 0)
    assert.equal(result.band?.label, 'Minimal')
  })

  it('bands a severe score', () => {
    const answers = Object.fromEntries(PHQ9.questions.map((q) => [q.id, 3]))
    const result = scoreQuestionnaire(PHQ9, answers)
    assert.equal(result.total, 27)
    assert.equal(result.band?.severity, 'severe')
  })

  it('flags item 9 separately from the total', () => {
    // Item 9 is part of the published instrument. This surfaces it as data on
    // the result — it does not trigger any interstitial or canned response.
    const result = scoreQuestionnaire(PHQ9, { ...allZero, q9: 1 })
    assert.equal(result.total, 1)
    assert.equal(result.band?.label, 'Minimal')
    assert.deepEqual(result.criticalTriggered, ['q9'])
  })
})

describe('trend evaluation', () => {
  it('fires when a 7-day average rises vs the prior week', () => {
    const now = new Date('2026-08-13T12:00:00Z')
    const readings = []
    for (let d = 1; d <= 14; d++) {
      const recordedAt = new Date(+now - (14 - d) * 24 * 60 * 60 * 1000)
      readings.push({
        type: 'anxiety',
        value: d <= 7 ? 2 : 5,
        recordedAt,
        context: null,
      })
    }
    const result = evaluateTrend(
      {
        id: 'rising_anxiety',
        description: 'Daily anxiety scores climbing',
        detect: 'test',
        eval: {
          metric: 'anxiety',
          kind: 'avg_vs_prior',
          windowDays: 7,
          priorDays: 7,
          threshold: 2,
          direction: 'up',
        },
      },
      readings,
      now,
    )
    assert.equal(result.status, 'firing')
  })

  it('fires eGFR decline from lab_value context aliases', () => {
    const now = new Date('2026-08-13T12:00:00Z')
    const result = evaluateTrend(
      {
        id: 'egfr_decline',
        description: 'eGFR trending down',
        detect: 'test',
        eval: {
          metric: 'lab_value',
          context: 'eGFR',
          kind: 'latest_vs_earliest',
          windowDays: 90,
          threshold: 5,
          direction: 'down',
        },
      },
      [
        {
          type: 'lab_value',
          value: 32,
          recordedAt: new Date('2026-06-01T12:00:00Z'),
          context: 'Estimated GFR',
        },
        {
          type: 'lab_value',
          value: 22,
          recordedAt: new Date('2026-08-01T12:00:00Z'),
          context: 'eGFR',
        },
      ],
      now,
    )
    assert.equal(result.status, 'firing')
    assert.match(result.detail ?? '', /32/)
  })
})

describe('condition module merging', () => {
  const modules = modulesFor(['diabetes_t2', 'schizophrenia'])

  it('loads both modules', () => {
    assert.equal(modules.length, 2)
  })

  it('takes the stricter glucose ceiling across conditions', () => {
    // Diabetes allows up to 180; the schizophrenia metabolic watch caps at 140.
    const glucose = mergedMetrics(modules).find((m) => m.type === 'blood_glucose')
    assert.equal(glucose?.targetMax, 140)
    assert.equal(glucose?.targetMin, 80)
  })

  it('keeps the higher prompt frequency', () => {
    const glucose = mergedMetrics(modules).find((m) => m.type === 'blood_glucose')
    assert.equal(glucose?.dailyPrompts, 2)
  })

  it('preserves red flags from both modules', () => {
    const flags = mergedRedFlags(modules)
    assert.ok(flags.some((f) => f.id === 'severe_hypo'))
    assert.ok(flags.some((f) => f.id === 'severe_side_effect'))
  })

  it('returns nothing for a condition with no module yet', () => {
    assert.deepEqual(modulesFor(['copd']), [])
  })
})

describe('lab import (BMP template)', () => {
  it('parses portal reference ranges', () => {
    const sodium = parseReferenceRange('135 - 146 mmol/L')
    assert.equal(sodium?.low, 135)
    assert.equal(sodium?.high, 146)
    assert.equal(sodium?.unit, 'mmol/L')

    const creatinine = parseReferenceRange('0.60 - 1.30 mg/dL')
    assert.equal(creatinine?.low, 0.6)
    assert.equal(creatinine?.high, 1.3)
  })

  it('enriches BMP rows with LOINC and flags', () => {
    const row = enrichLabResult({
      testName: 'Urea Nitrogen',
      value: '37',
      referenceText: '7 - 22 mg/dL',
      panelName: 'Basic Metabolic Panel',
      collectedAt: '2026-04-21',
    })
    assert.equal(row.loinc, '3094-0')
    assert.equal(row.flag, 'high')
    assert.equal(row.referenceLow, 7)
    assert.equal(row.referenceHigh, 22)
    assert.equal(row.unit, 'mg/dL')
  })

  it('handles qualitative GFR comment rows', () => {
    const row = enrichLabResult({
      testName: 'GFR Additional Information',
      value: 'See Comment',
      referenceText: 'See GFR Additional Information',
      panelName: 'Basic Metabolic Panel',
      collectedAt: '2026-07-14',
    })
    assert.equal(row.flag, 'abnormal')
    assert.equal(row.note, 'See comment on lab report')
  })
})

describe('dose schedule expansion', () => {
  const twiceDaily = {
    kind: 'fixed_times' as const,
    times: ['08:00', '20:00'],
    intervalHours: null,
    daysOfWeek: [] as number[],
    cycleOnDays: null,
    cycleOffDays: null,
    withFood: false,
    instructions: null,
  }

  it('emits a daily RRULE for fixed times with no weekday filter', () => {
    assert.equal(medicationRRule(twiceDaily), 'RRULE:FREQ=DAILY')
  })

  it('emits weekly BYDAY and UNTIL when set', () => {
    assert.equal(
      medicationRRule({ ...twiceDaily, daysOfWeek: [1, 3, 5] }, '2026-12-31'),
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261231',
    )
  })

  it('expands two slots on a weekday in America/New_York', () => {
    const from = zonedDate('America/New_York', 2026, 8, 13, 0, 0)
    const to = zonedDate('America/New_York', 2026, 8, 13, 23, 59)
    const slots = upcomingDoseSlots(twiceDaily, { timeZone: 'America/New_York', from, to })
    assert.deepEqual(
      slots.map((s) => s.time),
      ['08:00', '20:00'],
    )
  })

  it('respects daysOfWeek', () => {
    const from = zonedDate('America/New_York', 2026, 8, 15, 0, 0) // Saturday
    const to = zonedDate('America/New_York', 2026, 8, 15, 23, 59)
    const slots = upcomingDoseSlots(
      { ...twiceDaily, daysOfWeek: [1, 3, 5] },
      { timeZone: 'America/New_York', from, to },
    )
    assert.equal(slots.length, 0)
  })

  it('skips as-needed schedules with no frequency text', () => {
    assert.equal(medicationRRule({ ...twiceDaily, kind: 'as_needed', times: [] }), null)
  })

  it('infers twice-daily times from imported frequency text', () => {
    assert.deepEqual(inferTimesFromText('Twice daily with meals'), ['08:00', '20:00'])
    const slots = upcomingDoseSlots(
      {
        ...twiceDaily,
        kind: 'as_needed',
        times: [],
        instructions: 'BID',
      },
      {
        timeZone: 'America/New_York',
        from: zonedDate('America/New_York', 2026, 8, 13, 0, 0),
        to: zonedDate('America/New_York', 2026, 8, 13, 23, 59),
      },
    )
    assert.deepEqual(
      slots.map((s) => s.time),
      ['08:00', '20:00'],
    )
  })

  it('does not infer times for true PRN text', () => {
    assert.deepEqual(inferTimesFromText('as needed for pain'), [])
  })
})

describe('USDA food portion scaling', () => {
  const banana = parseUsdaFood({
    fdcId: 173944,
    description: 'Bananas, raw',
    dataType: 'SR Legacy',
    foodNutrients: [
      { nutrientId: 1008, value: 89 },
      { nutrientId: 2000, value: 12.2 },
      { nutrientId: 1005, value: 22.8 },
      { nutrientId: 1079, value: 2.6 },
    ],
    foodPortions: [{ id: 1, amount: 1, gramWeight: 118, modifier: 'medium' }],
  })

  it('parses per-100g nutrients and household portions', () => {
    assert.ok(banana)
    assert.equal(banana.basisGrams, 100)
    assert.equal(banana.calories, 89)
    assert.equal(banana.sugarsG, 12.2)
    const medium = banana.portions.find((p) => p.grams === 118)
    assert.ok(medium)
    const scaled = scaleFoodNutrition(banana, medium, 1)
    assert.equal(scaled.calories, 105)
    assert.equal(scaled.netSugarG, 14.4)
    assert.equal(scaled.sugarSource, 'sugars')
    assert.equal(scaled.grams, 118)
  })

  it('falls back to carbs minus fiber when sugars are missing', () => {
    const oats = parseUsdaFood({
      fdcId: 1,
      description: 'Oats',
      dataType: 'Foundation',
      foodNutrients: [
        { nutrient: { id: 1008 }, amount: 389 },
        { nutrient: { id: 1005 }, amount: 66 },
        { nutrient: { id: 1079 }, amount: 11 },
      ],
    })
    assert.ok(oats)
    const hundred = oats.portions.find((p) => p.id === '100g')
    assert.ok(hundred)
    const scaled = scaleFoodNutrition(oats, hundred, 1)
    assert.equal(scaled.netSugarG, 55)
    assert.equal(scaled.sugarSource, 'carbs_minus_fiber')
  })

  it('prefers USDA sequence order and skips unspecified quantities', () => {
    const food = parseUsdaFood({
      fdcId: 3,
      description: 'Banana, raw',
      dataType: 'Survey (FNDDS)',
      foodNutrients: [{ nutrient: { id: 1008 }, amount: 97 }],
      foodPortions: [
        { id: 2, gramWeight: 225, portionDescription: '1 cup, mashed', sequenceNumber: 4 },
        { id: 1, gramWeight: 126, portionDescription: '1 banana', sequenceNumber: 1 },
        { id: 3, gramWeight: 999, portionDescription: 'Quantity not specified', sequenceNumber: 6 },
      ],
    })
    assert.ok(food)
    const household = food.portions.filter((p) => p.id.startsWith('p:'))
    assert.equal(household[0]?.label, '1 banana (126 g)')
    assert.equal(household.length, 2)
  })

  it('scales branded foods from the labeled serving', () => {
    const yogurt = parseUsdaFood({
      fdcId: 2,
      description: 'GREEK YOGURT',
      dataType: 'Branded',
      brandOwner: 'Example',
      servingSize: 150,
      servingSizeUnit: 'g',
      householdServingFullText: '1 container',
      foodNutrients: [
        { nutrientId: 1008, value: 120 },
        { nutrientId: 2000, value: 6 },
      ],
    })
    assert.ok(yogurt)
    assert.equal(yogurt.basisGrams, 150)
    const serving = yogurt.portions.find((p) => p.id === 'serving')
    assert.ok(serving)
    const one = scaleFoodNutrition(yogurt, serving, 1)
    assert.equal(one.calories, 120)
    assert.equal(one.netSugarG, 6)
    const hundred = yogurt.portions.find((p) => p.id === '100g')
    assert.ok(hundred)
    const per100 = scaleFoodNutrition(yogurt, hundred, 1)
    assert.equal(per100.calories, 80)
    assert.equal(per100.netSugarG, 4)
  })
})
