import { app, api, esc, fullName, lifeLine } from './core.js';

const NODE_W = 176;
const NODE_H = 58;
const GAP_X = 24;
const GAP_Y = 70;
const PAD = 40;
const LABEL_W = 90;

export async function renderTree(id) {
  const graph = await api(`/api/people/${id}/tree`);
  const focus = graph.people.find((p) => p.id === graph.focusId);
  document.title = `${fullName(focus)}'s family tree · Family Reunion`;

  app.innerHTML = `
    <div class="tree-toolbar">
      <div>
        <h1 style="margin-bottom:4px">${esc(fullName(focus))}'s family tree</h1>
        <p class="muted" style="margin:0">${graph.people.length} connected ${graph.people.length === 1 ? 'person' : 'people'}${graph.truncated ? ' (showing the closest relatives)' : ''}.
          Select anyone to centre the tree on them; double-click to open their profile.</p>
      </div>
      <div class="actions">
        <span class="legend"><span><i></i>Member</span><span><i class="ancestor"></i>Relative</span><span><i class="memory"></i>In memory</span><span><i class="spouse-line"></i>Married</span></span>
        <a class="btn secondary small" href="#/person/${focus.id}">Back to profile</a>
      </div>
    </div>
    <div class="tree-wrap" id="tree-wrap">${treeSvg(graph)}</div>`;

  const wrap = document.getElementById('tree-wrap');
  wrap.querySelectorAll('.tree-node').forEach((node) => {
    const go = () => (location.hash = `#/tree/${node.dataset.id}`);
    node.addEventListener('click', go);
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
    node.addEventListener('dblclick', () => (location.hash = `#/person/${node.dataset.id}`));
  });
  const focusNode = wrap.querySelector('.tree-node.focus');
  if (focusNode) {
    const box = focusNode.getBBox();
    wrap.scrollLeft = box.x + box.width / 2 - wrap.clientWidth / 2;
    wrap.scrollTop = box.y + box.height / 2 - wrap.clientHeight / 2;
  }
}

// Lays out everyone in generation rows (parents above children, spouses side
// by side) and orders each row to keep parents near their children, then
// draws it as SVG.
function treeSvg(graph) {
  const byId = new Map(graph.people.map((p) => [p.id, { ...p, children: [], spouses: [] }]));
  for (const p of byId.values()) {
    for (const parentId of [p.mother_id, p.father_id]) if (parentId) byId.get(parentId).children.push(p.id);
  }
  for (const m of graph.marriages || []) {
    byId.get(m.person1_id)?.spouses.push(m.person2_id);
    byId.get(m.person2_id)?.spouses.push(m.person1_id);
  }

  // Generation numbers relative to the focus person (parents are -1).
  const gen = new Map([[graph.focusId, 0]]);
  const queue = [graph.focusId];
  while (queue.length) {
    const p = byId.get(queue.shift());
    const g = gen.get(p.id);
    const neighbours = [
      [p.mother_id, g - 1],
      [p.father_id, g - 1],
      ...p.spouses.map((s) => [s, g]),
      ...p.children.map((c) => [c, g + 1]),
    ];
    for (const [nid, ng] of neighbours) {
      if (nid && !gen.has(nid)) {
        gen.set(nid, ng);
        queue.push(nid);
      }
    }
  }

  const gens = [...new Set(gen.values())].sort((a, b) => a - b);
  const rows = new Map(gens.map((g) => [g, []]));
  for (const [pid, g] of gen) rows.get(g).push(pid);

  // Initial ordering: siblings grouped by parents, then by birth date.
  const sortKey = (pid) => {
    const p = byId.get(pid);
    return `${p.mother_id || p.father_id || 0}`.padStart(9, '0') + (p.birth_date || '9999');
  };
  for (const row of rows.values()) row.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  // Barycentre sweeps: order each row by the average position of its
  // neighbours in the adjacent row, alternating downward and upward passes.
  const position = new Map();
  rows.forEach((row) => row.forEach((pid, i) => position.set(pid, i - row.length / 2)));
  const reorder = (g, neighboursOf) => {
    const row = rows.get(g);
    const score = new Map(
      row.map((pid, i) => {
        const ns = neighboursOf(byId.get(pid)).filter((n) => n && gen.get(n) !== g && position.has(n));
        return [pid, ns.length ? ns.reduce((s, n) => s + position.get(n), 0) / ns.length : i - row.length / 2];
      })
    );
    row.sort((a, b) => score.get(a) - score.get(b));
    row.forEach((pid, i) => position.set(pid, i - row.length / 2));
  };
  const keepCouplesTogether = (g) => {
    const row = rows.get(g);
    const placed = new Set();
    const ordered = [];
    for (const pid of row) {
      if (placed.has(pid)) continue;
      ordered.push(pid);
      placed.add(pid);
      for (const s of byId.get(pid).spouses) {
        if (gen.get(s) === g && !placed.has(s)) {
          ordered.push(s);
          placed.add(s);
        }
      }
    }
    rows.set(g, ordered);
    ordered.forEach((pid, i) => position.set(pid, i - ordered.length / 2));
  };
  for (let pass = 0; pass < 6; pass++) {
    for (const g of gens) {
      reorder(g, (p) => [p.mother_id, p.father_id]);
      keepCouplesTogether(g);
    }
    for (const g of [...gens].reverse()) {
      reorder(g, (p) => p.children);
      keepCouplesTogether(g);
    }
  }

  // Assign coordinates; each row is centred in the widest row.
  const widest = Math.max(...[...rows.values()].map((r) => r.length));
  const width = PAD * 2 + LABEL_W + widest * NODE_W + (widest - 1) * GAP_X;
  const height = PAD * 2 + gens.length * NODE_H + (gens.length - 1) * GAP_Y;
  const xy = new Map();
  gens.forEach((g, rowIndex) => {
    const row = rows.get(g);
    const rowWidth = row.length * NODE_W + (row.length - 1) * GAP_X;
    const startX = PAD + LABEL_W + (width - PAD * 2 - LABEL_W - rowWidth) / 2;
    row.forEach((pid, i) => xy.set(pid, { x: startX + i * (NODE_W + GAP_X), y: PAD + rowIndex * (NODE_H + GAP_Y) }));
  });

  const edges = [];
  for (const p of byId.values()) {
    for (const [parentId, kind] of [
      [p.mother_id, 'mother'],
      [p.father_id, 'father'],
    ]) {
      if (!parentId) continue;
      const from = xy.get(parentId);
      const to = xy.get(p.id);
      const x1 = from.x + NODE_W / 2;
      const y1 = from.y + NODE_H;
      const x2 = to.x + NODE_W / 2;
      const y2 = to.y;
      const mid = (y1 + y2) / 2;
      edges.push(`<path class="tree-edge ${kind}" d="M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}" />`);
    }
  }
  for (const m of graph.marriages || []) {
    const a = xy.get(m.person1_id);
    const b = xy.get(m.person2_id);
    if (!a || !b) continue;
    const [left, right] = a.x <= b.x ? [a, b] : [b, a];
    const y = left.y + NODE_H / 2;
    const title = `<title>Married${m.marriage_year ? ` ${m.marriage_year}` : ''}</title>`;
    if (left.y === right.y && right.x - left.x <= NODE_W + GAP_X) {
      edges.push(`<line class="tree-edge spouse" x1="${left.x + NODE_W}" y1="${y}" x2="${right.x}" y2="${y}">${title}</line>`);
    } else {
      // Not side by side: arc over the row between them.
      const x1 = left.x + NODE_W / 2;
      const x2 = right.x + NODE_W / 2;
      edges.push(`<path class="tree-edge spouse" d="M${x1},${left.y} C${x1},${left.y - 30} ${x2},${right.y - 30} ${x2},${right.y}">${title}</path>`);
    }
  }

  const labels = gens.map((g, rowIndex) => {
    const y = PAD + rowIndex * (NODE_H + GAP_Y) + NODE_H / 2 + 4;
    return `<text class="gen-label" x="${PAD}" y="${y}">${esc(generationLabel(g))}</text>`;
  });

  const nodes = [...byId.values()].map((p) => {
    const { x, y } = xy.get(p.id);
    const name = truncate(fullName(p), 22);
    const years = p.deceased
      ? `${p.birth_date ? p.birth_date.slice(0, 4) : '?'}–${p.death_date ? p.death_date.slice(0, 4) : '?'}`
      : p.birth_date
        ? p.birth_date.slice(0, 4)
        : '';
    const sub = truncate([years, p.birth_city].filter(Boolean).join(' · '), 28);
    const cls = ['tree-node', p.registered ? 'member' : '', p.deceased ? 'memory' : '', p.id === graph.focusId ? 'focus' : ''].join(' ');
    return `<g class="${cls}" data-id="${p.id}" tabindex="0" role="link" aria-label="${esc(fullName(p))}">
        <title>${esc(fullName(p))}${lifeLine(p) ? ` — ${esc(lifeLine(p))}` : ''}${p.deceased ? ' (in memory)' : ''}</title>
        <rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="10" />
        <text class="name" x="${x + NODE_W / 2}" y="${y + (sub ? 24 : 33)}" text-anchor="middle">${esc(name)}</text>
        ${sub ? `<text class="sub" x="${x + NODE_W / 2}" y="${y + 42}" text-anchor="middle">${esc(sub)}</text>` : ''}
      </g>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Family tree">
      ${labels.join('')}${edges.join('')}${nodes.join('')}
    </svg>`;
}

function generationLabel(g) {
  if (g === 0) return 'This gen.';
  const up = ['', 'Parents', 'Grandparents', 'Great-GP'];
  const down = ['', 'Children', 'Grandchildren', 'Great-GC'];
  if (g < 0) return up[-g] || `${-g - 2}x Great-GP`;
  return down[g] || `${g - 2}x Great-GC`;
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
