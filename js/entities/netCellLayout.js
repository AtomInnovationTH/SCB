/**
 * netCellLayout.js - where the net cartridges sit on a launcher face (nets-step2, DECISIONS §33 row 5).
 *
 * A pure function, no THREE: the mother's launcher face (PlayerSatellite._buildNetPods) and the daughters' net cans
 * (ArmUnit) both draw their muzzles from it, so one rule sizes every cell. The line-fibre upgrade raises the net count
 * 4 -> 6 -> 8 -> 10 (mother, small daughter) and 2 -> 3 -> 4 -> 5 (large daughter); round cartridges are packed to the
 * largest size that still fits the face.
 *
 * Layout: n = 2..6 is a ring of n cells; 8 is one centre cell plus a ring of 7; 10 is one centre cell plus a ring of 9
 * (any other n is a ring of n; 1 is one centre cell). Ring cells come first, the centre cell last (index n - 1), so a
 * launcher that spends its nets from the highest index empties the centre first. The first ring cell sits at angle
 * pi/2 + pi/k from +X (k = ring size), counter-clockwise: two cells sit left and right, four make a square.
 */

/**
 * @param {number} n       cells (cartridges)
 * @param {number} faceR   radius of the usable face, m (cells and the gap to the face edge fit inside it)
 * @param {number} gap     clear gap between neighbouring cells and between a cell and the face edge, m
 * @returns {{x: number, y: number, r: number}[]} n cells, centres in the face plane (m), r = the cell's OUTER radius
 */
export function netCellLayout(n, faceR, gap) {
  const count = Math.max(0, Math.floor(n) || 0);
  if (count === 0) return [];
  if (count === 1) return [{ x: 0, y: 0, r: faceR - gap }];
  const centre = count === 8 || count === 10;
  const k = centre ? count - 1 : count;
  const s = Math.sin(Math.PI / k);
  // Ring cells touch (centre-to-centre = 2r + gap): rho = (r + gap/2) / s. With a centre cell the ring also keeps
  // 2r + gap from the centre. The outermost edge is rho + r + gap <= faceR. Both limits solve for r in closed form.
  let r = (faceR - gap - gap / (2 * s)) / (1 / s + 1);
  if (centre) r = Math.min(r, (faceR - 2 * gap) / 3);
  const rho = Math.max((r + gap / 2) / s, centre ? 2 * r + gap : 0);
  const cells = [];
  for (let j = 0; j < k; j++) {
    const a = Math.PI / 2 + Math.PI / k + (2 * Math.PI * j) / k;
    cells.push({ x: rho * Math.cos(a), y: rho * Math.sin(a), r });
  }
  if (centre) cells.push({ x: 0, y: 0, r });
  return cells;
}

/**
 * Ring radius of a layout (0 for a lone centre cell): handy for tests and callouts.
 * @param {{x:number,y:number,r:number}[]} cells
 * @returns {number}
 */
export function netCellRingRadius(cells) {
  let rho = 0;
  for (const c of cells) rho = Math.max(rho, Math.hypot(c.x, c.y));
  return rho;
}
