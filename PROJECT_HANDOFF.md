# FuncleApp Project Handoff

## Project Identity

- Project name: `FuncleApp`
- Project type: `web app`
- Source-of-truth repo path: `C:\Dev\FuncleApp`
- Stale/old copies to ignore if applicable: `None known locally; do not create alternate working copies outside C:\Dev\FuncleApp without a deliberate migration`
- Primary target for normal work if multiple surfaces exist: `the static brew-day web app`
- GitHub intent/status: `remote exists and should track this local repo`
- GitHub remote: `https://github.com/Pulpers859/FuncleApp.git`

## Repo State

- Stable branch: `main`
- Working branch: `main`
- Expected default branch for normal work: `main`
- Sync-first rule: `Before normal work, fetch from the remote first. If the working tree is clean and the active branch tracks the expected upstream, pull with --ff-only before editing. If local changes exist, fetch and reconcile instead of blindly pulling.`
- If Git is not set up yet for this project, the agent should bootstrap it before doing major feature work.

## If No Git Exists Yet

If `git rev-parse --is-inside-work-tree` fails in the real project root, the agent should help set up the repo using this standard:

1. Confirm the real project root.
2. Keep the project at `C:\Dev\FuncleApp` because it already matches the preferred source-of-truth location.
3. Initialize local Git.
4. Create a focused `.gitignore`.
5. Create `.gitattributes` enforcing LF for code files.
6. Set repo-local config:
   - `core.autocrlf=false`
   - `core.eol=lf`
   - `pull.ff=only`
   - `fetch.prune=true`
   - `core.hooksPath=.githooks`
7. Add repo-local aliases:
   - `git st` -> `status -sb`
   - `git lg` -> `log --oneline --graph --decorate --all --date=short`
8. Create the initial commit.
9. Run a secret scan and remove any live credentials from tracked files before connecting or pushing GitHub.
10. Connect the GitHub remote if needed.
11. Push `main`.
12. Create a dedicated PowerShell shortcut for this project if the user wants one.

If the GitHub remote is unknown, the agent should finish local bootstrap first and only ask for the remote when push/setup is actually needed.

## PowerShell / Terminal Standard

- Do not globally pin every PowerShell session to this project.
- A dedicated shortcut may exist:
  - `FuncleApp PowerShell`
- That shortcut should open directly in `C:\Dev\FuncleApp`.
- Avoid fragile startup command strings if the path contains apostrophes or quoting hazards.

## How The Agent Should Operate

- Inspect before assuming.
- Work in the source-of-truth repo only.
- Sync from GitHub before normal work so the local repo is not stale.
- Fix root causes, not surface symptoms.
- Be honest and direct.
- Prefer architecture/data-flow fixes over hacks.
- Do not use brittle hardcoded special cases or band-aid fixes unless you explicitly explain why a deeper fix is not practical.
- Be proactive: inspect, diagnose, edit code directly, verify, and then audit nearby weaknesses.
- Do not stop at the first fix if adjacent code is obviously fragile.
- Tell the user clearly what is evidence-backed, proven, inferred, or heuristic.
- Do not silently tolerate poor architecture if it is now a maintenance risk.
- Handle Git operations when appropriate.
- Keep normal work on `main` unless the user explicitly asks for a temporary branch-based workflow.
- Before editing on an existing repo, run a fetch and check ahead/behind state; if clean, pull the tracked branch with `--ff-only`.
- Audit adjacent risks after making fixes.
- Run the checks that are realistically available in the current environment.
- Treat secrets as local-only by default; use tracked example files and ignored real config files whenever possible.

## Communication Style

- Warm, collaborative, calm, disciplined
- High-effort and thoughtful
- Short progress updates while working
- Clear reasoning, no fluff, no fake certainty
- If the agent misses something, it should own it directly

## Post-Fix Audit Standard

After making changes, the agent should do another harsh pass focused on:

- root-cause completeness
- adjacent fragility
- architecture quality
- validation or rule correctness
- progression and workflow coherence
- silent failure risk
- wasted retries or wasted work
- maintainability

## What The User Wants By Default

- The user describes the problem in chat.
- The agent syncs from the tracked remote branch first so local files are current before investigation or edits.
- The agent investigates directly.
- The agent makes code changes directly.
- The agent audits adjacent risks.
- The agent runs local checks where possible.
- The agent handles Git steps when appropriate.
- The user should not need to babysit PowerShell, Git, or GitHub for normal work.

## Before Starting Any New Task

The agent should confirm:

1. current repo path
2. current branch
3. repo status cleanliness
4. remote configuration
5. whether the local branch is behind the remote and needs fetch/pull
6. whether stale copies exist elsewhere
7. whether the active folder is truly the source of truth

## Architecture / Product Notes

- Main product purpose: `A warm, practical, mobile-friendly brew-day cockpit for recipe planning, live brew execution, timers, packaging, archive history, and BrewMate concept mentoring.`
- Key modules or directories:
  - `index.html`
  - `styles/styles.css`
  - `scripts/app.js`
  - `scripts/brew-logic.js`
  - `assets/icons/`
  - `docs/`
- Known fragile areas:
  - `scripts/app.js` is still a large single runtime file even though the app is no longer a one-file HTML build.
  - Local-only boot and hosted Firebase boot must both keep working.
  - Timer preset inputs must remain editable without render loops overwriting focused input values.
  - Recipe persistence, archive loop-back, and BrewMate-to-Recipe flow are high-value paths.
  - Static asset paths must stay relative so local file testing and hosted deployment both keep working.
- Important evidence/product constraints:
  - Preserve recipe save/load behavior.
  - Preserve BIAB-first workflow continuity.
  - Preserve timer usability.
  - Keep mobile usability first, especially iPhone behavior.
  - Keep BrewMate structured and local-first, not a fake remote chatbot.
  - Keep the app static and framework-free unless the user explicitly requests a migration.
- Runtime environments that matter:
  - `mobile Safari`
  - `desktop browser`
  - `Netlify hosted static app`
  - `Firebase Auth + Firestore hosted mode`
  - `local-only browser mode`

## Git / Release Notes

- Preferred everyday flow:
  - `git st`
  - `git diff`
  - `git add .`
  - `git commit -m "..."`
  - `git push`
- Preferred normal sync flow on `main`:
  - `git checkout main`
  - `git pull --ff-only`
  - `git st`
  - `git push`

## Project-Specific Instructions For The Next Agent

```text
Project: FuncleApp
Active repo path: C:\Dev\FuncleApp
GitHub remote: https://github.com/Pulpers859/FuncleApp.git
Stable branch: main
Working branch: main

Important:
- Treat C:\Dev\FuncleApp as the source of truth.
- Do not work in stale copies unless explicitly asked.
- If Git is not already set up, bootstrap it using the repo standard in this file before major feature work.
- Use the standard workflow: investigate directly, fix root causes, audit adjacent risks, run checks, and handle Git when appropriate.
- Before starting normal work, fetch from origin and sync the active branch first when the working tree is clean. If the repo is dirty, fetch and reconcile instead of pulling blindly.
- This repo currently uses a main-only workflow rather than a persistent dev branch.
- The app intentionally stays static and deployable without a build system.
- Keep the deploy root simple: index.html stays at the root while runtime assets live under styles/, scripts/, and assets/icons/.
- If multiple surfaces emerge later, prioritize the brew-day app workflow before side tooling.
```
