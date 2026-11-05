# Accessibility

Read when building interactive controls, forms, dialogs, or custom widgets.

Aim for WCAG 2.2 AA unless the project states another target. Use the project's
accessible design-system components first; they usually solve focus and ARIA.

## Semantic HTML first

- Use native elements for their purpose: `button` for actions, `a href` for
  navigation, `input`/`select`/`textarea` for data, `label` for labels, `table` for
  tabular data, lists for lists.
- Never use a `div` or `span` with a click handler as a button; it lacks keyboard and
  role support.
- One `h1` per page and headings in order; landmarks (`header`, `nav`, `main`,
  `footer`) so screen-reader users can jump.
- Set the page `lang` and a meaningful document title per route.

## Keyboard

- Everything operable by mouse is operable by keyboard: Tab and Shift+Tab to move,
  Enter or Space to activate, Escape to dismiss, arrows inside composite widgets
  (menus, tabs, listboxes) per the ARIA Authoring Practices patterns.
- Tab order follows visual order. Avoid positive `tabindex`; use `tabindex="0"` only
  for custom focusable widgets and `-1` for programmatic focus targets.
- No keyboard traps, except a modal dialog trapping focus while open.
- Provide a skip link to main content on pages with long navigation.

## Focus management

- Focus must be visible; do not remove outlines without an equally visible style.
- Dialogs: move focus into the dialog on open, trap it while open, close on Escape,
  return focus to the trigger on close. Prefer the native `dialog` element or the
  project's dialog component.
- After client-side navigation, move focus to the new page heading or main region,
  or use the framework's route announcer.
- After a form error, focus the first invalid field or an error summary.
- After deleting an item, move focus to a sensible neighbor.

## ARIA only when needed

- No ARIA is better than wrong ARIA. Use it only when native HTML cannot express the
  role, state, or relationship.
- Common legitimate uses: `aria-expanded` and `aria-controls` on disclosure
  triggers, `aria-current` for the current nav item, `aria-describedby` for hints and
  errors, `aria-live` regions for async status messages, `aria-label` for icon-only
  buttons.
- A custom widget must implement the full keyboard pattern for its role; adding a
  `role` alone does not.
- Do not hide focusable content with `aria-hidden`.

## Forms

- Every input has a programmatic label (visible `label` preferred). Placeholders are
  not labels.
- Mark required fields in text and with `required` or `aria-required`.
- Associate error messages with the field (`aria-describedby`) and set
  `aria-invalid` when invalid. Do not rely on color alone.
- Group related controls with `fieldset` and `legend`.
- Use correct input types and `autocomplete` values.

## Visual

- Text contrast at least 4.5:1 (3:1 for large text); UI component and focus
  indicator contrast at least 3:1. Use the project's tokens; report token failures to
  ui-design rather than inventing colors.
- Do not convey information by color alone; add text, icons, or patterns.
- Support 200% zoom and narrow viewports without loss of content or horizontal
  scrolling for text.
- Interactive targets large enough to hit (at least 24 by 24 CSS pixels).
- Respect `prefers-reduced-motion` for non-essential animation.

## Media and content

- Meaningful images have `alt` text describing their purpose; decorative images use
  `alt=""`.
- Icon-only buttons have an accessible name.
- Video has captions; audio has transcripts when the project supports it.
- Link text describes the destination; avoid "click here".

## Checking

- Operate the feature with keyboard only.
- Run the project's automated checker (for example axe-based tooling) if present;
  automated tools find only part of the issues.
- Spot-check with a screen reader when the change introduces a custom widget.
