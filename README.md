<p align="center">
  <img src="docs/images/xiuplay-app-icon.png" width="112" alt="XiuPlay.ai app icon">
</p>

<h1 align="center">XiuPlay.ai</h1>

<p align="center">
  <strong>Turn one game idea into a reviewed, playable Web or Godot game.</strong><br>
  A local-first desktop production agent powered by Codex App Server and Godot 4.
</p>

<p align="center">
  <a href="https://github.com/tonghuyen3234y-del/Noobi.ai/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/tonghuyen3234y-del/Noobi.ai/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/tonghuyen3234y-del/Noobi.ai/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/tonghuyen3234y-del/Noobi.ai?style=flat"></a>
  <a href="https://github.com/tonghuyen3234y-del/Noobi.ai/forks"><img alt="GitHub forks" src="https://img.shields.io/github/forks/tonghuyen3234y-del/Noobi.ai?style=flat"></a>
  <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-11120f">
  <img alt="Developer preview" src="https://img.shields.io/badge/status-developer%20preview-E9A93A">
</p>

<p align="center">
  <a href="#quick-start"><strong>Run from source</strong></a> ·
  <a href="#fork-and-customize"><strong>Fork &amp; customize</strong></a> ·
  <a href="docs/ARCHITECTURE.md"><strong>Architecture</strong></a> ·
  <a href="README.zh-CN.md"><strong>简体中文</strong></a>
</p>

![XiuPlay.ai home screen with the lavender pixel-cloud hero, idea composer and project rail](docs/images/xiuplay-home-hero.png)

XiuPlay.ai gives Codex a bounded game-production loop instead of asking one agent to improvise everything in a single pass. A read-only Planner scopes the work, an Implementer builds inside an isolated project directory, an independent Reviewer checks the result, and the host builds and plays the production output before completion. Failed review, build or playtest checks return to the same Implementer for up to three repair rounds.

> **Current status:** this fork ships the desktop app as **XiuPlay.ai**. Download the [macOS Apple silicon preview](https://github.com/tonghuyen3234y-del/Noobi.ai/releases/tag/v0.1.0-preview.20261109) or run from source. The preview is unsigned and not notarized. Generated games remain standalone local Web or Godot 4 projects.

## Preview update — 2026-11-09

- Renamed the desktop app to **XiuPlay.ai**: new wordmark, squircle app icon and the neon lightning-rabbit mascot. Internal identifiers (`.noobi/` workspace paths, `noobi_*` tool names) are unchanged so existing projects keep working.
- Narrow windows were blank below 800px: the rail is a fixed overlay there and never reserved layout width, pushing the page off screen at the 760px minimum. Content now has its own axis.
- Lavender pixel-cloud home background with pointer particles, digital fragments, soft purple trails and star interactions; mobile retains the static background.
- ChatGPT login and Bailian Key routes, with Qwen patch-tool registration, tool-result round trips and protocol conversion.
- Planner role boundaries, bounded provider retries, repair progress checks and refreshed post-repair review evidence.
- Wan 2.1 source-image size adaptation, readable image-generation failures and a request cancellation control.
- Production builds, 425 automated tests and GitHub CI passed; the packaged macOS app was verified to launch with existing settings. **Fresh one-prompt game generation still needs end-to-end revalidation; these checks do not certify that flow.**

This fork builds on [Innate-Labs/Noobi.ai](https://github.com/Innate-Labs/Noobi.ai).

## Why XiuPlay.ai

| | What you get |
| --- | --- |
| **From prompt to playable** | Start with a natural-language brief, let the Agent choose Web or Godot 4, and preview a real standalone game workspace locally. |
| **Review-gated production loop** | Planner → Implementer → Reviewer → formal build → automated playtest. Failed checks trigger up to three bounded repair rounds. |
| **Automatic experience evaluation** | A sandboxed hidden browser exercises core controls, captures evidence, and checks visible gameplay, animation continuity and runtime errors. |
| **Real media pipeline** | Route images, music, speech, sound effects and 3D through configured providers, Codex ImageGen, imported assets or procedural fallbacks. Failed assets remain visible as retryable placeholders. |
| **A workspace you own** | Every game is a normal local project. Inspect the files, continue with Codex, commit it to Git, or take it outside XiuPlay.ai. |
| **Built to extend** | Add media providers, Codex Skills, MCP servers, agent prompts, project templates, Godot export targets, or an entirely different workbench UI. |

## Quick start

### Requirements

- macOS (the current tested and packaged target)
- Node.js 22 LTS and npm
- a ChatGPT/Codex account, or an Alibaba Bailian Key with the required services enabled
- an available image route: a configured image provider or Codex ImageGen
- Godot 4 with exactly matching Web export templates, only when the Agent selects Godot

```bash
git clone https://github.com/tonghuyen3234y-del/Noobi.ai.git
cd XiuPlay.ai
npm ci
npm run dev
```

On first launch, pick one route in **Settings → Runtime & account**:

- **ChatGPT login** — authorize once; Codex uses whatever OpenAI models the account can reach, and image generation comes from its built-in ImageGen.
- **Qwen (Bailian)** — paste one DashScope API Key. Planning, code and screenshot review use `qwen-plus`; saving the key also provisions the Qwen-Image service from the same key, so art works without a second credential.

A key point on the Qwen route: Codex only speaks the Responses protocol, and DashScope's `/responses` endpoint rewrites `function_call_output` into a `tool` role it then rejects, so every follow-up turn failed with HTTP 400. The app runs a local protocol shim in between to make that route usable.

Each route keeps its own app-private Codex directory (`codex-home-openai`, `codex-home-qwen`), so credentials, threads and session state never mix. Switching routes leaves your projects, code and assets untouched. Your global `~/.codex` configuration is not overwritten.

If Codex cannot be located automatically, point XiuPlay.ai at a binary explicitly:

```bash
NOOBI_CODEX_BIN=/absolute/path/to/codex npm run dev
```

## From idea to playable project

```mermaid
flowchart LR
    Idea["Idea + reference files"] --> Preflight["Capability and engine preflight"]
    Preflight --> Plan["Planner<br/>read-only"]
    Plan --> Build["Implementer<br/>workspace-write"]
    Build --> Review["Reviewer<br/>read-only"]
    Review --> Pass{"Pass?"}
    Pass -- "No" --> Repair["Repair<br/>up to 3 rounds"]
    Repair --> Review
    Pass -- "Yes" --> EngineBuild["Web build or<br/>Godot import + export"]
    EngineBuild --> Playtest["Hidden-browser playtest<br/>inputs + screenshots + errors"]
    Playtest --> Gate["Host proof gate"]
    Gate -. "Repairable finding" .-> Repair
    Gate --> Done["Playable local project"]
    Gate -. "External blocker" .-> Blocked["Blocked"]
```

The workbench visualizes `Brief → Scaffold → GDD → Assets → World → Code → Verify → Complete`. Those stages explain progress; the Reviewer and host proof gate decide whether a run is actually complete.

<p align="center">
  <img src="docs/images/xiuplay-mascot.png" width="220" alt="XiuPlay.ai neon lightning rabbit mascot">
</p>

<p align="center">
  <sub>The XiuPlay.ai mascot — a neon lightning rabbit — appears across the rail, the workbench and the generated loading screens.</sub>
</p>

## Fork and customize

XiuPlay.ai is intentionally organized around replaceable boundaries. A useful fork can start small:

| Goal | Start here |
| --- | --- |
| Add or change a media provider | [`mediaProviderStore.ts`](src/main/mediaProviderStore.ts) and [`mediaGenerationService.ts`](src/main/mediaGenerationService.ts) |
| Connect a tool or internal service through MCP | [`mcpConfigManager.ts`](src/main/mcpConfigManager.ts) |
| Change Planner, Implementer, Reviewer or Repair behavior | [`promptTemplateStore.ts`](src/main/promptTemplateStore.ts) and the prompt contracts in [`gameHarness.ts`](src/main/gameHarness.ts) |
| Change the generated game scaffold and project rules | [`workspaceTemplate.ts`](src/main/workspaceTemplate.ts) |
| Build a new production experience | [`src/renderer/components`](src/renderer/components) |
| Add a new host-side dynamic tool | [`mediaToolBroker.ts`](src/main/mediaToolBroker.ts) |

Good first directions include a new provider adapter, Windows/Linux packaging, sample-game galleries, accessibility improvements, and additional deterministic game templates. See the [roadmap](ROADMAP.md) and [contribution guide](CONTRIBUTING.md).

## What is inside

### Production workbench

- eight visible production stages and a live Agent event stream
- command and file-change approvals
- playable loopback preview, project files, and a unified asset library
- Agent-selected Web or Godot 4 workspace with environment and export-template checks
- host-managed timing and animation contracts without a user-facing FPS strategy selector
- XiuPlay crew characters, role-based motion, selectable studio scenes and an animated fishing background
- persistent projects and resumable Codex Implementer threads

### Media and extension layer

- configurable image, audio and 3D REST providers
- Codex ImageGen fallback for required image generation
- music, speech, vocal effects, procedural WAV and Web Audio paths
- API-first self-contained GLB generation with a procedural Three.js fallback
- image and file attachments that influence planning, visual direction and asset reuse
- retryable asset work orders that preserve placeholders after generation failures
- native Codex Skills, stdio/HTTP MCP servers, and role-specific prompt customization

### Trust boundaries

- sandboxed Electron Renderer with typed IPC only
- API keys sealed by Electron `safeStorage` and never returned to the Renderer after saving
- localhost-only preview server bound to `127.0.0.1`
- path, symlink, MIME, size, SHA-256 and production-reference validation for generated assets

Read the full [product capability map](docs/PRODUCT_FUNCTIONS.md) and [architecture guide](docs/ARCHITECTURE.md).

## Architecture at a glance

```mermaid
flowchart LR
    User["Creator<br/>prompt + assets"] --> Renderer["React Renderer<br/>workbench · approvals · preview"]

    subgraph Desktop["Electron desktop"]
        Renderer <-->|"typed IPC"| Main["Electron Main<br/>trusted host"]
        Main --> Harness["Game Harness"]
        Main --> Preview["Loopback preview"]
        Main --> Playtest["Experience evaluator"]
        Main --> Environment["Godot environment manager"]
        Main --> Broker["Media tool broker"]
        Main --> Gate["Asset store + host attestation"]
    end

    Harness <-->|"JSONL · stdio"| Codex["Codex App Server"]
    Codex --> Agents["Planner · Implementer · Reviewer"]
    Agents --> Workspace["Web or Godot 4 workspace"]
    Broker --> Providers["Image · audio · 3D providers"]
    Providers --> Gate
    Gate --> Workspace
    Preview --> Workspace
    Playtest --> Preview
    Environment --> Godot["Godot 4<br/>headless import · validate · export"]
    Godot --> Workspace
```

## Development

```bash
npm run typecheck       # renderer + main process
npm test                # unit and integration tests
npm run build           # production renderer and main bundles
npm run verify          # typecheck + tests + production build
npm run smoke:ui        # isolated Electron UI screenshot
```

The following smoke tests use a signed-in Codex account and may consume a small amount of Codex or media-provider quota:

```bash
npm run smoke:codex
npm run smoke:harness
npm run smoke:media
npm run smoke:image
npm run smoke:model3d
npm run smoke:godot
npm run smoke:playtest
```

To produce an unsigned macOS DMG locally:

```bash
npm run package:mac
```

Public distribution still requires Developer ID signing, Apple notarization and stapling.

## Current boundaries

- Web and Godot 4/GDScript workspaces are supported. Godot delivery currently targets a Compatibility-renderer Web export; automatic native macOS, Windows and Linux exports are not connected yet.
- macOS is the current release target. Windows and Linux desktop workflows are on the roadmap.
- Meshy, Tripo and Rodin currently use a synchronous REST gateway contract rather than native asynchronous job orchestration for every vendor.
- The built-in Three.js fallback produces functional low-poly, self-contained GLB assets; it does not claim provider-level high-fidelity organic topology or texturing.
- Quality and completion depend on the selected model, prompt, dependencies and available media routes. A run that cannot satisfy the proof gate remains `blocked` instead of being presented as complete.

## Contributing

Contributions that make the pipeline safer, more portable or easier to extend are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md), run `npm run verify`, and open a focused pull request. Security reports should follow [`SECURITY.md`](SECURITY.md).

## License

No project license has been published yet. Until the repository owners select and add one, the code remains under the default copyright rules. If you plan to distribute a derivative, watch [the repository issues](https://github.com/Innate-Labs/Noobi.ai/issues) or contact the maintainers first.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Product capabilities](docs/PRODUCT_FUNCTIONS.md)
- [Codex source-reading notes](docs/CODEX_SOURCE_NOTES.md)
- [Roadmap](ROADMAP.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
