# Design tokens

Read when defining, naming or theming tokens, or checking color contrast.

## Tiers

1. **Primitive** (raw palette and scales): `color-blue-600`, `space-4`, `radius-2`, `font-size-3`.
   Named for what they are. Never used directly in components.
2. **Semantic** (role): `color-text-primary`, `color-surface-raised`, `color-border-subtle`,
   `color-accent`, `color-danger`, `space-inset-md`. Named for what they do. Themes remap
   these to different primitives.
3. **Component** (optional, only when a component deviates): `button-primary-bg`,
   `input-border-focus`. Point at semantic tokens. Add sparingly; each one is a fork.

Components consume semantic or component tokens only. Changing a theme should require
editing semantic mappings, not component code.

## Naming

- Follow the scheme already in the project. If none: `category-role-variant-state`, lowercase,
  hyphenated, e.g. `color-text-secondary`, `color-accent-hover`.
- Names describe role, not value: `color-danger`, not `color-red`; `space-stack-lg`, not `space-24`
  at the semantic tier.
- Keep scales ordinal and gap-tolerant (`100`..`900`, or `1`..`8`) so a step can be inserted.
- One source of truth. If tokens exist in several formats (CSS variables, theme object, native
  constants), generate or sync from one file rather than hand-editing each.

## Light and dark

- Define every semantic color for both themes. A token missing a dark value is a defect.
- Dark themes are not inverted light themes: use dark neutral surfaces rather than pure black,
  raise elevation with lighter surfaces instead of heavier shadows, and reduce saturation of
  large accent areas.
- Respect the platform preference (`prefers-color-scheme` or the native equivalent) and allow
  an explicit override if the product already offers one.
- Check images, illustrations, charts and focus rings in both themes, not only text.

## Contrast thresholds (WCAG 2.2)

| Pair | Minimum AA | AAA |
|---|---|---|
| Body text vs background | 4.5:1 | 7:1 |
| Large text (24px+, or 18.66px+ bold) | 3:1 | 4.5:1 |
| UI component boundaries, icons that carry meaning | 3:1 | - |
| Focus indicator vs adjacent colors | 3:1 | - |
| Disabled controls, pure decoration | exempt | - |

- Compute the ratio from relative luminance of the two sRGB colors:
  `(L1 + 0.05) / (L2 + 0.05)` with L1 the lighter. Record the number, not "looks fine".
- Check text on every surface it can appear on (base, raised, overlay, selected row, hover).
- Placeholder text is still text: it needs 4.5:1, or it should not carry instructions.
- Semi-transparent colors: compute against the actual composited background.
- Never convey state by color alone; pair with text, icon, shape or position.

## Other token categories

- Spacing: one base unit (commonly 4 or 8) and a short scale; see layout-and-typography.md.
- Radius: 3-5 steps plus `full`. Nested elements use a smaller radius than their container.
- Elevation: a few named levels mapping shadow and surface color together.
- Motion: duration (`fast`, `base`, `slow`) and easing tokens; see interaction-states.md.
- Z-index: a named, ordered set (`dropdown`, `sticky`, `overlay`, `modal`, `toast`) instead of
  ad hoc numbers.

## Spec output for a token change

List each token: tier, name, light value, dark value, contrast against its paired surfaces,
and which existing hard-coded values it replaces (file and line).
