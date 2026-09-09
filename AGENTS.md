# Praxis

The current deliverable is the minimal Praxis Probe, not the complete Praxis implementation.

- The probe may execute only its built-in bounded heartbeat fixture. Do not add arbitrary commands or production access.
- Keep OAuth credentials and runtime state outside Git and outside ordinary development access.
- Preserve the existing Apocrypha, VPS Observer, and podcast services. Only a validated graceful nginx reload and Praxis Probe service changes are in scope.
- Keep jobs independent of MCP requests and application restarts. Never rerun an ambiguously completed job.
- Run `npm test` and exercise authenticated MCP calls before deploying.
- Record actual evidence and distinguish native-client, API-client, fixture, and production results.
