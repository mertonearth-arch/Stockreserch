# Published artifact

Cadence Desk — the daily dashboard. Redeploy to THIS url every run, never publish fresh.

    https://claude.ai/code/artifact/4f1b117b-f896-41db-a671-41acba48a2bd

Publish call: Artifact tool with `file_path: dashboard.html` AND `url:` set to the link
above. Title stays "Cadence Desk", favicon stays the same.

First published 2026-08-30.

# Riskkarta 3D

Separate artifact, not part of the daily passes. Rebuild with `node bin/build-riskmap.js`
(template: `lib/riskmap.template.html`), then redeploy `riskmap.html` to THIS url:

    https://claude.ai/artifact/5qF86MHNjqPqcZtRb8GGWa

Capabilities stay `db` + `user` (each viewer's own estimates are saved per account).
First published 2026-11-15.
