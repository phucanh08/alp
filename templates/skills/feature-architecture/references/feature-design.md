# Feature Design

Read when writing the feature design, picking the analogous feature, or checking new dependency direction.

## Picking the analogous feature

Rank candidates by how many of these they share with the new feature:

1. Same kind of entry point (HTTP route, CLI command, job, UI screen, event handler).
2. Same owning module or layer, and the same set of modules it depends on.
3. Same persistence or integration shape (reads/writes the same store or service).
4. Recently written or recently touched, so it reflects current conventions.
5. Has tests in the style the project expects.

Prefer the project's boilerplate or generator when one exists; use the analogous
feature to fill what the template leaves out. If two candidates disagree, follow the
one the architecture docs or checks endorse and note the other as drift.

Record the choice in the design: "Mirrors `<path>` because <shared traits>."

## Design template

Keep it to what a reviewer needs to check the implementation. Omit empty sections.

```text
Feature: <one-line purpose>
Owning module: <module/package/layer>
Mirrors: <path of analogous feature or template> because <traits>

Hard constraints applied:
- <rule> (source: <doc/ADR/lint config>)

Files:
- add    <path>  <role in the feature>
- change <path>  <what changes and why>

Public surface:
- <exported symbol / route / CLI flag / config key / event>  new | changed
- Compatibility: <none affected | what callers must change>

Dependencies (from -> to):
- <module A> -> <module B>  <existing edge kind it matches>

Tests:
- <test file>  <behavior covered>

Open decisions / exceptions:
- <question or rule exception, who must decide>
```

## Dependency-direction checklist

Answer each for every new import, call, or registration:

- Does an existing edge of the same kind already point this way? Cite one.
- Does the edge cross a layer or package boundary the docs or contract restrict?
- Would it create a cycle between modules? Check both directions.
- Does a lower or shared module now import from a feature or app module?
- Does domain or core code now import a framework, transport, or storage detail
  the analogous feature keeps outside it?
- Is a test-only or dev-only dependency reachable from production code?
- Does the feature reach into another module's internals instead of its public
  entry point?
- Is a new registration (router, plugin list, DI container, manifest) placed where
  the analogous feature registers?

Any "yes" to a restricted crossing, cycle, or internals access is a hard-constraint
issue: fix the placement or route an exception decision upward before implementing.
