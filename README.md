# FuncleApp

FuncleApp is a static vanilla HTML/CSS/JS brew-day assistant for Funcleson Brew Works. The app is optimized for real brew sessions, especially mobile iPhone use, while still supporting local-only testing and hosted Firebase-backed persistence.

## Current Shape

- Source-of-truth repo path: `C:\Dev\FuncleApp`
- GitHub remote: `https://github.com/Pulpers859/FuncleApp.git`
- Deployment target: static site, suitable for drag/drop Netlify deploys
- Hosted persistence: Firebase Auth + Firestore
- Local fallback: browser `localStorage`

## Top-Level App Files

- `index.html`: app layout, tabs, containers, and script/style wiring
- `styles.css`: visual system, responsive behavior, and component styling
- `app.js`: app state, rendering, persistence, workflow logic, timers, archive flow, and BrewMate behavior
- `brew-logic.js`: reusable brewing math and estimators
- `icon-180.png`, `icon-192.png`, `icon-512.png`: installable web app icons

## Repo Support Files

- `PROJECT_HANDOFF.md`: project-specific operating instructions for the next agent
- `.githooks/pre-commit`: blocks direct commits to `main`
- `docs/legacy/FuncleApp_Brewday_Handoff_Updated_v2.txt`: preserved earlier handoff/context notes

## Working Rules

- Keep the static deploy files at the repo root unless there is a deliberate deploy-path change.
- Preserve local-only boot behavior even if Firebase is unavailable.
- Do not break recipe save/load, timer editing, BIAB workflow continuity, or archive loop-back behavior.
- Keep brewing formulas in `brew-logic.js` rather than scattering them through UI code.
- Prefer normal feature work on `dev`, not `main`.

## Local Use

You can test the app by opening `index.html` directly in a browser, though hosted Firebase sign-in should be tested from an authorized hosted origin such as Netlify.

## Deployment Notes

- Current HTML references icons at the site root.
- The app is intentionally framework-free and requires no npm or build step.
- JSON export/import should remain the primary backup/restore path for recipes and brew records.
