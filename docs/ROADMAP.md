# Product roadmap

MedicalBot is the organized copy of your health that you keep for yourself: a log
that remembers, a pattern-spotter, and a visit-prep tool. It does not diagnose,
prescribe, change doses, or screen messages for crisis keywords.

This list is the work that still closes that gap. Phased build docs stay in
[phases/](phases/README.md); this file is the product sequence.

| Priority | Item | Why | Status |
|----------|------|-----|--------|
| 1 | **90-day visit prep packet** | The promise people feel: walk into a visit with one sheet | Shipped |
| 2 | **Declared patterns actually fire** | Module trends (“eGFR trending down”) are copy until a job evaluates them | Next |
| 3 | **Weekly digest** | Seven days of adherence, time-in-range, new labs, limit crossings | Later |
| 4 | **Calendar as the reminder channel** | Med and glucose nudges as events with phone alarms; adherence is the highest-value signal | Later |
| 5 | **Lab ↔ metric join** | Imported labs fill the rows modules already track (A1C done; glucose, creatinine, potassium, lipids still split) | Later |
| 6 | **Scheduled assessments** | PHQ-9 / GAD-7 / diabetes distress / adherence on a cadence, scores on the same charts as glucose | Later |
| 7 | **Adaptive check-ins** | Short assistant prompts from *your* modules and last week’s data | Later |

Not on this list until 1–2 exist: extra condition modules, BMI, device APIs.

**Open product decision:** this stays a personal tool, or it holds other people’s
data (HIPAA, BAAs, different hosting). Decide before building for anyone else.
See [SPEC.md §9](../SPEC.md) and the README “Before this holds anyone else’s data”.
