(()=>{// Limited regional walking pilot. This is NOT a complete OSM router.
// Input must preserve original node identities, all intermediate points, and coverage metadata.
const R = 6371008.8;
const radians = x => x * Math.PI / 180;
function point(p) {
  if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon) ||
      p.lat < 30 || p.lat > 44 || p.lon < 123 || p.lon > 133) {
    throw new TypeError('Expected finite coordinates in the Korean regional test envelope');
  }
}
function identity(id) {
  if (typeof id !== 'string' || !id.length) throw new TypeError('IDs must be nonempty strings');
}
function distance(a, b) {
  const y = radians(b.lat - a.lat), x = radians(b.lon - a.lon);
  const h = Math.sin(y / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(x / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
}

// Local projection with a 1 m conservative margin; limited to segments <= 1 km.
// Check EVERY original segment; checking just endpoints misses crossings.
function intersectsZone(a, b, zone) {
  point(a); point(b); point(zone);
  if (!Number.isFinite(zone.radiusMeters) || zone.radiusMeters <= 0 || zone.radiusMeters > 1000) {
    throw new TypeError('Invalid avoidance radius');
  }
  if (distance(a, b) > 1000) throw new RangeError('Subdivide long segments before avoidance testing');
  const xy = p => [R * radians(p.lon - zone.lon) * Math.cos(radians(zone.lat)), R * radians(p.lat - zone.lat)];
  const [ax, ay] = xy(a), [bx, by] = xy(b);
  const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
  const t = length2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy) <= zone.radiusMeters + 1;
}

const footRoads = new Set(['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street', 'service', 'footway', 'pedestrian', 'path', 'steps']);
const vehicleRoads = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street', 'service']);
function accessible(tags, mode) {
  if (Object.keys(tags).some(k => k.includes('conditional') || /^(access|foot|vehicle|motor_vehicle|motorcar):(lanes|forward|backward)(:|$)/.test(k) || (k.startsWith('oneway:') && k !== 'oneway:foot'))) return false;
  const keys = mode === 'foot' ? ['foot', 'access'] : ['motorcar', 'motor_vehicle', 'vehicle', 'access'];
  const access = keys.map(k => tags[k]).find(v => v !== undefined);
  // Unknown/destination/private access is excluded, rather than guessed traversable.
  return access === undefined || ['yes', 'designated', 'permissive'].includes(access);
}
function allowed(tags, mode) {
  if (tags.area === 'yes' || tags.construction || tags.proposed || tags.route === 'ferry') return false;
  return (mode === 'foot' ? footRoads : vehicleRoads).has(tags.highway) && accessible(tags, mode);
}

function buildGraph(input, {mode = 'foot'} = {}) {
  if (!['foot', 'vehicle'].includes(mode)) throw new TypeError('Unsupported travel mode');
  const nodes = new Map(), adjacency = new Map();
  for (const n of input.nodes) {
    identity(n.id); point(n);
    if (nodes.has(n.id)) throw new TypeError('Duplicate node identity');
    nodes.set(n.id, {...n}); adjacency.set(n.id, []);
  }
  const issues = [], diagnostics={excludedWays:{},blockedSegments:0};
  if (input.metadata?.barriersChecked !== true) issues.push('barriers_not_checked');
  if (input.metadata?.restrictionsChecked !== true) issues.push('restrictions_not_checked');
  // Turn relations need an edge-state router. Reject such packs until implemented.
  for (const restriction of input.restrictions ?? []) {
    const tags = restriction.tags;
    // Generic OSM restriction=* applies to vehicles. Unknown schemas stay rejected.
    const vehicleOnly = tags?.type === 'restriction' &&
      Object.keys(tags).some(k=>k==='restriction'||k.startsWith('restriction:')) &&
      !Object.keys(tags).some(k=>k==='restriction:foot'||k.startsWith('restriction:foot:'));
    if (mode === 'foot' && vehicleOnly) continue;
    issues.push('turn_restrictions_unsupported');
  }
  const wayIds = new Set();
  for (const way of input.ways) {
    identity(way.id);
    if (wayIds.has(way.id)) throw new TypeError('Duplicate way identity');
    wayIds.add(way.id);
    if (!Array.isArray(way.nodes) || way.nodes.length < 2) throw new TypeError('Invalid way');
    for (const id of way.nodes) {
      identity(id);
      if (!nodes.has(id)) issues.push('missing_node');
    }
    const tags = {...way.tags};
    if (!allowed(tags, mode)) {
      const reason=!(mode==='foot'?footRoads:vehicleRoads).has(tags.highway)?'unsupported_highway':!accessible(tags,mode)?'access_or_conditional':'area_or_lifecycle';
      diagnostics.excludedWays[reason]=(diagnostics.excludedWays[reason]||0)+1;continue;
    }
    const direction = mode === 'foot' ? tags['oneway:foot'] : (tags.oneway ?? (tags.junction === 'roundabout' || tags.highway === 'motorway' ? 'yes' : 'no'));
    if (direction !== undefined && !['yes', '1', 'true', '-1', 'no', '0', 'false'].includes(direction)) {
      issues.push('unknown_direction'); continue;
    }
    for (let i = 1; i < way.nodes.length; i++) {
      const a = nodes.get(way.nodes[i - 1]), b = nodes.get(way.nodes[i]);
      if (!a || !b) continue; // Never connect over an absent intermediate node.
      const meters = distance(a, b);
      if (meters > 1000) { issues.push('long_segment'); continue; }
      const impassable = node => {
        const tags = node.tags ?? {};
        const barrier = tags.barrier;
        const knownFootPassage = mode === 'foot' && ['kerb', 'bollard'].includes(barrier);
        return (barrier && !knownFootPassage) || !accessible(tags, mode);
      };
      if (impassable(a) || impassable(b)) {diagnostics.blockedSegments++;continue;}
      const edge = {wayId:way.id, meters, tags};
      if (direction !== '-1') adjacency.get(a.id).push({...edge, to:b.id});
      if (!['yes', '1', 'true'].includes(direction)) adjacency.get(b.id).push({...edge, to:a.id});
    }
  }
  diagnostics.issueCounts=issues.reduce((counts,key)=>(counts[key]=(counts[key]||0)+1,counts),{});
  return {nodes, adjacency, mode, issues:[...new Set(issues)],diagnostics};
}

function findRoute(graph, start, goal, {zones = [], maxVisited = 100000, maxMs = 1500} = {}) {
  identity(start); identity(goal);
  if (!Number.isSafeInteger(maxVisited) || maxVisited < 1) throw new TypeError('Invalid search budget');
  if (!Number.isFinite(maxMs) || maxMs <= 0 || maxMs > 10000) throw new TypeError('Invalid time budget');
  // Validate even if endpoints/data are unavailable. Expiry never silently removes a zone.
  for (const z of zones) {
    identity(z.id);
    if (!['manual', 'official'].includes(z.source)) throw new TypeError('Unknown zone provenance');
    intersectsZone(z, z, z);
  }
  if (graph.issues.length) return {status:'unsupported_data', issues:[...graph.issues]};
  if (!graph.nodes.has(start) || !graph.nodes.has(goal)) return {status:'outside_data'};
  const blocked = (a, b) => zones.some(z => intersectsZone(a, b, z));
  if (blocked(graph.nodes.get(start), graph.nodes.get(start)) || blocked(graph.nodes.get(goal), graph.nodes.get(goal))) return {status:'blocked_endpoint'};
  const frontier = [];
  function push(entry) {
    frontier.push(entry); let i=frontier.length-1;
    while(i>0){const p=(i-1)>>1;if(frontier[p][1]<=entry[1])break;frontier[i]=frontier[p];i=p;}frontier[i]=entry;
  }
  function pop() {
    const first=frontier[0], last=frontier.pop();
    if(frontier.length){let i=0;while(i*2+1<frontier.length){let j=i*2+1;if(j+1<frontier.length&&frontier[j+1][1]<frontier[j][1])j++;if(frontier[j][1]>=last[1])break;frontier[i]=frontier[j];i=j;}frontier[i]=last;}return first;
  }
  const costs = new Map([[start, 0]]), previous = new Map(), done = new Set();
  const started=performance.now(); push([start,0]);
  let visited = 0;
  while (frontier.length) {
    if (visited >= maxVisited || performance.now()-started > maxMs) return {status:'limit_exceeded', visited};
    const [current,cost]=pop(); if(done.has(current))continue;
    done.add(current); visited++;
    if (current === goal) {
      const nodeIds = [goal], wayIds = []; let hasSteps=false;
      while (nodeIds.at(-1) !== start) {
        const step = previous.get(nodeIds.at(-1));
        nodeIds.push(step.from); wayIds.push(step.wayId);
        hasSteps ||= step.steps;
      }
      nodeIds.reverse(); wayIds.reverse();
      return {status:'found', nodeIds, wayIds, meters:cost, visited, hasSteps,
        assessment:'distance_only_unverified_conditions',
        avoidedZones:zones.map(z => ({id:z.id, source:z.source, observedAt:z.observedAt ?? null}))};
    }
    for (const edge of graph.adjacency.get(current)) {
      if (done.has(edge.to) || blocked(graph.nodes.get(current), graph.nodes.get(edge.to))) continue;
      const next = cost + edge.meters;
      if (next < (costs.get(edge.to) ?? Infinity)) {
        costs.set(edge.to, next); push([edge.to,next]);
        previous.set(edge.to, {from:current, wayId:edge.wayId, steps:edge.tags.highway==='steps'});
      }
    }
  }
  return {status:'no_path', visited};
}

// Candidate on an existing traversable segment. This does not connect the selected
// real-world location across the gap: the user must confirm access to this point.
function snapPoint(graph, selected, maxMeters=40) {
  point(selected); let nearest=null;
  const seen=new Set(), scale=R*Math.cos(radians(selected.lat));
  for(const [from,edges] of graph.adjacency)for(const edge of edges){
    const ids=[from,edge.to].sort(), key=ids.join('/');if(seen.has(key))continue;seen.add(key);
    const a=graph.nodes.get(ids[0]),b=graph.nodes.get(ids[1]);
    const ax=scale*radians(a.lon-selected.lon),ay=R*radians(a.lat-selected.lat);
    const dx=scale*radians(b.lon-a.lon),dy=R*radians(b.lat-a.lat),den=dx*dx+dy*dy;
    const t=den?Math.max(0,Math.min(1,-(ax*dx+ay*dy)/den)):0;
    const p={lat:a.lat+(b.lat-a.lat)*t,lon:a.lon+(b.lon-a.lon)*t};
    const meters=distance(selected,p);
    if(meters<=maxMeters&&(!nearest||meters<nearest.offsetMeters))nearest={...p,a:ids[0],b:ids[1],t,offsetMeters:meters,selected:{lat:selected.lat,lon:selected.lon}};
  }
  return nearest;
}

function routeFromSnaps(graph, start, goal, options={}) {
  for(const p of [start,goal]){point(p);point(p.selected);if(!graph.nodes.has(p.a)||!graph.nodes.has(p.b)||!Number.isFinite(p.t)||p.t<0||p.t>1)throw new TypeError('Invalid confirmed road point');}
  const zones=options.zones??[];
  for(const p of [start,goal])if(zones.some(z=>intersectsZone(p.selected,p.selected,z)))return {status:'blocked_selected_location'};
  const working={...graph,nodes:new Map(graph.nodes),adjacency:new Map(graph.adjacency)};
  const groups=new Map(),endpointIds=[];
  for(const [id,p] of [['__pilot_start',start],['__pilot_goal',goal]]){
    const original=p.t<=1e-9?p.a:p.t>=1-1e-9?p.b:null;
    endpointIds.push(original??id);if(original)continue;
    working.nodes.set(id,{id,lat:p.lat,lon:p.lon});working.adjacency.set(id,[]);
    const key=[p.a,p.b].join('/');if(!groups.has(key))groups.set(key,[]);groups.get(key).push({id,...p});
  }
  for(const group of groups.values()){
    const {a,b}=group[0],chain=[{id:a,t:0},...group.sort((x,y)=>x.t-y.t),{id:b,t:1}];
    const forward=working.adjacency.get(a).filter(e=>e.to===b),reverse=working.adjacency.get(b).filter(e=>e.to===a);
    if(!forward.length&&!reverse.length)throw new TypeError('Road candidate no longer connected');
    working.adjacency.set(a,working.adjacency.get(a).filter(e=>e.to!==b));
    working.adjacency.set(b,working.adjacency.get(b).filter(e=>e.to!==a));
    for(let i=1;i<chain.length;i++){
      const x=chain[i-1],y=chain[i],meters=distance(working.nodes.get(x.id),working.nodes.get(y.id));
      for(const edge of forward)working.adjacency.set(x.id,[...working.adjacency.get(x.id),{...edge,to:y.id,meters}]);
      for(const edge of reverse)working.adjacency.set(y.id,[...working.adjacency.get(y.id),{...edge,to:x.id,meters}]);
    }
  }
  const result=findRoute(working,...endpointIds,options);
  if(result.status==='found')result.points=result.nodeIds.map(id=>{const n=working.nodes.get(id);return {lat:n.lat,lon:n.lon};});
  return result;
}

window.DURU_ROUTING_CORE={buildGraph,findRoute,distance,intersectsZone,snapPoint,routeFromSnaps};})();