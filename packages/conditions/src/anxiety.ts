import type { ConditionModule } from './types.js'

/**
 * Generalized anxiety / anxiety disorders.
 *
 * Daily mood and anxiety scores are what people forget between appointments;
 * GAD-7 (and PHQ-9 for common comorbidity) give a periodic severity snapshot.
 * No physiological red flags here — score thresholds would interpret the user's
 * own feelings, which this platform avoids. Sleep still charts because it
 * often moves with anxiety before someone notices.
 */
export const anxiety: ConditionModule = {
  key: 'anxiety',
  label: 'Anxiety',
  summary:
    'Tracks daily anxiety and mood, sleep, and periodic GAD-7 / PHQ-9 scores. Useful for spotting patterns between appointments.',
  metrics: [
    { type: 'anxiety', dailyPrompts: 1, targetMin: 0, targetMax: 4 },
    { type: 'mood', dailyPrompts: 1, targetMin: 4, targetMax: 10 },
    { type: 'sleep_hours', dailyPrompts: 0, targetMin: 6, targetMax: 10 },
    { type: 'sleep_quality', dailyPrompts: 0, targetMin: 5, targetMax: 10 },
    { type: 'questionnaire_score', dailyPrompts: 0, targetMin: null, targetMax: null },
  ],
  questionnaireKeys: ['gad7', 'phq9'],
  redFlags: [],
  trends: [
    {
      id: 'rising_anxiety',
      description: 'Daily anxiety scores climbing',
      detect: 'Average anxiety score over 7 days higher than the prior 7 days by 2+ points.',
      eval: {
        metric: 'anxiety',
        kind: 'avg_vs_prior',
        windowDays: 7,
        priorDays: 7,
        threshold: 2,
        direction: 'up',
      },
    },
    {
      id: 'sleep_anxiety_link',
      description: 'Poor sleep lining up with higher anxiety',
      detect: 'Days with sleep under 6 hours correlating with higher same-day or next-day anxiety scores.',
    },
    {
      id: 'gad7_trend',
      description: 'GAD-7 severity changing across administrations',
      detect: 'GAD-7 total moving up or down across 2+ consecutive administrations.',
    },
  ],
  promptGuidance: `The user has an anxiety condition. When they log mood or anxiety, record the \
score and any context they offer — do not reinterpret how they feel or suggest they are \
"getting worse." Never recommend starting, stopping, or changing psychiatric medication. \
You may help them prepare questions for their therapist or psychiatrist from their own data.`,
}
