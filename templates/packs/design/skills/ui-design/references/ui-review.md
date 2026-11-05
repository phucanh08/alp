# UI review

Read when reviewing an existing screen, component or design spec for usability,
accessibility and design-system consistency.

## Scope and method

- Review the surface named in the assignment. Do not expand to the whole application.
- Use available evidence: source (markup, styles, tokens), screenshots, design files in the repo,
  and running the app locally if the project's run command is available and permitted.
- Check with keyboard only, at narrow width, at 200% zoom, and in each supported theme when you
  can run the UI. If you cannot run it, say so and review from source; mark runtime-only items
  as unverified.
- Read-only reviewers report findings; they do not change files.

## Checklist

Hierarchy and layout
- One primary action per view; destructive actions separated and confirmed or undoable.
- Spacing and sizes come from the project's scales; no stray off-scale values.
- Alignment to a small set of edges; consistent density within a view.

Typography
- Body text readable (size, line height, measure); text scales with user settings.
- Heading levels follow structure, not visual size alone.

Color and tokens
- Components use semantic tokens, not raw values.
- Text and UI contrast meet thresholds in every theme and on every surface used.
- No meaning conveyed by color alone.

States
- Hover, focus-visible, active, disabled, loading, error, empty states present where applicable.
- Focus visible on every interactive element; logical focus order; focus returned after overlays.

Forms
- Every input has a visible, programmatically associated label; placeholders are not labels.
- Errors are specific, next to the field, and keep user input.
- Required fields marked; input types and autocomplete hints suit the data.

Accessibility semantics
- Native elements used for their roles (button, link, input) before custom roles.
- Images have meaningful alternative text or are marked decorative.
- Icon-only controls have accessible names.
- Target size at least 24x24 CSS px; content usable at 320 CSS px width.
- Reduced-motion preference respected.

Consistency
- Same pattern for the same job across the product (dialogs, toasts, tables, empty states).
- Reuses existing components instead of near-duplicates.
- Copy and terminology consistent with the rest of the product.

## Severity

| Level | Meaning | Examples |
|---|---|---|
| Blocker | A user cannot complete the task, or a legal accessibility requirement fails | Keyboard trap, unlabeled required field, text contrast 2:1 |
| Major | Task possible but error-prone or slow for many users | Missing error state, no focus indicator, primary action hidden on mobile |
| Minor | Inconsistency or friction with a workaround | Off-scale spacing, duplicate button style, weak empty state |
| Nit | Polish | Slight misalignment, icon weight mismatch |

Rank by user impact, not by effort to fix.

## Finding format

```text
[Major] Settings > Save button has no visible focus state
Where: src/components/SettingsForm.tsx:84 (class .save-btn), dark theme
Evidence: outline: none in styles/buttons.css:12; no :focus-visible rule; tabbing shows no indicator
Guideline: focus visible, 3:1 indicator contrast
Fix: add focus-visible ring using token color-focus-ring (exists in tokens.css:40)
Verified: yes (keyboard, local run) | no (source only)
```

- One finding per issue; group repeats of the same issue with a list of locations.
- Evidence is concrete: file and line, measured contrast ratio, screenshot path, or the exact
  steps used. "Looks off" is not evidence.
- Fix suggestions reuse existing tokens and components where possible.

## Report shape

Summary (surface reviewed, how it was checked, what could not be checked), findings ordered by
severity, then positives worth keeping and open questions for the owner.
