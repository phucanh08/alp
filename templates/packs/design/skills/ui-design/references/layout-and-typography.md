# Layout and typography

Read when choosing grids, spacing, type scale, line length or responsive breakpoints.

## Spacing scale

- One base unit, usually 4px or 8px. Scale example: 4, 8, 12, 16, 24, 32, 48, 64, 96.
- Use the existing scale. Off-scale values (13px, 22px) are a review finding unless they
  come from an optical correction that is documented.
- Proximity shows grouping: space inside a group is smaller than space between groups.
  A common ratio is 1:2 (e.g. 8 inside, 16 between; 16 inside, 32 between sections).
- Prefer layout gap on containers over margins on children; it avoids collapsed or doubled space.

## Grids

- Content pages: a centered column with a max width, or a 12-column grid with fixed gutters
  (16-32px) and outer margins that shrink on small screens (16px is a common minimum).
- App shells: fixed-width navigation, fluid main area, optional detail pane. Decide which
  pane collapses first as width shrinks.
- Align to a small number of vertical edges. Every extra edge adds visual noise.
- Dense data (tables, dashboards) can use a tighter scale, but keep it consistent within a view.

## Type scale

- Use a modular scale (ratio around 1.2-1.25 for apps, up to 1.333 for editorial) or the
  project's existing steps. 5-7 sizes cover most products.
- Body text: 16px default on the web; never below 14px for body copy, 12px only for
  secondary labels with sufficient contrast.
- Use `rem` (or the platform's scalable unit) so text follows user font-size settings.
- Line height: about 1.4-1.6 for body, 1.1-1.3 for headings. Larger text needs less.
- Weights: two or three (regular, medium or semibold, bold). Hierarchy comes from size,
  weight and color together, not from many weights.
- Limit families to one or two, preferably already loaded by the project; adding a font
  is a dependency decision for the owner.
- Use tabular numerals for columns of numbers and timers.

## Line length and readability

- Body text measure: about 45-75 characters per line; cap prose containers (e.g. `max-width: 65ch`).
- Left-align body text in left-to-right languages; avoid justified text on the web.
- Paragraph spacing roughly equal to the line height.
- Plan for text expansion: translations can be 30-40% longer; avoid fixed-width labels.
- Support right-to-left by using logical properties (start/end) where the stack allows.

## Hierarchy checklist per view

- One clear primary action; secondary actions visually weaker; destructive actions separated.
- The page title is the largest text in the content area.
- Related controls sit together; labels sit next to their inputs (above for forms on narrow screens).
- Scanning path: headings and key values readable when skimming without reading body text.

## Responsive behavior

- Use the project's breakpoints. If none exist, start content-first: add a breakpoint where the
  layout breaks, not at device widths. Common reference points: ~640, ~768, ~1024, ~1280px.
- Design small-screen first; enhance for wider screens.
- For each component decide: reflow, stack, collapse (into menu or disclosure), truncate
  (with full value available), or hide (only if non-essential and available elsewhere).
- Prefer container-relative rules for components reused in panes of different widths, when the
  stack supports them.
- Reflow: at 320 CSS px wide (equivalent to 1280px at 400% zoom), content must not need
  two-dimensional scrolling, except for data tables, maps and similar.
- Touch: targets at least 24x24 CSS px (WCAG 2.2 AA), 44x44 recommended for primary touch actions,
  with spacing between adjacent targets.
- Do not rely on hover for essential information on touch devices.
- Respect safe areas and on-screen keyboards on mobile; keep primary actions reachable.

## Spec output

For each breakpoint: grid/columns, which regions show, ordering changes, type sizes that change,
and components that switch form. Note behavior at 200% zoom and in the narrowest supported width.
