import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial } from '@iwsdk/core';

/**
 * What the player collides with on a baked Synty level: the level's own navigation grid, turned
 * into a floor and walls.
 *
 * Not the drawn model. A baked level stores every repeated prefab — every ground tile, every road
 * piece — as one `InstancedMesh`, and IWSDK's locomotor builds its collision mesh from each mesh's
 * geometry and node transform without reading instance matrices. On the drawn model the ground
 * therefore has no collision at all, and the player falls through it. The grid is also the better
 * answer on its own terms: it is exactly where the bake decided a person can stand, so the player
 * walks where the zombies path and the stage and props are grounded, and nowhere else.
 *
 * - **Floor.** One continuous surface over the walkable cells. Each cell corner takes the mean
 *   height of the walkable cells around it, so kerbs become short ramps rather than seams to snag
 *   on. Blocks of cells that lie on one plane merge into a single quad, largest first.
 * - **Walls.** Every edge between a walkable cell and a blocked one (or the grid's edge) is a wall
 *   {@link WALL_HEIGHT} tall, so the player cannot walk into buildings or off the top of a drop.
 */

/** How tall the walls along the walkable area's edge are, metres. */
const WALL_HEIGHT = 2.5;
/** How far a merged floor quad may stray from the cell corners it replaces, metres. */
const PLANAR_TOLERANCE = 0.03;
/** The largest floor block, in cells. A power of two. */
const MAX_BLOCK = 32;
const BLOCKED = 1;

/** Decodes `extras.gamefoundry.nav` from a baked GLB, or null when the scene carries none. */
export async function decodeNav(encoded) {
  if (!encoded || encoded.encoding !== 'zlib-base64' || typeof encoded.data !== 'string') return null;
  const binary = atob(encoded.data);
  const packed = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) packed[i] = binary.charCodeAt(i);
  const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const count = encoded.cols * encoded.rows;
  if (bytes.length !== count * 3) {
    console.warn(`[nav] Expected ${count * 3} bytes for a ${encoded.cols}x${encoded.rows} grid, got ${bytes.length}.`);
    return null;
  }
  const flags = bytes.slice(0, count);
  const heights = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset + count, count * 2);
  for (let i = 0; i < count; i++) heights[i] = encoded.heightBase + view.getUint16(i * 2, true) * encoded.heightQuantum;
  return {
    cols: encoded.cols, rows: encoded.rows, originX: encoded.originX, originZ: encoded.originZ,
    cellSize: encoded.cellSize, flags, heights,
  };
}

export const isWalkable = (nav, cx, cz) =>
  cx >= 0 && cz >= 0 && cx < nav.cols && cz < nav.rows && (nav.flags[cz * nav.cols + cx] & BLOCKED) === 0;

/** The ground height under (x, z): the cell's own height (blocked cells carry their neighbour's). */
export function navHeightAt(nav, x, z) {
  const cx = Math.min(nav.cols - 1, Math.max(0, Math.floor((x - nav.originX) / nav.cellSize)));
  const cz = Math.min(nav.rows - 1, Math.max(0, Math.floor((z - nav.originZ) / nav.cellSize)));
  return nav.heights[cz * nav.cols + cx];
}

/** The lowest walkable height, for "the player has fallen off the level". */
export function navFloor(nav) {
  let lowest = Infinity;
  for (let i = 0; i < nav.flags.length; i++) if (!(nav.flags[i] & BLOCKED) && nav.heights[i] < lowest) lowest = nav.heights[i];
  return Number.isFinite(lowest) ? lowest : 0;
}

/** The collision group: invisible, for `LocomotionEnvironment` only. */
export function buildNavCollision(nav) {
  const { cols, rows, cellSize, originX, originZ } = nav;
  const walk = (cx, cz) => isWalkable(nav, cx, cz);

  // Corner heights: the mean of the walkable cells sharing the corner. NaN where none do.
  const corners = new Float32Array((cols + 1) * (rows + 1)).fill(NaN);
  for (let vz = 0; vz <= rows; vz++) {
    for (let vx = 0; vx <= cols; vx++) {
      let sum = 0;
      let n = 0;
      for (const [dx, dz] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
        const cx = vx + dx;
        const cz = vz + dz;
        if (walk(cx, cz)) { sum += nav.heights[cz * cols + cx]; n++; }
      }
      if (n > 0) corners[vz * (cols + 1) + vx] = sum / n;
    }
  }
  const corner = (vx, vz) => corners[vz * (cols + 1) + vx];

  const positions = [];
  const quad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) => {
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz);
  };
  const wx = (vx) => originX + vx * cellSize;
  const wz = (vz) => originZ + vz * cellSize;

  // Floor: aligned blocks, largest first, each emitted once it is all walkable, not yet covered,
  // and planar — every corner inside it within tolerance of the bilinear surface over its four.
  const covered = new Uint8Array(cols * rows);
  for (let size = MAX_BLOCK; size >= 1; size >>= 1) {
    for (let bz = 0; bz + size <= rows; bz += size) {
      for (let bx = 0; bx + size <= cols; bx += size) {
        let ok = true;
        for (let z = bz; ok && z < bz + size; z++) {
          for (let x = bx; x < bx + size; x++) {
            const i = z * cols + x;
            if (covered[i] || (nav.flags[i] & BLOCKED)) { ok = false; break; }
          }
        }
        if (!ok) continue;
        const h00 = corner(bx, bz), h10 = corner(bx + size, bz);
        const h01 = corner(bx, bz + size), h11 = corner(bx + size, bz + size);
        if (size > 1) {
          for (let z = 0; ok && z <= size; z++) {
            for (let x = 0; x <= size; x++) {
              const u = x / size, v = z / size;
              const fit = (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
              if (Math.abs(corner(bx + x, bz + z) - fit) > PLANAR_TOLERANCE) { ok = false; break; }
            }
          }
          if (!ok) continue;
        }
        for (let z = bz; z < bz + size; z++) covered.fill(1, z * cols + bx, z * cols + bx + size);
        // Counter-clockwise seen from above, so the floor faces up.
        quad(
          wx(bx), h00, wz(bz),
          wx(bx), h01, wz(bz + size),
          wx(bx + size), h11, wz(bz + size),
          wx(bx + size), h10, wz(bz),
        );
      }
    }
  }

  // Walls: runs of walkable-to-blocked edges along each grid line, merged while the ground along
  // the run stays close to a straight line between its ends.
  const wall = (x0, z0, y0, x1, z1, y1) => {
    quad(x0, y0 - 0.1, z0, x1, y1 - 0.1, z1, x1, y1 + WALL_HEIGHT, z1, x0, y0 + WALL_HEIGHT, z0);
  };
  const runs = (length, edgeAt, heightAt, emit) => {
    let start = -1;
    const flush = (end) => {
      if (start < 0) return;
      // Split where the ground strays from the run's straight line, so the wall's foot follows it.
      let from = start;
      for (let k = start + 1; k <= end; k++) {
        const y0 = heightAt(from), y1 = heightAt(k);
        let straight = true;
        for (let j = from + 1; j < k; j++) {
          const t = (j - from) / (k - from);
          if (Math.abs(heightAt(j) - (y0 + (y1 - y0) * t)) > 0.2) { straight = false; break; }
        }
        if (!straight) { emit(from, k - 1); from = k - 1; }
      }
      emit(from, end);
      start = -1;
    };
    for (let k = 0; k < length; k++) {
      if (edgeAt(k)) { if (start < 0) start = k; }
      else flush(k);
    }
    flush(length);
  };
  const safe = (h, fallback) => (Number.isNaN(h) ? fallback : h);

  // Edges along x, between row cz-1 and row cz (vz = cz).
  for (let vz = 0; vz <= rows; vz++) {
    const edge = (cx) => cx < cols && walk(cx, vz - 1) !== walk(cx, vz);
    const lineY = (vx) => safe(corner(vx, vz), 0);
    runs(cols, edge, lineY, (a, b) => wall(wx(a), wz(vz), lineY(a), wx(b), wz(vz), lineY(b)));
  }
  // Edges along z, between column cx-1 and column cx (vx = cx).
  for (let vx = 0; vx <= cols; vx++) {
    const edge = (cz) => cz < rows && walk(vx - 1, cz) !== walk(vx, cz);
    const lineY = (vz) => safe(corner(vx, vz), 0);
    runs(rows, edge, lineY, (a, b) => wall(wx(vx), wz(a), lineY(a), wx(vx), wz(b), lineY(b)));
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  const index = new (positions.length / 3 > 65535 ? Uint32Array : Uint16Array)(positions.length / 3);
  for (let i = 0; i < index.length; i++) index[i] = i;
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.computeBoundingBox();

  const mesh = new Mesh(geometry, new MeshBasicMaterial({ visible: false }));
  mesh.name = 'nav-collision';
  const group = new Group();
  group.name = 'nav-collision';
  group.add(mesh);
  return { group, triangles: positions.length / 9 };
}
