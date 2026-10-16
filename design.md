# GraphLens Design System

One visual system for the Overview, Architecture, and Impact views. Keep the
graph and its evidence central; show controls only when they affect the active
query.

## Genre
Modern-minimal, technical and utilitarian.

## Macrostructure family
- App pages: Map / Diagram. A persistent navigation rail, compact query or
  status header, spatial graph, and a contextual inspector.
- Marketing pages: none in the current application.
- Content pages: none in the current application.

## Theme
Cool Cobalt on engineered near-white, with graphite reserved for code and
structured evidence. Cobalt is the sole chromatic signal.

- Paper: `oklch(98.5% 0.004 250)`
- Ink: `oklch(24% 0.02 258)`
- Rule: `oklch(78% 0.01 250)`
- Accent and focus: `oklch(58% 0.2 256)`
- Graphite: `oklch(22% 0.016 260)`

## Typography
- Display: Space Grotesk, 600, roman.
- Body: Inter, 400/500.
- Mono: JetBrains Mono, 400/500, for identifiers and source metadata.
- Headings use a compact 1.25 scale; body text stays readable and direct.

## Spacing
Use the named 4-point scale in `src/web/tokens.css`.

## Motion
- App surfaces stay composed; no reveal animation.
- State changes use short opacity or border-color transitions only.
- Reduced-motion disables transitions.

## Microinteractions
- Keep selected, focused, loading, error, and disabled states explicit.
- Focus rings appear immediately.
- Successful actions remain quiet; errors keep their retry action.

## Navigation
N3 side rail. Overview, Architecture, and Impact remain direct, persistent
destinations. Language selection stays in the compact toolbar.

## Footer
Ft2 inline single line. Product name only; no credits or secondary links.

## What pages must share
- Cool near-white paper, graphite ink, cobalt signal, and the same type roles.
- 1px rules define surfaces; no glass, gradients, decorative glow, or card
  shadows.
- Graph colors use neutral forms and line patterns; selection uses cobalt.
- Existing routes, query state, analysis behavior, and Japanese translations.

## App content
- Overview: graph canvas with workspace context and selected-node inspection.
- Architecture: root filters, graph, keyboard-accessible node index, and
  evidence inspector.
- Impact: bounded cross-workspace query controls, graph, paths, and inspector.
