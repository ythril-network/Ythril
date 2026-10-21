import type { Edge, TraverseEdge, TraverseNode } from '../../core/api.types';
import { typeColor, type GraphTheme } from './graph-cytoscape';

/**
 * What the record panel is headed with and coloured by: the selected node's name and type, or the selected edge's label.
 *
 * Moved out of `graph.component.ts` (frozen by the size ratchet) when personal views needed its lines: both are pure functions of the
 * selection and the theme, so they have no reason to live in the page that owns the selection.
 */
export function panelTitleOf(node: TraverseNode | null, edge: TraverseEdge | null): string {
  if (node) return node.name;
  if (edge) return edge.label || 'edge';
  return '';
}

/** The colour of the same selection; the theme's fallback when nothing is selected. */
export function panelColorOf(theme: GraphTheme, node: TraverseNode | null, edgeRecord: Edge | null): string {
  if (node) return typeColor(theme, node.type || 'default');
  if (edgeRecord) return typeColor(theme, edgeRecord.label || 'edge');
  return theme.fallback;
}
