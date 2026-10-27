# 🤠 Space Cowboy

**Play it:** [atominnovationth.github.io/SCB](https://atominnovationth.github.io/SCB/)

A browser-based Newtonian-physics ADR (Active Debris Removal) simulation built
with Three.js. Command the "Crossbow" satellite platform: fly orbital mechanics,
deploy spring-loaded capture arms, and clear the debris field. Semi-autonomous
collision-avoidance AI keeps you alive while you focus on the catch.

## Run locally

```bash
npm start        # local node server on :8080  →  http://localhost:8080
# or
./start.sh       # same server (no caching) on :8081, opens your browser
                 # SC_PORT=8095 ./start.sh  or  ./start.sh --no-browser
```

No build step. ES6 modules; Three.js is vendored same-origin under `./vendor/`
(no CDN — fully offline). Both start commands serve with plain node, nothing
to download, so they start at once with no internet (2026-10-22). Procedural
geometry, NASA public-domain textures.

## Controls (essentials)

Arrows rotate · `S` scan (`Shift+S` wide) · `T` / `Tab` target · `A` autopilot ·
`N` fire net/lasso · `D` launch daughter · `R` reel in · `1`–`4` pilot daughter ·
`V` camera (`Shift+V` strategic map) · `B` shop · `I` codex ·
`+` / `-` hide/show HUD panes (`Shift+=` / `Shift+-` throttle) · `?` help · `P` pause · `Esc` back
