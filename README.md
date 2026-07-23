# 🤠 Space Cowboy

**Play it:** [atominnovationth.github.io/SCB](https://atominnovationth.github.io/SCB/)

A browser-based Newtonian-physics ADR (Active Debris Removal) simulation built
with Three.js. Command the "Crossbow" satellite platform: fly orbital mechanics,
deploy spring-loaded capture arms, and clear the debris field. Semi-autonomous
collision-avoidance AI keeps you alive while you focus on the catch.

## Run locally

```bash
npm start        # http-server on :8080  →  http://localhost:8080
# or
./start.sh       # python http.server on :8081, opens your browser
```

No build step. ES6 modules; Three.js is vendored same-origin under `./vendor/`
(no CDN — fully offline). Procedural geometry, NASA public-domain textures.

## Controls (essentials)

Arrows rotate · `S` scan (`Shift+S` wide) · `T` / `Tab` target · `A` autopilot ·
`N` fire net/lasso · `D` launch daughter · `R` reel in · `1`–`4` pilot daughter ·
`V` camera (`Shift+V` strategic map) · `B` shop · `F` forge · `I` codex ·
`+` / `-` hide/show HUD panes (`Shift+=` / `Shift+-` throttle) · `?` help · `Esc` pause
