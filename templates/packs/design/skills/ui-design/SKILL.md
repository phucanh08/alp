---
name: ui-design
description: "Make and review UI/UX design decisions: layout, typography, color and tokens, interaction states, responsive behavior and design-system consistency. Use when designing a screen or component look, defining tokens, or reviewing UI against usability and accessibility guidelines. Not for implementing components (frontend-development) or copywriting."
---

# UI design decisions and review

## When to use

- A screen, flow or component needs a layout, hierarchy, spacing or type decision.
- Colors, spacing, radii, shadows or type need to become tokens, or tokens need light/dark variants.
- A design needs its interaction states specified: hover, focus, active, disabled, loading, empty, error.
- Existing UI needs review for usability, accessibility and consistency with the design system.
- Responsive behavior across widths, input modes or zoom levels is undecided or broken.

## Not for

- Writing or refactoring component code, styling plumbing or state management: frontend-development.
- Marketing copy or product naming.
- Brand identity, logos or illustration production.
- Performance tuning of rendering: use the project's profiling workflow.

## Prerequisites

- The assignment states the surface (screen, component, flow) and who uses it on what devices.
- Read ALP.md and the project's existing design system: token files, theme config, component
  library, style guide, screenshots or design files already in the repository.
- Know the stack's styling mechanism (CSS variables, utility classes, theme objects, native styles)
  from manifests and config, not from folder names.

## Workflow

1. Inventory what exists. Search for current tokens, components and patterns that already solve
   part of the problem. Record where you looked before saying something is missing.
2. State the user task the surface serves and the one primary action per view. Design hierarchy
   around that action; demote everything else.
3. Decide layout and type from the existing scale. Use the project's spacing and type scales; add
   a step only when no existing step fits, and say why.
4. Decide color through tokens, never raw values in components. Map semantic tokens (surface, text,
   border, accent, danger) to the primitive palette for both light and dark themes, and check contrast.
5. Specify every interaction state for each interactive element, including keyboard focus,
   loading, empty and error. Specify motion with a reduced-motion alternative.
6. Specify responsive behavior: what reflows, collapses, hides or changes order at each breakpoint,
   and how the layout behaves at 200% zoom and on touch input.
7. Write the decision as a short spec: tokens used or added, layout per breakpoint, state table,
   accessibility notes, and open questions. Hand implementation to the implementing role.
8. When reviewing, use the review checklist, rank findings by severity and cite evidence
   (file and line, screenshot, measured contrast ratio) for each.

## Constraints

- Follow the project's existing design system, stack and conventions first. Propose a new token,
  component or pattern only when existing ones cannot meet the need, and name what it replaces.
- Do not add UI libraries, icon sets, font services or design tooling dependencies without the
  owner's decision. No auto-install.
- Do not fetch remote design data, fonts or images. Work from what is in the repository and the brief.
- Read-only agents (oracle, reviewer, architect) stop at the spec or findings; they do not edit files.
- Accessibility is a requirement, not a polish step: WCAG 2.2 AA contrast, visible focus,
  target size, and no information conveyed by color alone.
- A skill grants no authority: missing product or brand decisions route upward to main and the user.

## Verification

- Every color pair in the spec has a stated contrast ratio that meets its threshold in both themes.
- Every interactive element has all applicable states specified, including focus and disabled.
- The layout is described at the project's breakpoints and at 200% zoom without horizontal scroll
  for text content.
- New tokens follow the existing naming scheme and have both theme values.
- Review findings each have severity, location, evidence and a concrete fix.

## Failure handling

- No design system exists: propose a minimal token set derived from values already used in the
  code, and flag it as a decision for the owner instead of inventing a full system.
- Conflicting patterns already in use: list them with locations and recommend one; do not
  silently pick.
- Brand colors fail contrast: keep the brand value for decoration and propose an adjusted
  accessible variant for text and controls; route the choice upward.
- Unclear target devices or users: state the assumption in the spec and mark it as open.

## References

- [references/design-tokens.md](references/design-tokens.md) — read when defining, naming or theming tokens, or checking contrast in step 4.
- [references/layout-and-typography.md](references/layout-and-typography.md) — read when choosing grids, spacing, type scale or breakpoints in steps 3 and 6.
- [references/interaction-states.md](references/interaction-states.md) — read when specifying states or motion in step 5.
- [references/ui-review.md](references/ui-review.md) — read when reviewing existing UI in step 8.
