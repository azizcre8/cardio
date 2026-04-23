# Cardio Workspace

This workspace contains one active product app and a small set of legacy reference files.

## Canonical app

The live app is the Next.js project in [`/cardio`](/Users/sajedaziz/Documents/Claude/pdf/cardio).

- Local development happens in `cardio`
- Production deployment should use `cardio` as the project root
- The public site is `/`
- The authenticated app is `/app`

## Legacy files

Older standalone HTML prototypes have been moved to [`/legacy`](/Users/sajedaziz/Documents/Claude/pdf/legacy).
They are references only and should not be used as deploy targets.

## Working rules

- When using Codex or Claude, explicitly say: `Work only in /Users/sajedaziz/Documents/Claude/pdf/cardio`
- Run app commands from `cardio`
- Treat root-level deploy config as wrappers that point to `cardio`

See [`LAUNCH_WORKFLOW.md`](/Users/sajedaziz/Documents/Claude/pdf/LAUNCH_WORKFLOW.md) for the canonical build, cleanup, and deployment workflow.
