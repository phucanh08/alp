# Interaction states and motion

Read when specifying states for interactive elements or views, or defining motion.

## Control states

Specify each applicable state for every interactive element. A state table per component
is the expected output.

| State | Purpose | Requirements |
|---|---|---|
| Default | Resting appearance | Recognizable as interactive without hover |
| Hover | Pointer affordance | Subtle change; never the only cue; not required on touch |
| Focus-visible | Keyboard location | Visible indicator, 3:1 against adjacent colors, not obscured by sticky content |
| Active / pressed | Feedback on press | Immediate; distinct from hover |
| Selected / checked | Persistent choice | Not color alone; use check, fill, weight or text |
| Disabled | Not available now | Explain why when possible; consider enabled-with-message instead |
| Read-only | Visible, not editable | Still focusable and copyable |
| Loading / busy | Action in progress | Prevent double submit; keep size stable; announce to assistive tech |
| Invalid / error | Input rejected | Message next to field, text plus icon, tells how to fix |
| Success | Action confirmed | Brief, non-blocking, announced |

Notes:

- Never remove focus outlines without a visible replacement.
- Focus order follows reading order; modals trap focus and return it on close.
- Disabled buttons cannot be focused in many stacks, so users cannot discover why they are
  disabled. Prefer explaining the missing requirement next to the control.
- Keep hit areas stable across states; a spinner must not resize the button.

## View states

Every data-backed view needs these designed, not only the populated one:

- **Initial loading:** skeleton matching final layout for short waits; spinner with label for
  unknown shapes. Avoid flashing a loader for very fast responses (delay showing it briefly).
- **Empty (first use):** explain what will appear and offer the primary action to create it.
- **Empty (no results):** say the filter or query produced nothing; offer to clear it.
- **Partial:** some data loaded, some failed; show what is available and mark the gap.
- **Error:** plain-language cause, what the user can do (retry, check connection, contact),
  and preserved user input. Do not show raw stack traces.
- **Offline / stale:** indicate data age and when it will refresh, if the product supports it.
- **Permission denied:** say access is missing and who can grant it, without leaking content.
- **Overflow:** long names, many items, large numbers, missing images.

## Feedback timing

- Under ~100ms: feels instant, no indicator needed.
- ~100ms to 1s: show a lightweight indicator on the control.
- Over ~1s: show progress or a loading state for the region.
- Over ~10s: show determinate progress if possible and allow cancel or background.
- Optimistic updates need a visible, reversible failure path.

## Motion

- Purpose first: motion explains spatial change, continuity or feedback. Remove decorative motion
  that serves none of these.
- Durations: about 100-200ms for small controls, 200-300ms for panels and overlays, rarely
  above 400ms. Exits slightly faster than entrances.
- Easing: ease-out for entering, ease-in for leaving, standard ease-in-out for moving on screen.
  Use the project's motion tokens.
- Animate opacity and transform; avoid animating layout properties that cause reflow.
- **Reduced motion:** when the user requests reduced motion (`prefers-reduced-motion` or the
  native setting), replace movement, parallax, zoom and auto-playing animation with an instant
  change or a short crossfade. State the reduced variant in the spec for each animation.
- No content flashes more than three times per second.
- Auto-playing or moving content lasting over 5 seconds needs pause, stop or hide.

## Announcements

- Status changes (saved, loading done, errors after submit) are announced through the stack's
  live-region or accessibility announcement mechanism, politely unless urgent.
- After a form submit with errors, move focus to the error summary or the first invalid field.
