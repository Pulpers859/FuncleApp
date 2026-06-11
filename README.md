# FuncleApp

FuncleApp is a static vanilla HTML/CSS/JS brew-day assistant for Funcleson Brew Works. The app is optimized for real brew sessions, especially mobile iPhone use, while still supporting local-only testing and hosted Firebase-backed persistence.

## Current Shape

- Source-of-truth repo path: `C:\Dev\FuncleApp`
- GitHub remote: `https://github.com/Pulpers859/FuncleApp.git`
- Deployment target: static site, suitable for drag/drop Netlify deploys
- Hosted persistence: Firebase Auth + Firestore
- Local fallback: browser `localStorage`

## Runtime Structure

- `index.html`: deploy entry point, layout, tabs, and runtime wiring
- `styles/styles.css`: visual system, responsive behavior, and component styling
- `scripts/app.js`: app state, rendering, persistence, workflow logic, timers, archive flow, and BrewMate behavior
- `scripts/brew-logic.js`: reusable brewing math and estimators
- `assets/icons/`: installable web app icons

## Support Files

- `PROJECT_HANDOFF.md`: project-specific operating instructions for the next agent
- `.githooks/pre-commit`: repo-local hook entry point for future lightweight checks
- `docs/legacy/FuncleApp_Brewday_Handoff_Updated_v2.txt`: preserved earlier handoff/context notes kept as archival reference

## Working Rules

- Keep `index.html` at the deploy root unless there is a deliberate hosting change.
- Preserve local-only boot behavior even if Firebase is unavailable.
- Do not break recipe save/load, timer editing, BIAB workflow continuity, or archive loop-back behavior.
- Keep brewing formulas in `scripts/brew-logic.js` rather than scattering them through UI code.
- Use `main` as the live working branch for this repo unless a future task explicitly introduces a short-lived side branch.

## Local Use

You can test the app by opening `index.html` directly in a browser, though hosted Firebase sign-in should be tested from an authorized hosted origin such as Netlify.

## Deployment Notes

- The app is intentionally framework-free and requires no npm or build step.
- JSON export/import should remain the primary backup/restore path for recipes and brew records.
