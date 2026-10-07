# Use Case Studio engine (Gemini Canvas build)

Loaded by the Use Case Studio Gem's Canvas pages via jsDelivr:
`https://cdn.jsdelivr.net/gh/<user>/use-case-studio-gem@main/engine/uc.css|uc.js|journey.js`

- `uc.css` – base styles, brand page kit, Insider component library, player UI
- `uc.js` – deterministic timeline, stage scaling, autoplay player, error bar, export buttons
- `journey.js` – Architect journey builder
- `uc-export.js` – in-browser GIF / MP4 / PNG export (bundles modern-screenshot, gifenc, mp4-muxer; all MIT). Loaded on demand.

Contains no brand data. After changing a file, purge the CDN cache:
`https://purge.jsdelivr.net/gh/<user>/use-case-studio-gem@main/engine/uc.js` (one URL per file).
