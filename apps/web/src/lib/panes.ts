/**
 * The center column's split panes, as Paseo's workspace layout (packages/app/src/stores/
 * workspace-layout-actions.ts, utils/split-navigation.ts): a tree of groups, each laid out in a
 * row (horizontal) or a column (vertical) with a size per child, whose leaves are panes. Every
 * pane has its own tab row; one pane has focus, and the workspace's actions (new tab, close tab,
 * previous/next tab) act on it.
 *
 * Tabs themselves live in app/tabs.tsx; here a tab is its key (`agent:<id>`, `panel:tasks`…).
 * `assign` says which pane a tab sits in (a tab not in it sits in the focused pane, where Paseo
 * opens new tabs) and `actives` which tab each pane shows.
 *
 * Plain data, so it can be tested and kept in localStorage (lib/layout.ts).
 */

export type PaneNode = { kind: 'pane'; id: string; };

export type GroupNode = { kind: 'group'; id: string; direction: 'horizontal' | 'vertical'; children: SplitNode[]; sizes: number[]; };

export type SplitNode = PaneNode | GroupNode;

export type Panes = { root: SplitNode; focused: string; assign: Record<string, string>; actives: Record<string, string>; };

export type Direction = 'left' | 'right' | 'up' | 'down';

export type SplitPosition = 'left' | 'right' | 'top' | 'bottom';

export const MAIN_PANE = 'main';
/** Paseo's MAX_TREE_DEPTH: a split that would nest deeper is refused. */
export const MAX_TREE_DEPTH = 5;
/** Paseo's MIN_SPLIT_SIZE: no pane shrinks below this share of its group. */
export const MIN_SPLIT_SIZE = 0.1;
/** Paseo's drop zones on a pane: the edges (15%) split it, the center (40%) moves the tab into it. */
export const EDGE_RATIO = 0.15;
export const CENTER_RATIO = 0.4;
const MAX_PANES = 16;
/** A pane map key: a tab key, `file:` and a workspace path of up to 1024 characters (layout.js PATH_CHARS) included. */
const ID_CHARS = 1030;

export const singlePane = (): Panes => ({ root: { kind: 'pane', id: MAIN_PANE }, focused: MAIN_PANE, assign: {}, actives: {} });

/** The panes' ids, in reading order. */
export function paneIds(node: SplitNode): string[] {
  return node.kind === 'pane' ? [node.id] : node.children.flatMap(paneIds);
}

export function treeDepth(node: SplitNode): number {
  return node.kind === 'pane' ? 1 : 1 + Math.max(...node.children.map(treeDepth));
}

const nodeIds = (node: SplitNode): string[] => node.kind === 'pane' ? [node.id] : [node.id, ...node.children.flatMap(nodeIds)];

/** A fresh id for a pane or group of this tree. */
function nextId(root: SplitNode, kind: 'pane' | 'group') {
  const taken = new Set(nodeIds(root));
  let n = 1;
  while (taken.has(`${kind}-${n}`)) n += 1;
  return `${kind}-${n}`;
}

/** The pane `key` sits in. */
export function paneOf(panes: Panes, key: string) {
  const ids = paneIds(panes.root);
  const assigned = panes.assign[key];
  if (assigned && ids.includes(assigned)) return assigned;
  return ids.includes(panes.focused) ? panes.focused : ids[0];
}

/** Each pane's tabs, in the row's order. */
export function tabsByPane<T>(panes: Panes, tabs: T[], key: (tab: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = Object.fromEntries(paneIds(panes.root).map(id => [id, []]));
  for (const tab of tabs) out[paneOf(panes, key(tab))].push(tab);
  return out;
}

/** The path (child indexes) to a pane, or null. */
function pathTo(node: SplitNode, id: string): number[] | null {
  if (node.kind === 'pane') return node.id === id ? [] : null;
  for (let index = 0; index < node.children.length; index += 1) {
    const rest = pathTo(node.children[index], id);
    if (rest) return [index, ...rest];
  }
  return null;
}

const nodeAt = (node: SplitNode, path: number[]): SplitNode => path.reduce((current, index) => (current as GroupNode).children[index], node);

function replaceAt(node: SplitNode, path: number[], change: (node: SplitNode) => SplitNode): SplitNode {
  if (!path.length) return change(node);
  const group = node as GroupNode;
  const [index, ...rest] = path;
  return { ...group, children: group.children.map((child, at) => at === index ? replaceAt(child, rest, change) : child) };
}

/**
 * Splits `target`: a new pane at `position` beside it, holding `key`, gets the focus. Inside a
 * group of the same direction the new pane takes half of the target's share; otherwise the target
 * becomes a group of the two, half each. Null when the target is unknown or the tree would get
 * too deep.
 */
export function splitPane(panes: Panes, { target, position, key }: { target: string; position: SplitPosition; key?: string; }): Panes | null {
  const path = pathTo(panes.root, target);
  if (!path) return null;
  const direction = position === 'left' || position === 'right' ? 'horizontal' : 'vertical';
  const after = position === 'right' || position === 'bottom';
  const id = nextId(panes.root, 'pane');
  const pane: PaneNode = { kind: 'pane', id };
  const parentPath = path.slice(0, -1);
  const parent = path.length ? (nodeAt(panes.root, parentPath) as GroupNode) : null;
  const at = path[path.length - 1] ?? 0;
  let root;
  if (parent && parent.direction === direction) {
    const share = parent.sizes[at] ?? 0;
    const insert = after ? at + 1 : at;
    const sizes = parent.sizes.slice();
    sizes.splice(insert, 0, share / 2);
    sizes[at + (after ? 0 : 1)] = share / 2;
    const children = parent.children.slice();
    children.splice(insert, 0, pane);
    root = replaceAt(panes.root, parentPath, () => ({ ...parent, children, sizes }));
  } else {
    const groupId = nextId(panes.root, 'group');
    root = replaceAt(panes.root, path, node => ({ kind: 'group', id: groupId, direction, children: after ? [node, pane] : [pane, node], sizes: [0.5, 0.5] } as GroupNode));
  }
  if (treeDepth(root) > MAX_TREE_DEPTH) return null;
  return { ...panes, root, focused: id, assign: key ? { ...panes.assign, [key]: id } : panes.assign };
}

/**
 * Paseo's side pane (workspace-layout-store ensureSidePane, splitWorkspaceRootRightInLayout): a new
 * pane at the right of the whole center, holding `key`, gets the focus. A root that is already a
 * row gains a last child (the others keep their proportions); otherwise the root and the new pane
 * become a row, half each. Null when the tree would get too deep or hold too many panes.
 */
export function splitRootRight(panes: Panes, key?: string): { panes: Panes; id: string; } | null {
  if (paneIds(panes.root).length >= MAX_PANES) return null;
  const id = nextId(panes.root, 'pane');
  const pane: PaneNode = { kind: 'pane', id };
  let root: SplitNode;
  if (panes.root.kind === 'group' && panes.root.direction === 'horizontal') {
    const count = panes.root.children.length;
    const share = 1 / (count + 1);
    root = { ...panes.root, children: [...panes.root.children, pane], sizes: [...panes.root.sizes.map(size => size * (1 - share)), share] };
  } else {
    root = { kind: 'group', id: nextId(panes.root, 'group'), direction: 'horizontal', children: [panes.root, pane], sizes: [0.5, 0.5] };
  }
  if (treeDepth(root) > MAX_TREE_DEPTH) return null;
  return { panes: { ...panes, root, focused: id, assign: key ? { ...panes.assign, [key]: id } : panes.assign }, id };
}

/**
 * The pane next to `id` in its tree: the nearest one before it at the lowest level, else the
 * nearest after (Paseo's findNearestSiblingPaneId). Null for the only pane.
 */
export function nearestPane(root: SplitNode, id: string) {
  const path = pathTo(root, id);
  if (!path || !path.length) return null;
  for (let depth = path.length - 1; depth >= 0; depth -= 1) {
    const parent = nodeAt(root, path.slice(0, depth)) as GroupNode;
    const index = path[depth];
    for (let at = index - 1; at >= 0; at -= 1) { const ids = paneIds(parent.children[at]); if (ids.length) return ids[ids.length - 1]; }
    for (let at = index + 1; at < parent.children.length; at += 1) { const ids = paneIds(parent.children[at]); if (ids.length) return ids[0]; }
  }
  return null;
}

/**
 * Removes a pane; its group gives its share back to the others (a group left with one child
 * becomes that child). The last pane stays: null. Tabs assigned to it lose their place (the caller
 * closes them or they move to the focused pane).
 */
export function removePane(panes: Panes, id: string): Panes | null {
  const path = pathTo(panes.root, id);
  if (!path || !path.length) return null;
  const fallback = nearestPane(panes.root, id);
  const parentPath = path.slice(0, -1);
  const parent = nodeAt(panes.root, parentPath) as GroupNode;
  const index = path[path.length - 1];
  const children = parent.children.filter((_, at) => at !== index);
  const sizes = parent.sizes.filter((_, at) => at !== index);
  const total = sizes.reduce((sum, size) => sum + size, 0) || 1;
  const root = replaceAt(panes.root, parentPath, () => children.length === 1 ? children[0] : { ...parent, children, sizes: sizes.map(size => size / total) });
  const assign = Object.fromEntries(Object.entries(panes.assign).filter(([, pane]) => pane !== id));
  const actives = Object.fromEntries(Object.entries(panes.actives).filter(([pane]) => pane !== id));
  const focused = panes.focused === id ? (fallback ?? paneIds(root)[0]) : panes.focused;
  return { root, focused, assign, actives };
}

/** `key` moves into pane `to`, which gets the focus. */
export function moveToPane(panes: Panes, key: string, to: string): Panes {
  if (!paneIds(panes.root).includes(to)) return panes;
  return { ...panes, focused: to, assign: { ...panes.assign, [key]: to }, actives: { ...panes.actives, [to]: key } };
}

/** Sizes made to add up to 1 with none under MIN_SPLIT_SIZE (Paseo's clampNormalizedSizes). */
export function clampSizes(sizes: number[]): number[] {
  const count = sizes.length;
  if (!count) return [];
  if (count === 1) return [1];
  if (count * MIN_SPLIT_SIZE > 1) return sizes.map(() => 1 / count);
  const clean = sizes.map(size => Number.isFinite(size) && size > 0 ? size : 0);
  const sum = clean.reduce((total, size) => total + size, 0);
  const normal = sum > 0 ? clean.map(size => size / sum) : clean.map(() => 1 / count);
  const out = normal.map(() => 0);
  const open = new Set(normal.map((_, index) => index));
  let remaining = 1;
  while (open.size) {
    let weight = 0;
    for (const index of open) weight += normal[index];
    if (weight <= 0) { for (const index of open) out[index] = remaining / open.size; break; }
    const locked = [...open].filter(index => normal[index] / weight * remaining < MIN_SPLIT_SIZE);
    if (!locked.length) { for (const index of open) out[index] = normal[index] / weight * remaining; break; }
    for (const index of locked) { out[index] = MIN_SPLIT_SIZE; open.delete(index); remaining -= MIN_SPLIT_SIZE; }
  }
  return out;
}

/** A group's sizes, clamped. */
export function resizeGroup(panes: Panes, groupId: string, sizes: number[]): Panes {
  const visit = (node: SplitNode): SplitNode => node.kind === 'pane' ? node
    : node.id === groupId && sizes.length === node.children.length ? { ...node, sizes: clampSizes(sizes) }
      : { ...node, children: node.children.map(visit) };
  return { ...panes, root: visit(panes.root) };
}

/** Each pane's box in a unit square. */
export function paneBounds(node: SplitNode, box: { left: number; top: number; right: number; bottom: number; } = { left: 0, top: 0, right: 1, bottom: 1 }): Array<{ id: string; left: number; top: number; right: number; bottom: number; }> {
  if (node.kind === 'pane') return [{ id: node.id, ...box }];
  const out = [];
  let offset = 0;
  for (let index = 0; index < node.children.length; index += 1) {
    const size = node.sizes[index] ?? 0;
    if (node.direction === 'horizontal') {
      const width = box.right - box.left;
      out.push(...paneBounds(node.children[index], { ...box, left: box.left + width * offset, right: box.left + width * (offset + size) }));
    } else {
      const height = box.bottom - box.top;
      out.push(...paneBounds(node.children[index], { ...box, top: box.top + height * offset, bottom: box.top + height * (offset + size) }));
    }
    offset += size;
  }
  return out;
}

const TOLERANCE = 0.000001;

/**
 * The pane to `direction` of `id` (Paseo's findAdjacentPane): the closest one on that side, then
 * the one least offset across, the most overlapping, the nearest center. Null when none.
 */
export function adjacentPane(root: SplitNode, id: string, direction: Direction) {
  const boxes = paneBounds(root);
  const from = boxes.find(box => box.id === id);
  if (!from) return null;
  const horizontal = direction === 'left' || direction === 'right';
  const gap = (a1: number, a2: number, b1: number, b2: number) => a2 < b1 ? b1 - a2 : b2 < a1 ? a1 - b2 : 0;
  const overlap = (a1: number, a2: number, b1: number, b2: number) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
  const candidates = boxes.filter(box => box.id !== id).map(box => {
    const primary = direction === 'left' ? from.left - box.right : direction === 'right' ? box.left - from.right : direction === 'up' ? from.top - box.bottom : box.top - from.bottom;
    if (primary < -TOLERANCE) return null;
    const [a1, a2, b1, b2] = horizontal ? [box.top, box.bottom, from.top, from.bottom] : [box.left, box.right, from.left, from.right];
    const center = horizontal ? Math.abs((box.top + box.bottom) / 2 - (from.top + from.bottom) / 2) : Math.abs((box.left + box.right) / 2 - (from.left + from.right) / 2);
    return { id: box.id, primary, secondary: gap(a1, a2, b1, b2), overlap: overlap(a1, a2, b1, b2), center };
  }).filter(candidate => !!candidate);
  candidates.sort((a, b) => a.primary - b.primary
    || a.secondary - b.secondary
    || b.overlap - a.overlap
    || a.center - b.center
    || String(a?.id).localeCompare(String(b?.id)));
  return candidates[0]?.id ?? null;
}

/**
 * Where a tab dropped at (x, y) in a pane of `width` × `height` goes (Paseo's
 * resolveSplitDropPosition): the center moves it into the pane, an edge splits the pane there.
 */
export function dropPosition({ width, height, x, y }: { width: number; height: number; x: number; y: number; }): 'center' | SplitPosition {
  const insetX = width * ((1 - CENTER_RATIO) / 2);
  const insetY = height * ((1 - CENTER_RATIO) / 2);
  if (x >= insetX && x <= width - insetX && y >= insetY && y <= height - insetY) return 'center';
  if (x <= width * EDGE_RATIO) return 'left';
  if (x >= width - width * EDGE_RATIO) return 'right';
  if (y <= height * EDGE_RATIO) return 'top';
  if (y >= height - height * EDGE_RATIO) return 'bottom';
  const distances: Array<[SplitPosition, number]> = [['left', x], ['right', width - x], ['top', y], ['bottom', height - y]];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0][0];
}

const isRecord = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= ID_CHARS;

function parseNode(value: unknown, seen: Set<string>, depth: number): SplitNode | null {
  if (!isRecord(value) || depth > MAX_TREE_DEPTH) return null;
  const record = value as Record<string, unknown>;
  if (!isId(record.id) || seen.has(record.id)) return null;
  seen.add(record.id);
  if (record.kind === 'pane') return { kind: 'pane', id: record.id };
  if (record.kind !== 'group' || (record.direction !== 'horizontal' && record.direction !== 'vertical')) return null;
  if (!Array.isArray(record.children) || !Array.isArray(record.sizes) || record.children.length !== record.sizes.length || record.children.length < 2) return null;
  const children = [];
  for (const child of record.children) {
    const node = parseNode(child, seen, depth + 1);
    if (!node) return null;
    children.push(node);
  }
  const sizes = record.sizes.map(size => typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 0);
  return { kind: 'group', id: record.id, direction: record.direction, children, sizes: clampSizes(sizes) };
}

/**
 * Saved panes, checked: a tree of known shape, at most 16 panes, no deeper than Paseo's limit;
 * `assign` and `actives` only name its panes. Anything else: undefined (one pane).
 */
export function parsePanes(value: unknown): Panes | undefined {
  if (!isRecord(value)) return undefined;
  const record = value as Record<string, unknown>;
  const root = parseNode(record.root, new Set(), 1);
  if (!root || root.kind === 'pane') return undefined;
  const ids = paneIds(root);
  if (ids.length > MAX_PANES) return undefined;
  const pairs = (map: unknown, keep: (key: string, pane: string) => boolean): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!isRecord(map)) return out;
    for (const [key, pane] of Object.entries(map as Record<string, unknown>).slice(0, 100)) if (isId(key) && isId(pane) && keep(key, pane)) out[key] = pane;
    return out;
  };
  const assign = pairs(record.assign, (_, pane) => ids.includes(pane));
  const actives = pairs(record.actives, pane => ids.includes(pane));
  const focused = isId(record.focused) && ids.includes(record.focused) ? record.focused : ids[0];
  return { root, focused, assign, actives };
}
