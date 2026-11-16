/**
 * The cytoscape boundary — theme, stylesheet, element model, and instance wiring.
 *
 * Extracted from `graph.component.ts` as part of the god-file split. Everything cytoscape-shaped lives
 * here so the component holds no `any`-typed renderer state and no 120-line style literal.
 *
 * ── The line this module draws ───────────────────────────────────────────────────────────────────
 *
 * `buildElements` is pure and is the ONLY thing the characterization tests assert across this
 * boundary: they pin the element model handed to cytoscape, never what cytoscape draws with it. That
 * is deliberate — cytoscape renders to a real canvas that jsdom does not provide, so testing its
 * output would mean testing the mock. Pinning the model instead means this renderer could be replaced
 * wholesale and the tests would still be measuring the right thing.
 *
 * Everything else here — the stylesheet, the theme read, the instance creation — is configuration and
 * wiring, verified by looking at the page rather than by assertion.
 */
import cytoscape from 'cytoscape';
import type { Entity, TraverseNode, TraverseEdge } from '../../core/api.types';

/** Colours read from CSS custom properties, so an enterprise theme can override the whole graph. */
export interface GraphTheme {
  typeColors: string[];
  nodeBg: string;
  nodeText: string;
  edge: string;
  edgeLabel: string;
  nodeRoot: string;
  nodeSelect: string;
  edgeSelect: string;
  edgeHover: string;
  fallback: string;
}

const DEFAULT_TYPE_COLORS = [
  '#7c6af7', '#58a6ff', '#3fb950', '#00e5ff', '#f85149',
  '#e38625', '#9580ff', '#79c0ff', '#56d364', '#ff6eb4',
];

/**
 * The palette before the view exists.
 *
 * `typeColors` is EMPTY on purpose, not pre-filled with the defaults above: `typeColor` treats an
 * empty palette as "theme not read yet" and returns a single fixed colour. Seeding it here would make
 * nodes render one set of colours before `readGraphTheme()` runs and another after.
 */
export const DEFAULT_GRAPH_THEME: GraphTheme = {
  typeColors: [],
  nodeBg: '#0d1117',
  nodeText: '#c9d1d9',
  edge: '#3d444d',
  edgeLabel: '#6e7681',
  nodeRoot: '#7c6af7',
  nodeSelect: '#58a6ff',
  edgeSelect: '#7c6af7',
  edgeHover: '#58a6ff',
  fallback: '#8b949e',
};

/**
 * Read the graph palette from the document's CSS custom properties.
 *
 * Must run after the view exists — the values live on `:root` and are resolved by the browser, so
 * calling this before the stylesheet applies yields the fallbacks.
 */
export function readGraphTheme(): GraphTheme {
  const cs = getComputedStyle(document.documentElement);
  const tv = (v: string, fb: string) => cs.getPropertyValue(v).trim() || fb;
  return {
    typeColors: DEFAULT_TYPE_COLORS.map((fb, i) => tv(`--graph-type-${i + 1}`, fb)),
    nodeBg: tv('--graph-node-bg', '#0d1117'),
    nodeText: tv('--graph-node-text', '#c9d1d9'),
    edge: tv('--graph-edge', '#3d444d'),
    edgeLabel: tv('--graph-edge-label', '#6e7681'),
    nodeRoot: tv('--graph-node-root', '#7c6af7'),
    nodeSelect: tv('--graph-node-select', '#58a6ff'),
    edgeSelect: tv('--graph-edge-select', '#7c6af7'),
    edgeHover: tv('--graph-edge-hover', '#58a6ff'),
    fallback: tv('--graph-fallback', '#8b949e'),
  };
}

/**
 * A stable colour per entity type.
 *
 * Hashed rather than assigned, so a type keeps its colour across sessions and spaces without anything
 * having to persist the mapping — and a type the palette has never seen still gets a colour.
 */
export function typeColor(theme: GraphTheme, type: string): string {
  if (!theme.typeColors.length) return '#7c6af7';
  let hash = 0;
  for (let i = 0; i < type.length; i++) hash = (hash * 31 + type.charCodeAt(i)) | 0;
  return theme.typeColors[Math.abs(hash) % theme.typeColors.length];
}

/** Radial highlight in the upper-left quadrant — gives each node its glass look. */
function glassShineSvg(color: string): string {
  const c = encodeURIComponent(color);
  return `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><defs><radialGradient id='base' cx='50%25' cy='50%25' r='50%25'><stop offset='0%25' stop-color='${c}' stop-opacity='0.28'/><stop offset='100%25' stop-color='${c}' stop-opacity='0.06'/></radialGradient><radialGradient id='shine' cx='30%25' cy='22%25' r='50%25'><stop offset='0%25' stop-color='white' stop-opacity='0.55'/><stop offset='45%25' stop-color='white' stop-opacity='0.12'/><stop offset='100%25' stop-color='white' stop-opacity='0'/></radialGradient><radialGradient id='rim' cx='50%25' cy='50%25' r='50%25'><stop offset='68%25' stop-color='${c}' stop-opacity='0'/><stop offset='100%25' stop-color='${c}' stop-opacity='0.7'/></radialGradient><radialGradient id='bot' cx='58%25' cy='80%25' r='38%25'><stop offset='0%25' stop-color='${c}' stop-opacity='0.18'/><stop offset='100%25' stop-color='${c}' stop-opacity='0'/></radialGradient></defs><circle cx='50' cy='50' r='49' fill='url(%23base)'/><circle cx='50' cy='50' r='49' fill='url(%23rim)'/><circle cx='50' cy='50' r='49' fill='url(%23bot)'/><circle cx='50' cy='50' r='49' fill='url(%23shine)'/></svg>`;
}

/**
 * The cytoscape stylesheet.
 *
 * Node size, opacity and halo all taper with `depth`, so distance from the root reads visually
 * rather than only from the layout — that is why so many values are functions of the element.
 *
 * ## The halo is `underlay-*`, and it used to be `shadow-*`, which does not exist
 *
 * Cytoscape 2 had `shadow-blur` / `shadow-color` / `shadow-opacity` / `shadow-offset-*`. Cytoscape 3
 * removed them: the string does not appear in `cytoscape.cjs.js` at all, and an unknown style property
 * is silently discarded rather than warned about. So seven selectors here were setting a glow that had
 * never once been painted — and the `as any` on each `style` block is precisely what let them compile.
 * The comment above claimed depth tapered the shadow, and one of the two things it named was inert.
 *
 * `underlay-color` / `-opacity` / `-padding` are cytoscape 3's equivalent and are present in both the
 * typings and the runtime. Opacities are lower than the old shadow figures because an underlay is a
 * solid halo rather than a blur — 0.6 of a blur and 0.6 of a solid are not the same amount of light.
 *
 * Every block below is now typed, so the next property that stops existing fails the build instead.
 */
function graphStylesheet(theme: GraphTheme): cytoscape.StylesheetJson {
  const depthOf = (ele: cytoscape.NodeSingular) => +ele.data('depth');
  const colorOf = (ele: cytoscape.NodeSingular) => typeColor(theme, ele.data('type') || 'default');
  const nodeSize = (ele: cytoscape.NodeSingular) => { const d = depthOf(ele); return d === 0 ? 68 : Math.max(36, 52 - d * 3); };

  return [
    {
      selector: 'node',
      style: {
        'width': nodeSize,
        'height': nodeSize,
        'background-color': theme.nodeBg,
        'background-image': (ele: cytoscape.NodeSingular) => glassShineSvg(colorOf(ele)),
        'background-fit': 'cover',
        'background-clip': 'node',
        'border-width': (ele: cytoscape.NodeSingular) => depthOf(ele) === 0 ? 2.5 : 1.5,
        'border-color': colorOf,
        'border-opacity': 0.75,
        'label': 'data(label)',
        'font-size': (ele: cytoscape.NodeSingular) => depthOf(ele) === 0 ? 13 : 11,
        'font-weight': (ele: cytoscape.NodeSingular) => depthOf(ele) === 0 ? 600 : 400,
        'color': theme.nodeText,
        'text-outline-color': theme.nodeBg,
        'text-outline-width': 2,
        'text-valign': 'bottom',
        'text-margin-y': 8,
        'text-max-width': '110px',
        'text-wrap': 'ellipsis',
        'opacity': (ele: cytoscape.NodeSingular) => { const d = depthOf(ele); return d === 0 ? 1 : Math.max(0.55, 1 - d * 0.1); },
        // `underlay-shape` defaults to round-rectangle, which puts a visible BOX behind a circular
        // node. Nodes here use cytoscape's default ellipse shape, so the halo has to say so too.
        'underlay-shape': 'ellipse',
        'underlay-color': colorOf,
        'underlay-padding': (ele: cytoscape.NodeSingular) => depthOf(ele) === 0 ? 10 : 5,
        'underlay-opacity': (ele: cytoscape.NodeSingular) => depthOf(ele) === 0 ? 0.35 : 0.18,
      },
    },
    {
      selector: 'node.root',
      style: { 'border-color': theme.nodeRoot, 'border-width': 3, 'border-opacity': 1 },
    },
    {
      selector: 'node.hovered',
      style: {
        'border-width': 2.5, 'border-opacity': 1, 'opacity': 1,
        'underlay-padding': 11, 'underlay-opacity': 0.45,
      },
    },
    {
      selector: 'node:selected',
      style: {
        'border-color': theme.nodeSelect, 'border-width': 3, 'border-opacity': 1, 'opacity': 1,
        'underlay-padding': 13, 'underlay-color': theme.nodeSelect, 'underlay-opacity': 0.5,
      },
    },
    {
      // Edges carry NO label by default — see `edge.show-label` below for when one appears and why.
      selector: 'edge',
      style: {
        'width': 1.5,
        'line-color': theme.edge,
        'target-arrow-shape': 'triangle',
        'target-arrow-color': theme.edge,
        'curve-style': 'bezier',
        'label': '',
        'font-size': 10,
        'color': theme.edgeLabel,
        'text-rotation': 'autorotate',
        // No `text-margin-y`. It used to be -8, which lifted the label OFF the line it belongs to; on a
        // curve that reads as a label floating between two edges rather than sitting on one. Cytoscape's
        // default placement for an edge label is the midpoint, which is where it should have been.
        'text-background-color': theme.nodeBg,
        'text-background-opacity': 0.85,
        'text-background-padding': '3px',
        'opacity': 0.75,
      },
    },
    {
      /**
       * A label appears on the edges of whatever you are looking at, and nowhere else.
       *
       * Every edge used to be labelled at all times. On a small traverse that is fine and on a dense one it
       * is unreadable: cytoscape does not de-collide mid-edge labels, so they overlap each other and the
       * nodes, and the picture gets worse exactly as it gets more interesting.
       *
       * Applied to the edges of the SELECTED node and to a HOVERED edge. Between them those are the two
       * ways a person says "this one" — selection for the thing being examined, hover for the thing being
       * pointed at — so the labels are present whenever they were asked for and absent when they were not.
       */
      selector: 'edge.show-label',
      style: { 'label': 'data(label)' },
    },
    {
      selector: 'edge.hovered',
      style: {
        'line-color': theme.edgeHover, 'target-arrow-color': theme.edgeHover, 'opacity': 1, 'width': 2.5,
        'underlay-padding': 4, 'underlay-color': theme.edgeHover, 'underlay-opacity': 0.35,
      },
    },
    {
      selector: 'edge:selected',
      style: {
        'line-color': theme.edgeSelect, 'target-arrow-color': theme.edgeSelect, 'opacity': 1, 'width': 2.5,
        'underlay-padding': 5, 'underlay-color': theme.edgeSelect, 'underlay-opacity': 0.4,
      },
    },
    { selector: 'edge.hide-labels', style: { 'label': '' } },
  ];
}

/**
 * Put a label on the edges of the selected node, and on nothing else.
 *
 * Recomputed from scratch each time rather than toggled incrementally: an incremental version has to undo
 * exactly what it did last time, and the state it is undoing lives in the graph rather than in a variable —
 * which is how a stale label survives a deselect and then belongs to nothing.
 *
 * A hovered edge adds its own class on mouseover and this function reinstates the correct set on mouseout,
 * so the two rules compose without either needing to know about the other.
 *
 * `hide-labels` — the operator's global off switch — is deliberately NOT consulted here. It wins in the
 * stylesheet instead, because a setting a person turned off must not be re-enabled by a selection.
 */
export function syncEdgeLabels(cy: cytoscape.Core): void {
  cy.edges().removeClass('show-label');
  const selected = cy.nodes(':selected');
  if (selected.length > 0) selected.connectedEdges().addClass('show-label');
}

/**
 * The element model for one render — the pure half of this module, and the thing the characterization
 * tests assert.
 *
 * The root is added here rather than coming from the traversal: a traversal returns what it reached
 * FROM the root, never the root itself. It is emitted at depth 0 with the `root` class, and skipped in
 * the node loop so a traversal that does echo it back cannot produce a duplicate id.
 *
 * `from`/`to` become `source`/`target` because that is the shape cytoscape requires — the rename is
 * the whole reason this translation exists.
 */
export function buildElements(
  root: Entity | null,
  nodes: readonly TraverseNode[],
  edges: readonly TraverseEdge[],
  rootId: string,
): cytoscape.ElementDefinition[] {
  const elements: cytoscape.ElementDefinition[] = [];

  if (root) {
    elements.push({
      group: 'nodes',
      data: { id: root._id, label: root.name, type: root.type || 'default', depth: 0 },
      classes: 'root',
    });
  }

  for (const n of nodes) {
    if (n._id === rootId) continue;    // already added above
    elements.push({
      group: 'nodes',
      data: { id: n._id, label: n.name, type: n.type || 'default', depth: n.depth },
    });
  }

  for (const e of edges) {
    elements.push({ group: 'edges', data: { id: e._id, source: e.from, target: e.to, label: e.label } });
  }

  return elements;
}

/**
 * The renderer instance, named so the component can hold one without importing cytoscape.
 *
 * The alias is the point: the component's field was `private cy: any`, which made the claim at the top
 * of this file — "the component holds no `any`-typed renderer state" — untrue on the very line it was
 * written about. An alias keeps the boundary (nothing outside this module names cytoscape) while still
 * being a real type.
 */
export type GraphInstance = cytoscape.Core;

/** What the component wants to know about, expressed without any cytoscape types. */
export interface GraphHandlers {
  onNodeTap(id: string): void;
  onEdgeTap(id: string): void;
  onNodeDoubleTap(id: string): void;
  onBackgroundTap(): void;
}

/**
 * Create the instance and wire the handlers.
 *
 * These callbacks fire OUTSIDE the Angular zone. That is safe here only because every one of them
 * ends up writing a signal, and signal writes notify OnPush regardless of zone — a handler that set a
 * plain field instead would update nothing on screen. The hover handlers stay inside this module
 * because they only toggle cytoscape's own classes and never touch Angular state.
 */
export function createGraphCytoscape(
  container: HTMLElement,
  theme: GraphTheme,
  handlers: GraphHandlers,
): cytoscape.Core {
  const cy = cytoscape({
    container,
    elements: [],
    style: graphStylesheet(theme),
    layout: { name: 'grid' },
    minZoom: 0.1,
    maxZoom: 5,
    wheelSensitivity: 0.25,
  });

  const idOf = (evt: cytoscape.EventObject): string => evt.target.data('id');

  syncEdgeLabels(cy);

  cy.on('tap', 'node', evt => handlers.onNodeTap(idOf(evt)));
  cy.on('tap', 'edge', evt => handlers.onEdgeTap(idOf(evt)));
  cy.on('dbltap', 'node', evt => handlers.onNodeDoubleTap(idOf(evt)));

  cy.on('mouseover', 'node', evt => { evt.target.addClass('hovered'); });
  cy.on('mouseout',  'node', evt => { evt.target.removeClass('hovered'); });
  // A hovered edge labels ITSELF — pointing at one line is the narrowest possible way of asking what it is.
  cy.on('mouseover', 'edge', evt => { evt.target.addClass('hovered').addClass('show-label'); });
  cy.on('mouseout',  'edge', evt => { evt.target.removeClass('hovered'); syncEdgeLabels(cy); });

  // Selecting a node labels the edges around it, and deselecting takes them away again. Driven off
  // cytoscape's own select/unselect rather than off `tap`, so a selection made any other way — restored
  // state, a programmatic select — lights the same edges.
  cy.on('select unselect', 'node', () => { syncEdgeLabels(cy); });
  cy.on('tap', evt => { if (evt.target === cy) syncEdgeLabels(cy); });

  // Background tap — identified by the event target being the instance itself, not an element.
  cy.on('tap', evt => { if (evt.target === cy) handlers.onBackgroundTap(); });

  return cy;
}

/**
 * The operator's global switch for edge labels: the `hide-labels` class on every edge, which wins in the stylesheet.
 *
 * One function for the toggle and for every render, because a render replaces every element — a class set only by
 * the toggle would be lost on the next draw, and two copies of this branch is how one of them stops agreeing.
 */
export function setEdgeLabelsHidden(cy: cytoscape.Core, hide: boolean): void {
  if (hide) cy.edges().addClass('hide-labels');
  else cy.edges().removeClass('hide-labels');
}

/**
 * Fit the graph to the canvas as it is NOW: resize first, because Angular may have opened or closed the side panel
 * since cytoscape last measured, which changes the canvas width without cytoscape knowing.
 */
export function fitToCanvas(cy: cytoscape.Core): void {
  cy.resize();
  cy.fit(undefined, 40);
}

/**
 * Draw an element model, then fit.
 *
 * `resize()` runs twice deliberately: once before drawing, and again on `layoutstop`, because Angular
 * may have opened or closed the side panel in between — which changes the canvas width without
 * cytoscape knowing. Fitting against stale dimensions is what makes a graph render half off-screen.
 */
export function renderElements(
  cy: cytoscape.Core,
  elements: cytoscape.ElementDefinition[],
  rootId: string,
  hideLabels: boolean,
  onSettled: () => void,
): void {
  cy.resize();
  cy.elements().remove();
  cy.add(elements);

  setEdgeLabelsHidden(cy, hideLabels);

  // A re-render replaces every element, so the label set has to be recomputed rather than assumed to have
  // survived. Runs after `hide-labels` is set, and that class still wins — the operator's global "off" is
  // not something a selection may quietly override.
  syncEdgeLabels(cy);

  // breadthfirst keeps each node next to its direct edge-partner.
  //
  // `roots` takes an array of raw ids rather than the `#id` selector this used to pass. Both resolve the
  // same element — cytoscape's selector grammar does accept an id beginning with a digit, which UUIDs
  // often do — but the array form is what the typings describe, so it needs no cast to compile.
  const layout = cy.layout({
    name: 'breadthfirst',
    roots: [rootId],
    directed: false,
    spacingFactor: 1.1,
    padding: 40,
    avoidOverlap: true,
    animate: true,
    animationDuration: 400,
  });

  layout.on('layoutstop', onSettled);
  layout.run();
}
