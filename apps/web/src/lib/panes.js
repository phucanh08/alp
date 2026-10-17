// @ts-check
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
 * Plain data, so it can be tested and kept in localStorage (lib/layout.js).
 */

/**
 * @typedef {{ kind: 'pane', id: string }} PaneNode
 * @typedef {{ kind: 'group', id: string, direction: 'horizontal' | 'vertical', children: SplitNode[], sizes: number[] }} GroupNode
 * @typedef {PaneNode | GroupNode} SplitNode
 * @typedef {{ root: SplitNode, focused: string, assign: Record<string, string>, actives: Record<string, string> }} Panes
 * @typedef {'left' | 'right' | 'up' | 'down'} Direction
 * @typedef {'left' | 'right' | 'top' | 'bottom'} SplitPosition
 */

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

/** @returns {Panes} */
export const singlePane = () => ({ root: { kind: 'pane', id: MAIN_PANE }, focused: MAIN_PANE, assign: {}, actives: {} });

/** The panes' ids, in reading order. @param {SplitNode} node @returns {string[]} */
export function paneIds(node) {
  return node.kind === 'pane' ? [node.id] : node.children.flatMap(paneIds);
}

/** @param {SplitNode} node @returns {number} */
export function treeDepth(node) {
  return node.kind === 'pane' ? 1 : 1 + Math.max(...node.children.map(treeDepth));
}

/** @param {SplitNode} node @returns {string[]} */
const nodeIds = node => node.kind === 'pane' ? [node.id] : [node.id, ...node.children.flatMap(nodeIds)];

/** A fresh id for a pane or group of this tree. @param {SplitNode} root @param {'pane' | 'group'} kind */
function nextId(root, kind) {
  const taken = new Set(nodeIds(root));
  let n = 1;
  while (taken.has(`${kind}-${n}`)) n += 1;
  return `${kind}-${n}`;
}

/** The pane `key` sits in. @param {Panes} panes @param {string} key */
export function paneOf(panes, key) {
  const ids = paneIds(panes.root);
  const assigned = panes.assign[key];
  if (assigned && ids.includes(assigned)) return assigned;
  return ids.includes(panes.focused) ? panes.focused : ids[0];
}

/**
 * Each pane's tabs, in the row's order.
 * @template T @param {Panes} panes @param {T[]} tabs @param {(tab: T) => string} key
 * @returns {Record<string, T[]>}
 */
export function tabsByPane(panes, tabs, key) {
  /** @type {Record<string, T[]>} */
  const out = Object.fromEntries(paneIds(panes.root).map(id => [id, []]));
  for (const tab of tabs) out[paneOf(panes, key(tab))].push(tab);
  return out;
}

/** The path (child indexes) to a pane, or null. @param {SplitNode} node @param {string} id @returns {number[] | null} */
function pathTo(node, id) {
  if (node.kind === 'pane') return node.id === id ? [] : null;
  for (let index = 0; index < node.children.length; index += 1) {
    const rest = pathTo(node.children[index], id);
    if (rest) return [index, ...rest];
  }
  return null;
}

/** @param {SplitNode} node @param {number[]} path @returns {SplitNode} */
const nodeAt = (node, path) => path.reduce((current, index) => /** @type {GroupNode} */ (current).children[index], node);

/** @param {SplitNode} node @param {number[]} path @param {(node: SplitNode) => SplitNode} change @returns {SplitNode} */
function replaceAt(node, path, change) {
  if (!path.length) return change(node);
  const group = /** @type {GroupNode} */ (node);
  const [index, ...rest] = path;
  return { ...group, children: group.children.map((child, at) => at === index ? replaceAt(child, rest, change) : child) };
}

/**
 * Splits `target`: a new pane at `position` beside it, holding `key`, gets the focus. Inside a
 * group of the same direction the new pane takes half of the target's share; otherwise the target
 * becomes a group of the two, half each. Null when the target is unknown or the tree would get
 * too deep.
 * @param {Panes} panes @param {{ target: string, position: SplitPosition, key?: string }} input
 * @returns {Panes | null}
 */
export function splitPane(panes, { target, position, key }) {
  const path = pathTo(panes.root, target);
  if (!path) return null;
  const direction = position === 'left' || position === 'right' ? 'horizontal' : 'vertical';
  const after = position === 'right' || position === 'bottom';
  const id = nextId(panes.root, 'pane');
  /** @type {PaneNode} */
  const pane = { kind: 'pane', id };
  const parentPath = path.slice(0, -1);
  const parent = path.length ? /** @type {GroupNode} */ (nodeAt(panes.root, parentPath)) : null;
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
    root = replaceAt(panes.root, path, node => /** @type {GroupNode} */ ({ kind: 'group', id: groupId, direction, children: after ? [node, pane] : [pane, node], sizes: [0.5, 0.5] }));
  }
  if (treeDepth(root) > MAX_TREE_DEPTH) return null;
  return { ...panes, root, focused: id, assign: key ? { ...panes.assign, [key]: id } : panes.assign };
}

/**
 * The pane next to `id` in its tree: the nearest one before it at the lowest level, else the
 * nearest after (Paseo's findNearestSiblingPaneId). Null for the only pane.
 * @param {SplitNode} root @param {string} id
 */
export function nearestPane(root, id) {
  const path = pathTo(root, id);
  if (!path || !path.length) return null;
  for (let depth = path.length - 1; depth >= 0; depth -= 1) {
    const parent = /** @type {GroupNode} */ (nodeAt(root, path.slice(0, depth)));
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
 * @param {Panes} panes @param {string} id @returns {Panes | null}
 */
export function removePane(panes, id) {
  const path = pathTo(panes.root, id);
  if (!path || !path.length) return null;
  const fallback = nearestPane(panes.root, id);
  const parentPath = path.slice(0, -1);
  const parent = /** @type {GroupNode} */ (nodeAt(panes.root, parentPath));
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

/** `key` moves into pane `to`, which gets the focus. @param {Panes} panes @param {string} key @param {string} to @returns {Panes} */
export function moveToPane(panes, key, to) {
  if (!paneIds(panes.root).includes(to)) return panes;
  return { ...panes, focused: to, assign: { ...panes.assign, [key]: to }, actives: { ...panes.actives, [to]: key } };
}

/**
 * Sizes made to add up to 1 with none under MIN_SPLIT_SIZE (Paseo's clampNormalizedSizes).
 * @param {number[]} sizes @returns {number[]}
 */
export function clampSizes(sizes) {
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

/** A group's sizes, clamped. @param {Panes} panes @param {string} groupId @param {number[]} sizes @returns {Panes} */
export function resizeGroup(panes, groupId, sizes) {
  /** @param {SplitNode} node @returns {SplitNode} */
  const visit = node => node.kind === 'pane' ? node
    : node.id === groupId && sizes.length === node.children.length ? { ...node, sizes: clampSizes(sizes) }
      : { ...node, children: node.children.map(visit) };
  return { ...panes, root: visit(panes.root) };
}

/**
 * Each pane's box in a unit square. @param {SplitNode} node
 * @param {{ left: number, top: number, right: number, bottom: number }} [box]
 * @returns {Array<{ id: string, left: number, top: number, right: number, bottom: number }>}
 */
export function paneBounds(node, box = { left: 0, top: 0, right: 1, bottom: 1 }) {
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
 * @param {SplitNode} root @param {string} id @param {Direction} direction
 */
export function adjacentPane(root, id, direction) {
  const boxes = paneBounds(root);
  const from = boxes.find(box => box.id === id);
  if (!from) return null;
  const horizontal = direction === 'left' || direction === 'right';
  const gap = (/** @type {number} */ a1, /** @type {number} */ a2, /** @type {number} */ b1, /** @type {number} */ b2) => a2 < b1 ? b1 - a2 : b2 < a1 ? a1 - b2 : 0;
  const overlap = (/** @type {number} */ a1, /** @type {number} */ a2, /** @type {number} */ b1, /** @type {number} */ b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
  const candidates = boxes.filter(box => box.id !== id).map(box => {
    const primary = direction === 'left' ? from.left - box.right : direction === 'right' ? box.left - from.right : direction === 'up' ? from.top - box.bottom : box.top - from.bottom;
    if (primary < -TOLERANCE) return null;
    const [a1, a2, b1, b2] = horizontal ? [box.top, box.bottom, from.top, from.bottom] : [box.left, box.right, from.left, from.right];
    const center = horizontal ? Math.abs((box.top + box.bottom) / 2 - (from.top + from.bottom) / 2) : Math.abs((box.left + box.right) / 2 - (from.left + from.right) / 2);
    return { id: box.id, primary, secondary: gap(a1, a2, b1, b2), overlap: overlap(a1, a2, b1, b2), center };
  }).filter(candidate => !!candidate);
  candidates.sort((a, b) => /** @type {any} */ (a).primary - /** @type {any} */ (b).primary
    || /** @type {any} */ (a).secondary - /** @type {any} */ (b).secondary
    || /** @type {any} */ (b).overlap - /** @type {any} */ (a).overlap
    || /** @type {any} */ (a).center - /** @type {any} */ (b).center
    || String(a?.id).localeCompare(String(b?.id)));
  return candidates[0]?.id ?? null;
}

/**
 * Where a tab dropped at (x, y) in a pane of `width` × `height` goes (Paseo's
 * resolveSplitDropPosition): the center moves it into the pane, an edge splits the pane there.
 * @param {{ width: number, height: number, x: number, y: number }} input
 * @returns {'center' | SplitPosition}
 */
export function dropPosition({ width, height, x, y }) {
  const insetX = width * ((1 - CENTER_RATIO) / 2);
  const insetY = height * ((1 - CENTER_RATIO) / 2);
  if (x >= insetX && x <= width - insetX && y >= insetY && y <= height - insetY) return 'center';
  if (x <= width * EDGE_RATIO) return 'left';
  if (x >= width - width * EDGE_RATIO) return 'right';
  if (y <= height * EDGE_RATIO) return 'top';
  if (y >= height - height * EDGE_RATIO) return 'bottom';
  /** @type {Array<[SplitPosition, number]>} */
  const distances = [['left', x], ['right', width - x], ['top', y], ['bottom', height - y]];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0][0];
}

/** @param {unknown} value */
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value @returns {value is string} */
const isId = value => typeof value === 'string' && !!value.trim() && value.length <= ID_CHARS;

/** @param {unknown} value @param {Set<string>} seen @param {number} depth @returns {SplitNode | null} */
function parseNode(value, seen, depth) {
  if (!isRecord(value) || depth > MAX_TREE_DEPTH) return null;
  const record = /** @type {Record<string, unknown>} */ (value);
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
 * @param {unknown} value @returns {Panes | undefined}
 */
export function parsePanes(value) {
  if (!isRecord(value)) return undefined;
  const record = /** @type {Record<string, unknown>} */ (value);
  const root = parseNode(record.root, new Set(), 1);
  if (!root || root.kind === 'pane') return undefined;
  const ids = paneIds(root);
  if (ids.length > MAX_PANES) return undefined;
  /** @param {unknown} map @param {(key: string, pane: string) => boolean} keep @returns {Record<string, string>} */
  const pairs = (map, keep) => {
    /** @type {Record<string, string>} */
    const out = {};
    if (!isRecord(map)) return out;
    for (const [key, pane] of Object.entries(/** @type {Record<string, unknown>} */ (map)).slice(0, 100)) if (isId(key) && isId(pane) && keep(key, pane)) out[key] = pane;
    return out;
  };
  const assign = pairs(record.assign, (_, pane) => ids.includes(pane));
  const actives = pairs(record.actives, pane => ids.includes(pane));
  const focused = isId(record.focused) && ids.includes(record.focused) ? record.focused : ids[0];
  return { root, focused, assign, actives };
}
