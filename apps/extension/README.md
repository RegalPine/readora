# Readora — Markdown Reader

A beautiful, focused reading experience for Markdown in Visual Studio Code.

Readora renders your `.md` / `.markdown` files in a dedicated reader webview:
editorial typography, GFM tables and task lists, diagrams, math, outline
navigation, focus mode, and one-click export to HTML / PDF / PNG.

> Requires Visual Studio Code **1.95.0** or later.

## Getting started

Since **0.13.1**, Readora is the default editor for `.md` / `.markdown`: double-clicking
a Markdown file (or picking it in the Explorer) opens the reader straight away, and
switching to a sibling file from the native breadcrumb keeps you in the reader.

Prefer the raw source? Right-click the file → **Open With…** → *Text Editor*, or pin
it permanently with:

```json
{ "workbench.editorAssociations": { "*.md": "default" } }
```

You can also start the reader explicitly from anywhere:

- **Command Palette** → `Readora: Open Reader` (default keybinding `⌘⌥R` / `Ctrl+Alt+R`)
- **Editor context menu** → *Readora: Open Reader* / *Readora: Open to the Side*
- **Explorer context menu** → right-click a `.md` file → *Readora: Open Reader*

The reader updates live as you edit and save the source file.

## Commands

| Command | Default keybinding | Description |
| --- | --- | --- |
| `Readora: Open Reader` | `⌘⌥R` / `Ctrl+Alt+R` | Open the reader for the active Markdown file. |
| `Readora: Open to the Side` | — | Open the reader in the adjacent editor group. |
| `Readora: Toggle Focus Mode` | `⌘⌥F` / `Ctrl+Alt+F` | Dim everything but the current section for distraction-free reading. |
| `Readora: Toggle Outline` | `⌘⌥O` / `Ctrl+Alt+O` | Show or hide the outline sidebar for the current session. |
| `Readora: Adjust Content Width` | `⌘⌥←` / `⌘⌥→` (`Ctrl+Alt+←/→`) | Narrow or widen the reading column. |
| `Readora: Refresh` | — | Re-render the current document. |
| `Readora: Export as HTML` | — | Save a self-contained HTML copy. |
| `Readora: Export as PDF` | — | Export via a local Chrome/Chromium/Edge instance. |
| `Readora: Export as PNG` | — | Export a rendered image via a local Chrome/Chromium/Edge instance. |

Commands marked “—” have no default keybinding; invoke them from the Command
Palette. Focus Mode, Toggle Outline and Adjust Content Width are available while
the reader is active.

## Rendering

- **CommonMark + GFM**: tables, strikethrough, task lists, syntax-highlighted
  code blocks (read-only editor).
- **Frontmatter** is extracted as document metadata instead of shown in the body.
- **Math (KaTeX)**: inline `$…$` / `\(…\)`, display `$$…$$` / `\[…\]`.
- **Diagrams**: flow, sequence and other chart types rendered inline.
- **Wiki links & footnotes** for connected notes.
- **Local images and resources** resolved from your workspace.

## Settings

All settings live under the `readora.*` namespace.

| Setting | Default | Description |
| --- | --- | --- |
| `readora.theme` | `auto` | `auto` follows the VS Code color theme; also `light`, `dark`, `vscode`, `system`. |
| `readora.fontSize` | `16` | Base font size of the reading canvas (px, 8–32). |
| `readora.lineHeight` | `1.75` | Line height (1–3). |
| `readora.contentWidth` | `820` | Maximum content width (px, 480–1600). |
| `readora.showOutline` | `true` | Show the outline sidebar when a reader opens. |
| `readora.typography` | `newsreader` | Body typeface: `newsreader`, `geist`, or `inter`. CJK falls back to system fonts. |
| `readora.themePreset` | `default` | `high-contrast` raises text/border contrast to WCAG 2.2 AA without changing the palette hues. |
| `readora.customCss` | `""` | Optional CSS applied after the built-in styles. Only selectors starting with `.readora-` or `[data-readora-]` are accepted; anything else rejects the whole block. |
| `readora.resources.allowExternalImages` | `false` | Allow remote (http/https) images. |
| `readora.resources.maxImageSizeMb` | `10` | Maximum size of a single local resource (MB, 1–50). |
| `readora.export.chromePath` | `""` | Absolute path to a Chrome/Chromium/Edge executable, used only by the PDF/PNG exports. Leave empty to auto-detect. |

## Notes & limitations

- **Your own editor associations win.** `workbench.editorAssociations` and any
  default you previously picked in **Open With…** take precedence over Readora's
  registration, so those files keep opening the way you configured them.
- **Remote images are off by default** and `readora.resources.allowExternalImages`
  is not yet fully delivered; local workspace images are supported.
- **PDF and PNG export** require a locally installed Chrome, Chromium, or Edge.
  Set `readora.export.chromePath` if auto-detection cannot find one.

