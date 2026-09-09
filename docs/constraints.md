# Constraint observations

| Observation | Evidence and interpretation |
| --- | --- |
| Native browser and command tools available in one iPhone session | User-pasted capability report. This is a session observation, not a general account/platform guarantee. |
| Native 120-second process and original handle recoverable | User reported run e03bf7e8-a624-44e8-aca6-20fd3daa676b, 24 heartbeats, 26 readable records, exit code 0 through handle 25107. The worker completed; continued model reasoning and fresh-chat recovery were not demonstrated. |
| ChatGPT scratch can disappear | User has experienced deletion. Treat scratch as disposable; persist operational facts and artifacts in Praxis. No fixed lifetime has been inferred. |
| Remote Praxis job recovery | Separate VPS worker plus durable SQLite state. Hosted verification evidence is recorded in acceptance.md. |
| Actual ChatGPT remote connection | Native owner OAuth and all nine tools discovered in ChatGPT web settings. Initial empty actions required Refresh. Actual iPhone availability, approval behavior, response limits, and model tool selection remain unverified; Claude is not yet exercised. |
| Native OAuth form behavior differs from scripted HTTP clients | Actual ChatGPT connection reached the owner form, then native POST failed the origin check. The page used no-referrer, which makes browser form submissions send Origin:null. The scripted test supplied Origin explicitly and missed this. Use strict-origin for the form, retain exact-origin/CSRF checks, and verify the real browser flow. |

The eventual replay eval should use historical prompts and starting revisions, keep the expected final implementation hidden from the worker, compare behavior and tests rather than exact diffs, and record tool calls/results/timings/errors alongside code outcomes. It should simulate observed restrictions and failures, with an unrestricted reference run where practical. This probe does not access hidden reasoning traces or implement that eval harness yet.
