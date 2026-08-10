#!/usr/bin/env node
/**
 * One-off generator for assets/icons/*.svg — animated technology badges.
 * These are original abstract badge designs (gradient disc + rotating ring +
 * pulsing glow + label), not reproductions of any company's logo artwork,
 * so they're safe to commit and host directly in the repo.
 *
 * Re-run any time you want to add a new tech or change the palette:
 *   node scripts/generate-icons.mjs
 */
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = "assets/icons";

const TECHS = [
  { id: "python", label: "Py", from: "#4B8BBE", to: "#FFD43B" },
  { id: "rust", label: "Rs", from: "#CE422B", to: "#3a3a3a" },
  { id: "react", label: "⚛", from: "#00d8ff", to: "#0a4a5c" },
  { id: "nextjs", label: "N", from: "#ffffff", to: "#000000" },
  { id: "docker", label: "Do", from: "#2496ED", to: "#0a3a63" },
  { id: "linux", label: "Lx", from: "#FCC624", to: "#1a1a1a" },
  { id: "postgresql", label: "Pg", from: "#336791", to: "#1a2f3f" },
];

function iconSVG({ id, label, from, to }) {
  const size = 90;
  const c = size / 2;
  const dur = (6 + (id.length % 3)).toFixed(1);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <radialGradient id="g-${id}" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="${from}"/>
      <stop offset="100%" stop-color="${to}"/>
    </radialGradient>
  </defs>

  <!-- pulsing outer glow -->
  <circle cx="${c}" cy="${c}" r="${c - 4}" fill="none" stroke="${from}" stroke-width="2" opacity="0.55">
    <animate attributeName="r" values="${c - 10};${c - 3};${c - 10}" dur="2.4s" repeatCount="indefinite"/>
    <animate attributeName="opacity" values="0.6;0.05;0.6" dur="2.4s" repeatCount="indefinite"/>
  </circle>

  <!-- rotating dashed ring -->
  <g>
    <circle cx="${c}" cy="${c}" r="${c - 8}" fill="none" stroke="${to}" stroke-width="2" stroke-dasharray="6 7" opacity="0.85"/>
    <animateTransform attributeName="transform" type="rotate" from="0 ${c} ${c}" to="360 ${c} ${c}" dur="${dur}s" repeatCount="indefinite"/>
  </g>

  <!-- core disc -->
  <circle cx="${c}" cy="${c}" r="${c - 16}" fill="url(#g-${id})">
    <animate attributeName="r" values="${c - 17};${c - 14};${c - 17}" dur="2.4s" repeatCount="indefinite"/>
  </circle>

  <text x="${c}" y="${c + 1}" text-anchor="middle" dominant-baseline="central"
        font-family="'Segoe UI', Helvetica, Arial, sans-serif" font-weight="800"
        font-size="22" fill="#0d1117" stroke="#ffffff" stroke-width="0.6" paint-order="stroke">
    ${label}
  </text>
</svg>`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const t of TECHS) {
  const file = path.join(OUT_DIR, `${t.id}.svg`);
  fs.writeFileSync(file, iconSVG(t), "utf8");
  console.log("wrote", file);
}
