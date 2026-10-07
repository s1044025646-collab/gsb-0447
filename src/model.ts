export interface PropEntry {
  name: string;
  values: string[];
}

export interface SgfNode {
  id: number;
  parent: SgfNode | null;
  children: SgfNode[];
  props: PropEntry[];
  path: string;
}

export interface GameTree {
  root: SgfNode;
  nodeCount: number;
  maxDepth: number;
}

export interface Collection {
  trees: GameTree[];
}

export const LIMITS = {
  MAX_TEXT_LENGTH: 1_000_000,
  MAX_NODES: 100_000,
  MAX_DEPTH: 1_000,
} as const;

export const RULES_VERSION = 'sgf-ff4-subset-1';
