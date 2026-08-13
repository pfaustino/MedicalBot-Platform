# MedicalBot Platform — Documentation

Design and build documentation for the platform. The authoritative product spec lives in
[SPEC.md](../SPEC.md) at the repo root.

## Build phases

The platform is delivered in six phases. Each phase produces a shippable increment.

| Phase | Name | Status |
|-------|------|--------|
| [1](phases/phase-1-foundation.md) | Foundation | **In progress** |
| [2](phases/phase-2-tracking.md) | Tracking | Not started |
| [3](phases/phase-3-assistant.md) | Assistant | Not started |
| [4](phases/phase-4-workspace.md) | Google Workspace | Not started |
| [5](phases/phase-5-intelligence.md) | Intelligence | Not started |
| [6](phases/phase-6-polish.md) | Polish | Not started |

See [phases/README.md](phases/README.md) for a one-page overview of dependencies and
exit criteria across all phases.

Product sequence (visit prep first): [ROADMAP.md](ROADMAP.md).

## Legal and messaging

- [legal/TERMS-OF-USE.md](../legal/TERMS-OF-USE.md) — user-facing Terms of Use
- [legal/PRIVACY-NOTICE.md](../legal/PRIVACY-NOTICE.md) — privacy notice
- [docs/legal/MESSAGING.md](legal/MESSAGING.md) — transparent trust messaging guide (PR, onboarding)
- [docs/product/ASSISTANT-PERSONAS.md](product/ASSISTANT-PERSONAS.md) — AI personality presets and marketing copy
- [docs/product/HEALTH-RECORD.md](product/HEALTH-RECORD.md) — full health record domains, glossaries, and Amy context

## Related repos

- **[medbot](https://github.com/seed0001/medbot)** — working prototype (diabetes-focused
  logger with AI chat, reminders, and reports). Serves as a reference for agent tools,
  scheduler behavior, and voice-first UX patterns. Does not use Google Workspace APIs;
  reminders run via SMTP and in-app chat.
