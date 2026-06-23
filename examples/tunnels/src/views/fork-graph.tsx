import type { FC } from "hono/jsx";

import type {
  ForkTreeView,
  ForkTreeNodeView,
} from "@internet-privacy/marmot-ts/client";

const COL_W = 130;
const ROW_H = 56;
const MARGIN_X = 28;
const MARGIN_Y = 30;
const R = 9;

interface Placed {
  node: ForkTreeNodeView;
  depth: number;
  lane: number;
}

/**
 * Lay the fork tree out git-graph style: x grows with commit depth from the
 * root, each branch gets its own horizontal lane. The canonical branch is
 * pulled to lane 0 by ordering canonical children first, so the live history
 * reads as a straight line with forks dropping below it.
 */
function layout(view: ForkTreeView): {
  placed: Map<string, Placed>;
  maxDepth: number;
  lanes: number;
} {
  const byTag = new Map(view.nodes.map((n) => [n.tag, n]));
  const onCanonical = new Set(view.canonicalPath);

  const depth = new Map<string, number>();
  const computeDepth = (tag: string): number => {
    const cached = depth.get(tag);
    if (cached !== undefined) return cached;
    const node = byTag.get(tag);
    const d = node?.parentTag ? computeDepth(node.parentTag) + 1 : 0;
    depth.set(tag, d);
    return d;
  };
  for (const n of view.nodes) computeDepth(n.tag);

  const orderChildren = (children: string[]): string[] =>
    [...children].sort((a, b) => {
      const ca = onCanonical.has(a) ? 0 : 1;
      const cb = onCanonical.has(b) ? 0 : 1;
      if (ca !== cb) return ca - cb;
      const ea = byTag.get(a)?.epoch ?? 0;
      const eb = byTag.get(b)?.epoch ?? 0;
      return ea - eb || (a < b ? -1 : 1);
    });

  const lane = new Map<string, number>();
  let nextLane = 0;
  const visit = (tag: string): number => {
    const node = byTag.get(tag);
    const kids = node ? orderChildren(node.childTags) : [];
    if (kids.length === 0) {
      const l = nextLane++;
      lane.set(tag, l);
      return l;
    }
    let first = 0;
    kids.forEach((kid, i) => {
      const l = visit(kid);
      if (i === 0) first = l;
    });
    lane.set(tag, first);
    return first;
  };
  if (view.rootTag) visit(view.rootTag);
  // Defensive: place any node not reachable from the root on its own lane.
  for (const n of view.nodes) if (!lane.has(n.tag)) lane.set(n.tag, nextLane++);

  const placed = new Map<string, Placed>();
  for (const n of view.nodes) {
    placed.set(n.tag, {
      node: n,
      depth: depth.get(n.tag) ?? 0,
      lane: lane.get(n.tag) ?? 0,
    });
  }
  return {
    placed,
    maxDepth: Math.max(0, ...[...depth.values()]),
    lanes: nextLane || 1,
  };
}

const cx = (depth: number) => MARGIN_X + depth * COL_W + R;
const cy = (lane: number) => MARGIN_Y + lane * ROW_H + R;

function nodeColor(n: ForkTreeNodeView): string {
  if (n.canonical) return "var(--accent)";
  if (n.isTip) return "var(--tip)";
  return "var(--muted)";
}

/**
 * Render a {@link ForkTreeView} as an inline SVG branching timeline. Canonical
 * nodes are blue (the live branch), abandoned fork tips green, fork points
 * ringed amber, and the live tip carries a double ring. Each node is a link to
 * its own epoch page and is annotated with the number of application messages
 * decrypted at that exact state.
 */
export const ForkGraph: FC<{
  view: ForkTreeView;
  /** Group id, for building per-epoch links. */
  groupId: string;
  /** Application-message count keyed by node tag. */
  countByTag: Map<string, number>;
}> = ({ view, groupId, countByTag }) => {
  if (!view.nodes.length) {
    return <div class="empty">No history recorded yet.</div>;
  }
  const { placed, maxDepth, lanes } = layout(view);
  const width = MARGIN_X * 2 + maxDepth * COL_W + 2 * R + 60;
  const height = MARGIN_Y * 2 + lanes * ROW_H;

  const edges = [...placed.values()].flatMap(({ node, depth, lane }) => {
    if (!node.parentTag) return [];
    const parent = placed.get(node.parentTag);
    if (!parent) return [];
    const x1 = cx(parent.depth);
    const y1 = cy(parent.lane);
    const x2 = cx(depth);
    const y2 = cy(lane);
    const midX = (x1 + x2) / 2;
    const stroke = node.canonical ? "var(--accent-dim)" : "var(--border)";
    return [
      <path
        d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
        fill="none"
        stroke={stroke}
        stroke-width={node.canonical ? 2.5 : 1.5}
      />,
    ];
  });

  return (
    <div class="graph-wrap" id="fork-graph-wrap">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
      >
        {edges}
        {[...placed.values()].map(({ node, depth, lane }) => {
          const x = cx(depth);
          const y = cy(lane);
          const color = nodeColor(node);
          const isFork = node.childTags.length > 1;
          const count = countByTag.get(node.tag) ?? 0;
          return (
            <a href={`/${groupId}/${node.tag}`} class="node-link">
              <title>
                {`epoch ${node.epoch} · ${node.tag.slice(0, 12)} · ${count} message${count === 1 ? "" : "s"}`}
              </title>
              {node.isCanonicalTip && (
                <circle
                  cx={x}
                  cy={y}
                  r={R + 4}
                  fill="none"
                  stroke="var(--accent)"
                  stroke-width={1.5}
                />
              )}
              {isFork && (
                <circle
                  cx={x}
                  cy={y}
                  r={R + 4}
                  fill="none"
                  stroke="var(--fork)"
                  stroke-width={1.5}
                />
              )}
              <circle
                cx={x}
                cy={y}
                r={R}
                fill={node.canonical ? color : "var(--bg)"}
                stroke={color}
                stroke-width={2}
              />
              <text
                x={x}
                y={y + 4}
                text-anchor="middle"
                font-size="10"
                fill={node.canonical ? "var(--bg)" : "var(--fg)"}
                font-family="var(--mono)"
              >
                {node.epoch}
              </text>
              <text
                x={x}
                y={y + R + 16}
                text-anchor="middle"
                font-size="10"
                fill="var(--muted)"
                font-family="var(--mono)"
              >
                {node.tag.slice(0, 6)}
              </text>
              {count > 0 && (
                <text
                  x={x}
                  y={y + R + 28}
                  text-anchor="middle"
                  font-size="9"
                  fill="var(--accent)"
                  font-family="var(--mono)"
                >
                  {count} msg
                </text>
              )}
            </a>
          );
        })}
      </svg>
      <div class="legend">
        <span class="l-canon">canonical branch</span>
        <span class="l-tip">fork head</span>
        <span class="l-fork">fork point</span>
        <span class="l-node">node (epoch)</span>
      </div>
      <script
        dangerouslySetInnerHTML={{
          __html:
            "(function(){var el=document.getElementById('fork-graph-wrap');" +
            "if(el)el.scrollLeft=el.scrollWidth;})();",
        }}
      />
    </div>
  );
};
