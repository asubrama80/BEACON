# CLAUDE.md — BEACON Project Rules

BEACON is an incident/emergency communication and war-room platform, built incrementally as small, isolated modules. This file is the permanent rulebook for Claude Code sessions working in this repository. Read [MASTER_CHECKLIST.md](MASTER_CHECKLIST.md) for module status before starting work.

## Source of truth

- The stakeholder prototype at [docs/reference/beaconstakeholderprototype.html](docs/reference/beaconstakeholderprototype.html) is the approved UI/UX source of truth for look, feel, and functional flow.
- **Do not modify or redesign the prototype.** It is read-only reference material.
- When implementing a screen or flow, match the prototype's structure, copy, and visual design unless the user explicitly directs otherwise.

## Technology

- React + TypeScript + Vite (frontend)
- Node.js + TypeScript + Fastify (backend)
- PostgreSQL
- Drizzle ORM
- WebSocket for incident chat
- Docker / Docker Compose
- Nginx

## Architecture

- Modular monolith
- REST API
- Provider abstraction for SMS, email, and realtime collaboration
- BEACON must remain portable and deployable under any domain/cloud/provider
- No runtime dependency on corporate VPN, AD, Microsoft 365, HR, or MDM
- Contacts and application users are separate concepts
- Registered responders may access Incident War Rooms
- Guests use incident-specific temporary access
- The stakeholder prototype is the UI/UX source of truth

## Development rules

- Work on only one numbered module at a time
- Do not redesign unrelated functionality
- Preserve working functionality
- Never commit secrets
- Use environment variables for configuration
- Run lint, typecheck, tests, and build before completing a module
- Fix failures before committing
- One logical Git commit per module
- Update [MASTER_CHECKLIST.md](MASTER_CHECKLIST.md) after module completion
- Never force push
- Do not delete unrelated work
- Do not introduce unnecessary infrastructure or dependencies

## Token efficiency

- Keep implementation focused on the requested module
- Do not repeatedly summarize the entire project
- Read only files relevant to the current module where practical
- Avoid unnecessary generated documentation
- Do not implement future modules early

## Module prompts

Implementation prompts live in `claude/prompts/` and are added one at a time, only when a module is ready to start. Do not pre-generate prompts for future modules.
