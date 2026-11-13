---
name: design-system-maintain
description: Establish or evolve a product's semantic tokens, reusable components, patterns and UI documentation across web or Flutter.
---
# Design-system maintenance
Input: product worktree, exact base commit, requested change, platform, approved direction, jobId and external outputDir.
1. Read product instructions, theme/token sources, existing component APIs, compositions, examples, tests and approved decisions. Reuse established paths and conventions; do not introduce a competing source of truth.
2. Determine whether reuse, composition, an existing variant, or a new component is warranted. In audit-only tasks propose changes without editing. Obtain approval before changing visual direction, public APIs or adding platform targets.
3. Maintain semantic roles for color, typography, spacing, sizing, shape, elevation and motion where applicable. Keep actual theme/token code authoritative; avoid parallel manually maintained token values. Document contrast pairs and methods without claiming all rendered states were measured.
4. Update component inputs/events, variants, states, intended use, composition examples and common misuses together with implementation and appropriate tests. Check focus/keyboard/semantics, reduced motion, responsive sizing, text scaling, localization and long content.
5. Web: use the product's Storybook and its documented MCP tools for discovery/docs/examples/tests where available. Inspect installed tool names and framework manifest support, never infer a shared server or invent component props. Missing Storybook setup requires an approved product change.
6. Flutter: use the real theme/localization and Widgetbook examples. Widgetbook documentation MCP supplies framework documentation, NOT the product's live widget catalog. Read product source/docs for its APIs; use Dart runtime tools and rendered evidence when supported. Preserve existing manual/codegen conventions. Never add a Flutter web target just to obtain screenshots without approval.
7. For new direction, compare references or small sketches/previews and record human approval in the product repository. Mobbin/getdesign references are inspiration, not authority or permission to copy; use only configured, authorized access.
8. Use the normal independent evaluation/delivery process for implementation. Changes to approved decisions require explicit approval and a dated repository record explaining superseded behavior and migration.
Outputs: update existing product-native token/component/docs/catalog/test paths, recording exact paths in <outputDir>/design-system-change.md.
Report sections: Base/candidate commit; Existing baseline and reuse decision; Tokens/components/patterns changed; API and migration guidance; Catalog examples and states; Accessibility/interaction guidance; Checks/evidence; Decisions needing approval; Limitations.
For initial setup propose product-native locations before creating files. Preserve approved decisions and existing unresolved limitations; do not overwrite earlier reports.
Rules are advisory. This skill grants no setup, external publishing, merge, deployment or destructive-cleanup authority.
