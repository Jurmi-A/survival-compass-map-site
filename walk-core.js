(()=>{// Nationwide walking router over compact tiles built by scripts/build-walk-tiles.py.
// Distance-only reference routes: real-world passability, safety and opening hours are NOT verified.
const R = 6371008.8, TILE = 5000, rad = x => x * Math.PI / 180;
const KINDS = ['road', 'walk', 'steps', 'crossing', 'main'];
function distance(a, b) {
  const y = rad(b.lat - a.lat), x = rad(b.lon - a.lon);
  const h = Math.sin(y / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(x / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
}
const tileOf = p => [Math.floor(p.lon * 1e5 / TILE), Math.floor(p.lat * 1e5 / TILE)];
const tileKey = (x, y) => x + ',' + y;

// ---- Packs and tiles ----
function readPack(bytes) {
  if (bytes[0] !== 68 || bytes[1] !== 87 || bytes[2] !== 50) throw new TypeError('Not a walking pack');
  const n = bytes[3] | bytes[4] << 8 | bytes[5] << 16 | bytes[6] << 24;
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(7, 7 + n)));
  return {region: head.region, tiles: head.tiles, body: bytes.subarray(7 + n)};
}
function decodeTile(raw, x, y) {
  let p = 0;
  const uv = () => { let n = 0, s = 0, b; do { b = raw[p++]; n += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return n; };
  const zz = () => { const n = uv(); return n % 2 ? -(n + 1) / 2 : n / 2; };
  const nv = uv(), vlat = new Int32Array(nv), vlon = new Int32Array(nv);
  let la = y * TILE, lo = x * TILE;
  for (let i = 0; i < nv; i++) { la += uv(); lo += zz(); vlat[i] = la; vlon[i] = lo; }
  const nn = uv(), names = [], td = new TextDecoder();
  for (let i = 0; i < nn; i++) { const l = uv(); names.push(td.decode(raw.subarray(p, p + l))); p += l; }
  const ne = uv(), from = new Uint32Array(ne), toLocal = new Uint32Array(ne), toTile = new Array(ne).fill(null),
    res = new Int32Array(ne), kind = new Uint8Array(ne), dir = new Int8Array(ne), name = new Int32Array(ne).fill(-1), gs = new Uint32Array(ne + 1);
  const g = [];
  let f = 0;
  for (let i = 0; i < ne; i++) {
    f += uv(); from[i] = f; const flags = raw[p++];
    kind[i] = flags & 7; dir[i] = ((flags >> 3) & 3) - 1;
    if (flags & 32) { const dx = zz(), dy = zz(); toTile[i] = tileKey(x + dx, y + dy); toLocal[i] = uv(); }
    else toLocal[i] = f + zz();
    res[i] = zz();
    if (flags & 64) name[i] = uv();
    const np = uv(); gs[i] = g.length / 2; let a = vlat[f], b = vlon[f];
    for (let k = 0; k < np; k++) { a += zz(); b += zz(); g.push(a, b); }
  }
  gs[ne] = g.length / 2;
  if (p !== raw.length) throw new TypeError('Corrupt walking tile');
  return {x, y, key: tileKey(x, y), vlat, vlon, names, from, toLocal, toTile, res, kind, dir, name, gs, geo: Int32Array.from(g)};
}

// Original OSM length = length of the stored shape (same formula as the packer) + stored residual in decimetres.
// The `to` vertex may live in another tile, so this runs once both tiles are loaded.
function edgeLength(t, i, la0, lo0, to, lat, lon) {
  let prev = {lat: la0, lon: lo0}, m = 0;
  for (let k = t.gs[i]; k < t.gs[i + 1]; k++) { const q = {lat: t.geo[2 * k] / 1e5, lon: t.geo[2 * k + 1] / 1e5}; m += distance(prev, q); prev = q; }
  m += distance(prev, {lat: lat[to], lon: lon[to]});
  return Math.max(0.1, (Math.round(m * 10) + t.res[i]) / 10);
}
// ---- Graph over a set of decoded tiles ----
function buildGraph(tiles) {
  const offset = new Map(); let nv = 0, ne = 0;
  for (const t of tiles) { offset.set(t.key, nv); nv += t.vlat.length; ne += t.from.length; }
  const lat = new Float64Array(nv), lon = new Float64Array(nv);
  const eFrom = new Uint32Array(ne), eTo = new Uint32Array(ne), eLen = new Float32Array(ne), eKind = new Uint8Array(ne), eDir = new Int8Array(ne),
    eName = new Array(ne), eTile = new Array(ne), eLocal = new Uint32Array(ne);
  let m = 0;
  for (const t of tiles) {
    const o = offset.get(t.key);
    for (let i = 0; i < t.vlat.length; i++) { lat[o + i] = t.vlat[i] / 1e5; lon[o + i] = t.vlon[i] / 1e5; }
  }
  for (const t of tiles) {
    const o = offset.get(t.key);
    for (let i = 0; i < t.from.length; i++) {
      const to = t.toTile[i] === null ? o + t.toLocal[i] : offset.has(t.toTile[i]) ? offset.get(t.toTile[i]) + t.toLocal[i] : -1;
      if (to < 0) continue; // the neighbouring tile is not loaded: never guess a connection
      eFrom[m] = o + t.from[i]; eTo[m] = to; eLen[m] = edgeLength(t, i, lat[o + t.from[i]], lon[o + t.from[i]], to, lat, lon); eKind[m] = t.kind[i]; eDir[m] = t.dir[i];
      eName[m] = t.name[i] >= 0 ? t.names[t.name[i]] : ''; eTile[m] = t; eLocal[m] = i; m++;
    }
  }
  const deg = new Uint32Array(nv + 1);
  for (let e = 0; e < m; e++) { if (eDir[e] >= 0) deg[eFrom[e] + 1]++; if (eDir[e] <= 0) deg[eTo[e] + 1]++; }
  for (let i = 0; i < nv; i++) deg[i + 1] += deg[i];
  const arcTo = new Uint32Array(deg[nv]), arcEdge = new Uint32Array(deg[nv]), arcRev = new Uint8Array(deg[nv]), fill = deg.slice(0, nv);
  for (let e = 0; e < m; e++) {
    if (eDir[e] >= 0) { const k = fill[eFrom[e]]++; arcTo[k] = eTo[e]; arcEdge[k] = e; }
    if (eDir[e] <= 0) { const k = fill[eTo[e]]++; arcTo[k] = eFrom[e]; arcEdge[k] = e; arcRev[k] = 1; }
  }
  return {nv, ne: m, lat, lon, eFrom, eTo, eLen, eKind, eDir, eName, eTile, eLocal, first: deg, arcTo, arcEdge, arcRev, tiles: new Set(offset.keys())};
}
// Full polyline of an edge, from its `from` vertex to its `to` vertex.
function edgePoints(gr, e) {
  const t = gr.eTile[e], i = gr.eLocal[e], pts = [{lat: gr.lat[gr.eFrom[e]], lon: gr.lon[gr.eFrom[e]]}];
  for (let k = t.gs[i]; k < t.gs[i + 1]; k++) pts.push({lat: t.geo[2 * k] / 1e5, lon: t.geo[2 * k + 1] / 1e5});
  pts.push({lat: gr.lat[gr.eTo[e]], lon: gr.lon[gr.eTo[e]]});
  return pts;
}
function segDistance(p, a, b) {
  const kx = R * Math.cos(rad(p.lat)), ax = kx * rad(a.lon - p.lon), ay = R * rad(a.lat - p.lat), dx = kx * rad(b.lon - a.lon), dy = R * rad(b.lat - a.lat), L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
  return {d: Math.hypot(ax + t * dx, ay + t * dy), t};
}
// Nearest point on a loaded walkable edge, within maxMeters of the selected location.
function snapPoint(gr, p, maxMeters = 40) {
  const dLat = maxMeters / 110540, dLon = maxMeters / (111320 * Math.cos(rad(p.lat)));
  let best = null;
  for (let e = 0; e < gr.ne; e++) {
    const a = gr.eFrom[e], b = gr.eTo[e], t = gr.eTile[e], i = gr.eLocal[e];
    // Quick reject on the vertices plus shape points' bounding box.
    let minLa = Math.min(gr.lat[a], gr.lat[b]), maxLa = Math.max(gr.lat[a], gr.lat[b]), minLo = Math.min(gr.lon[a], gr.lon[b]), maxLo = Math.max(gr.lon[a], gr.lon[b]);
    for (let k = t.gs[i]; k < t.gs[i + 1]; k++) { const la = t.geo[2 * k] / 1e5, lo = t.geo[2 * k + 1] / 1e5; if (la < minLa) minLa = la; if (la > maxLa) maxLa = la; if (lo < minLo) minLo = lo; if (lo > maxLo) maxLo = lo; }
    if (p.lat < minLa - dLat || p.lat > maxLa + dLat || p.lon < minLo - dLon || p.lon > maxLo + dLon) continue;
    const pts = edgePoints(gr, e); let along = 0;
    const lens = []; for (let k = 1; k < pts.length; k++) lens.push(distance(pts[k - 1], pts[k]));
    const total = lens.reduce((s, x) => s + x, 0) || 1;
    for (let k = 1; k < pts.length; k++) {
      const {d, t: tt} = segDistance(p, pts[k - 1], pts[k]);
      if (d <= maxMeters && (!best || d < best.offsetMeters)) {
        const q = {lat: pts[k - 1].lat + (pts[k].lat - pts[k - 1].lat) * tt, lon: pts[k - 1].lon + (pts[k].lon - pts[k - 1].lon) * tt};
        best = {edge: e, seg: k - 1, t: tt, frac: Math.min(1, (along + tt * lens[k - 1]) / total), lat: q.lat, lon: q.lon, offsetMeters: d, selected: {lat: p.lat, lon: p.lon}};
      }
      along += lens[k - 1];
    }
  }
  return best;
}

// Both simplification passes and coordinate rounding can displace the stored path.
const AVOIDANCE_MARGIN = 10;
function touches(pts, zones) {
  for (const z of zones) for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k];
    if (Math.min(a.lat, b.lat) > z.lat + (z.radiusMeters + 50) / 110540 || Math.max(a.lat, b.lat) < z.lat - (z.radiusMeters + 50) / 110540) continue;
    if (segDistance(z, a, b).d <= z.radiusMeters + AVOIDANCE_MARGIN) return true;
  }
  return false;
}
function cut(pts, s) { // split an edge polyline at a snap: [from … snap], [snap … to]
  const q = {lat: s.lat, lon: s.lon};
  return [[...pts.slice(0, s.seg + 1), q], [q, ...pts.slice(s.seg + 1)]];
}

// A* between two snaps on the loaded graph. Lengths are the original OSM distances (never shorter than the straight line).
function route(gr, start, goal, {zones = [], maxVisited = 3000000, maxMs = 6000} = {}) {
  for (const s of [start, goal]) if (zones.some(z => distance(z, s.selected) <= z.radiusMeters)) return {status: 'blocked_selected_location'};
  const n = gr.nv, dist = new Float64Array(n).fill(Infinity), prevArc = new Int32Array(n).fill(-1), done = new Uint8Array(n), zoneState = new Uint8Array(gr.ne);
  const blockedEdge = e => { if (!zones.length) return false; if (!zoneState[e]) zoneState[e] = touches(edgePoints(gr, e), zones) ? 2 : 1; return zoneState[e] === 2; };
  const gEdge = goal.edge, gLen = gr.eLen[gEdge], gPts = cut(edgePoints(gr, gEdge), goal);
  const h = v => distance({lat: gr.lat[v], lon: gr.lon[v]}, goal) * 0.999;
  // Binary heap of (priority, vertex).
  let hp = new Float64Array(1024), hv = new Int32Array(1024), hn = 0;
  const push = (pr, v) => {
    if (hn === hp.length) { const a = new Float64Array(hn * 2), b = new Int32Array(hn * 2); a.set(hp); b.set(hv); hp = a; hv = b; }
    let i = hn++; while (i > 0) { const j = (i - 1) >> 1; if (hp[j] <= pr) break; hp[i] = hp[j]; hv[i] = hv[j]; i = j; } hp[i] = pr; hv[i] = v;
  };
  const pop = () => {
    const v = hv[0], pr = hp[--hn], last = hv[hn]; let i = 0;
    while (2 * i + 1 < hn) { let j = 2 * i + 1; if (j + 1 < hn && hp[j + 1] < hp[j]) j++; if (hp[j] >= pr) break; hp[i] = hp[j]; hv[i] = hv[j]; i = j; }
    hp[i] = pr; hv[i] = last; return v;
  };
  const sEdge = start.edge, sLen = gr.eLen[sEdge], sPts = cut(edgePoints(gr, sEdge), start), dirS = gr.eDir[sEdge];
  // Leaving the start: towards `to` (forward) and/or `from` (backward), on the partial start edge.
  const seeds = [];
  if (dirS >= 0 && !touches(sPts[1], zones)) seeds.push([gr.eTo[sEdge], (1 - start.frac) * sLen, 0]);
  if (dirS <= 0 && !touches(sPts[0], zones)) seeds.push([gr.eFrom[sEdge], start.frac * sLen, 1]);
  for (const [v, c] of seeds) if (c < dist[v]) { dist[v] = c; prevArc[v] = -2; push(c + h(v), v); }
  const seedSide = new Map(seeds.map(([v, , side]) => [v, side]));
  // Arriving at the goal: from `from` going forward, or from `to` going backward, on the partial goal edge.
  const dirG = gr.eDir[gEdge], arrive = new Map();
  if (dirG >= 0 && !touches(gPts[0], zones)) arrive.set(gr.eFrom[gEdge], [goal.frac * gLen, 0]);
  if (dirG <= 0 && !touches(gPts[1], zones)) arrive.set(gr.eTo[gEdge], [(1 - goal.frac) * gLen, 1]);
  let best = Infinity, bestVia = null;
  if (sEdge === gEdge) {
    const forward = goal.frac >= start.frac;
    if ((forward ? dirS >= 0 : dirS <= 0)) {
      const a = Math.min(start.frac, goal.frac), b = Math.max(start.frac, goal.frac), pts = edgePoints(gr, sEdge);
      const lo = a === start.frac ? start : goal, hi = lo === start ? goal : start;
      const seg = [{lat: lo.lat, lon: lo.lon}, ...pts.slice(lo.seg + 1, hi.seg + 1), {lat: hi.lat, lon: hi.lon}];
      if (!touches(seg, zones)) { best = (b - a) * sLen; bestVia = {direct: true, pts: forward ? seg : seg.reverse()}; }
    }
  }
  const started = performance.now(); let visited = 0;
  while (hn) {
    const v = pop(); if (done[v]) continue;
    if (dist[v] + h(v) >= best) break;
    done[v] = 1; visited++;
    if (visited % 4096 === 0 && (visited > maxVisited || performance.now() - started > maxMs)) return {status: 'limit_exceeded', visited};
    const end = arrive.get(v);
    if (end && dist[v] + end[0] < best) { best = dist[v] + end[0]; bestVia = {v, side: end[1]}; }
    for (let k = gr.first[v]; k < gr.first[v + 1]; k++) {
      const w = gr.arcTo[k]; if (done[w]) continue;
      const e = gr.arcEdge[k], c = dist[v] + gr.eLen[e];
      if (c < dist[w] && !blockedEdge(e)) { dist[w] = c; prevArc[w] = k; push(c + h(w), w); }
    }
  }
  if (!bestVia) return {status: 'no_path', visited};
  // Rebuild the polyline with per-segment kind/name for step-by-step guidance.
  const points = [], seg = [], hasStepsKinds = new Set();
  const add = (pts, info) => { for (let i = 0; i < pts.length; i++) { if (points.length && i === 0) continue; if (points.length) seg.push(info); points.push(pts[i]); } };
  const info = e => ({kind: KINDS[gr.eKind[e]], name: gr.eName[e]});
  if (bestVia.direct) add(bestVia.pts, info(sEdge));
  else {
    const arcs = []; let v = bestVia.v;
    while (prevArc[v] >= 0) { const k = prevArc[v]; arcs.push(k); const e = gr.arcEdge[k]; v = gr.arcRev[k] ? gr.eTo[e] : gr.eFrom[e]; }
    arcs.reverse();
    const side = seedSide.get(v);
    add(side === 0 ? sPts[1] : [...sPts[0]].reverse(), info(sEdge));
    for (const k of arcs) { const e = gr.arcEdge[k], pts = edgePoints(gr, e); add(gr.arcRev[k] ? pts.reverse() : pts, info(e)); if (gr.eKind[e] === 2) hasStepsKinds.add(e); }
    add(bestVia.side === 0 ? gPts[0] : [...gPts[1]].reverse(), info(gEdge));
  }
  const hasSteps = hasStepsKinds.size > 0 || [sEdge, gEdge].some(e => gr.eKind[e] === 2);
  return {status: 'found', meters: best, points, seg, hasSteps, visited, assessment: 'distance_only_unverified_conditions'};
}
// Tiles needed to route between two points: their bounding box plus a margin for detours.
function tilesFor(a, b, marginMeters) {
  const dLat = marginMeters / 110540, dLon = marginMeters / (111320 * Math.cos(rad((a.lat + b.lat) / 2)));
  const [x0, y0] = tileOf({lat: Math.min(a.lat, b.lat) - dLat, lon: Math.min(a.lon, b.lon) - dLon});
  const [x1, y1] = tileOf({lat: Math.max(a.lat, b.lat) + dLat, lon: Math.max(a.lon, b.lon) + dLon});
  const out = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(tileKey(x, y));
  return out;
}
function withEndpoints(keys, dependencies) {
  const expanded=new Set(keys);
  for(const key of keys)for(const neighbour of dependencies?.[key]??[])expanded.add(neighbour);
  return [...expanded].sort();
}

window.DURU_WALK_CORE={distance,tileOf,tileKey,readPack,decodeTile,buildGraph,edgePoints,snapPoint,route,tilesFor,withEndpoints,KINDS};})();