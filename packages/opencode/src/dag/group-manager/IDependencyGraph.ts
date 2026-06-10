// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * @deprecated D-PLAN-RETIRE (2026-06-09) — Zero production references.
 * Do not import from production code. See AGENTS.md 退/留判定表.
 *
 * Directed Acyclic Graph (DAG) Interface
 * 
 * Defines the contract for dependency graph management in DAG workflows.
 * 
 * @see workflow-dag-architecture.md §4
 */
export interface IDependencyGraph {
  // ========================================================================
  // Node Management
  // ========================================================================

  /**
   * Add a node to the graph
   * @param nodeId Node identifier
   * @throws {Error} If node already exists
   */
  addNode(nodeId: string): void;

  /**
   * Remove a node and all associated edges
   * @param nodeId Node identifier
   * @throws {GroupNotFoundError} If node doesn't exist
   */
  removeNode(nodeId: string): void;

  /**
   * Check if a node exists
   * @param nodeId Node identifier
   * @returns true if node exists
   */
  hasNode(nodeId: string): boolean;

  /**
   * Get all node IDs in the graph
   * @returns Array of node IDs
   */
  getAllNodes(): string[];

  /**
   * Get the number of nodes in the graph
   * @returns Node count
   */
  getNodeCount(): number;

  // ========================================================================
  // Edge Management
  // ========================================================================

  /**
   * Add an edge (dependency relationship)
   * @param from Node that depends on 'to'
   * @param to Node that 'from' depends on
   * @throws {GroupNotFoundError} If either node doesn't exist
   * @throws {CycleError} If adding the edge creates a cycle
   */
  addEdge(from: string, to: string): void;

  /**
   * Remove an edge
   * @param from Node that depends on 'to'
   * @param to Node that 'from' depends on
   * @throws {Error} If edge doesn't exist
   */
  removeEdge(from: string, to: string): void;

  /**
   * Check if an edge exists
   * @param from Node that depends on 'to'
   * @param to Node that 'from' depends on
   * @returns true if edge exists
   */
  hasEdge(from: string, to: string): boolean;

  /**
   * Get the number of edges in the graph
   * @returns Edge count
   */
  getEdgeCount(): number;

  // ========================================================================
  // Dependency Queries
  // ========================================================================

  /**
   * Get direct dependencies of a node (nodes that this node depends on)
   * @param nodeId Node identifier
   * @returns Array of node IDs that this node depends on
   * @throws {NodeNotFoundError} If node doesn't exist
   */
  getDependencies(nodeId: string): string[];

  /**
   * Get direct dependents of a node (nodes that depend on this node)
   * @param nodeId Node identifier
   * @returns Array of node IDs that depend on this node
   * @throws {NodeNotFoundError} If node doesn't exist
   */
  getDependents(nodeId: string): string[];

  /**
   * Get all transitive dependencies (including direct and indirect)
   * @param nodeId Node identifier
   * @returns Array of all node IDs that this node transitively depends on
   * @throws {NodeNotFoundError} If node doesn't exist
   */
  getAllDependencies(nodeId: string): string[];

  /**
   * Get all transitive dependents (including direct and indirect)
   * @param nodeId Node identifier
   * @returns Array of all node IDs that transitively depend on this node
   * @throws {NodeNotFoundError} If node doesn't exist
   */
  getAllDependents(nodeId: string): string[];

  // ========================================================================
  // Topological Sort
  // ========================================================================

  /**
   * Perform topological sort using Kleene's algorithm
   * @returns Sorted array of node IDs
   * @throws {CycleError} If graph contains cycles
   */
  topologicalSort(): string[];

  // ========================================================================
  // Execution Planning
  // ========================================================================

  /**
   * Get nodes that can start execution now (no unfulfilled dependencies)
   * @param completed Set of already completed node IDs
   * @returns Array of node IDs that can execute immediately
   */
  getExecutableNodes(completed: Set<string>): string[];

  /**
   * Get nodes grouped by layers (for visualization and execution planning)
   * Each layer contains nodes that can execute in parallel after previous layers complete
   * @returns Array of layers, each layer is an array of parallel nodes
   * @throws {CyclicDependencyError} If graph contains cycles
   */
  getLayers(): string[][];

  // ========================================================================
  // Cycle Detection
  // ========================================================================

  /**
   * Check if graph has cycles
   * @returns true if graph contains cycles
   */
  hasCycle(): boolean;

  /**
   * Find all cycles in the graph
   * @returns Array of cycles, each cycle is an array of node IDs forming the cycle
   */
  findCycles(): string[][];

  // ========================================================================
  // Validation
  // ========================================================================

  /**
   * Validate the graph structure
   * @returns true if graph is valid (no errors), array of error strings if invalid
   */
  validate(): true | string[];

  // ========================================================================
  // Statistics and Debugging
  // ========================================================================

  /**
   * Get graph statistics
   * @returns Statistics object
   */
  getStats(): {
    nodeCount: number;
    edgeCount: number;
    averageDegree: number;
    maxDepth: number;
    hasCycle: boolean;
  };

  // ========================================================================
  // Serialization
  // ========================================================================

  /**
   * Convert to JSON-serializable object
   * @returns JSON-serializable object with nodes and edges
   */
  toJSON(): {
    nodes: string[];
    edges: { from: string; to: string }[];
  };

  /**
   * Create from JSON object
   * @param data JSON object with nodes and edges
   * @returns New DependencyGraph instance
   */
  fromJSON(data: {
    nodes: string[];
    edges: { from: string; to: string }[];
  }): IDependencyGraph;

  /**
   * Clone the graph
   * @returns New DependencyGraph instance with same structure
   */
  clone(): IDependencyGraph;

  /**
   * Clear all nodes and edges
   */
  clear(): void;
}
