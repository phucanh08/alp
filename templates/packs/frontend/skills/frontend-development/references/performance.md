# Frontend Performance

Read when a screen is slow, a bundle grows, or images and lists are heavy.

Measure first, then change one thing, then measure again under the same conditions
(same build mode, device or throttling profile, data size). Development builds are
slower and noisier than production builds; profile a production build for claims.

## What to measure

- Core Web Vitals for page experience: Largest Contentful Paint (loading),
  Interaction to Next Paint (responsiveness), Cumulative Layout Shift (stability).
  Use the project's existing tooling (Lighthouse, browser performance panel, a RUM
  dashboard) and report the conditions.
- Render cost: the framework's profiler (React DevTools Profiler, Vue DevTools) to
  see which components render, how often, and how long.
- Bundle size: the build's analyzer or stats output for the affected routes.
- Network: the waterfall for the route; look for serial requests and large payloads.

Use budgets the project already defines. Do not invent a fixed threshold; report
before and after numbers instead.

## Render cost

- First remove unnecessary work: state stored too high causing wide re-renders,
  derived data recomputed in render on large inputs, effects that set state on
  every render, and context values recreated each render.
- Move state down to where it is used, or split components so fast-changing state
  re-renders a small subtree.
- Memoization (`memo`, `useMemo`, `useCallback`, computed values) only where the
  profiler shows a measurable cost, or where the project's compiler or lint rules
  already handle it. Unmeasured memoization adds complexity and can hide bugs from
  stale dependencies.
- Virtualize long lists (hundreds of rows or more) with the project's existing
  approach; paginate when virtualization is not justified.
- Keep heavy computation off the main thread (a web worker) only when measured.
- Defer non-urgent updates with the framework's transition or scheduling API when
  typing feels laggy.

## Bundle and loading

- Split by route; lazy-load heavy, rarely used components (editors, charts, maps)
  behind the interaction or view that needs them.
- Check what a new dependency costs before proposing it; prefer platform APIs and
  existing dependencies. Adding one is the owner's decision.
- Import only what you use; avoid barrel imports that defeat tree shaking when the
  bundler struggles with them.
- Do not ship server-only code, large data files, or source maps to clients
  unintentionally.
- Preload critical resources (the LCP image, key fonts) when measurement shows a
  delay; do not preload everything.
- Server rendering or static generation helps first paint for content pages; see
  frameworks.md.

## Images and media

- Serve sized, compressed images in modern formats through the project's image
  pipeline or component.
- Always set width and height (or aspect ratio) to prevent layout shift.
- Lazy-load below-the-fold images; do not lazy-load the LCP image.
- Use responsive `srcset` and `sizes` so small screens download small files.
- Prefer CSS or SVG for icons and simple graphics.

## Layout stability and responsiveness

- Reserve space for async content, ads, and embeds.
- Avoid inserting content above existing content after load.
- Load fonts with a display strategy that avoids invisible text, using the project's
  font setup.
- Keep input handlers short; break long tasks; avoid layout thrashing (reading
  layout then writing styles in a loop).

## Reporting

- State the metric, tool, build mode, device or throttling profile, data size, and
  before and after values.
- If a change does not move the measured metric, revert it rather than keeping it
  as a precaution.
