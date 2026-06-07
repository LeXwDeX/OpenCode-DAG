// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import { Effect } from "effect"
import type { DAGConfig, DAGNodeConfig } from "./types"

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Required Nodes Validator
 * 
 * 在 Workflow 创建时验证 required_nodes 配置的合法性
 */
export class RequiredNodesValidator {
  /**
   * 验证 DAGConfig 中的 required_nodes 配置
   */
  validate(config: DAGConfig): ValidationResult {
    const errors: string[] = []
    const warnings: string[] = []

    // 1. 检查所有节点是否都有 required 标记
    const nodeIds = config.nodes.map(n => n.id)
    const requiredNodeIds = config.nodes
      .filter(n => n.required)
      .map(n => n.id)

    // 2. 检查 required_nodes 引用的节点是否存在
    for (const reqId of requiredNodeIds) {
      if (!nodeIds.includes(reqId)) {
        errors.push(`Required node "${reqId}" not found in nodes list`)
      }
    }

    // 3. 检查 required_nodes 之间是否形成循环依赖
    const requiredGraph = this.buildRequiredGraph(config)
    if (this.hasCycle(requiredGraph)) {
      errors.push("Required nodes form a cycle")
    }

    // 4. 警告：如果所有节点都是 required
    if (requiredNodeIds.length === config.nodes.length && config.nodes.length > 0) {
      warnings.push("All nodes are marked as required. Consider if some nodes can be optional.")
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  /**
   * 构建 required nodes 的依赖图
   */
  private buildRequiredGraph(config: DAGConfig): Map<string, string[]> {
    const graph = new Map<string, string[]>()
    const requiredNodeIds = config.nodes
      .filter(n => n.required)
      .map(n => n.id)

    for (const nodeId of requiredNodeIds) {
      const node = config.nodes.find(n => n.id === nodeId)
      if (node) {
        // 只保留指向其他 required nodes 的依赖
        const deps = node.dependencies.filter(depId => 
          requiredNodeIds.includes(depId)
        )
        graph.set(nodeId, deps)
      }
    }

    return graph
  }

  /**
   * 检测图中是否存在循环（DFS）
   */
  private hasCycle(graph: Map<string, string[]>): boolean {
    const visited = new Set<string>()
    const inStack = new Set<string>()

    const dfs = (nodeId: string): boolean => {
      if (inStack.has(nodeId)) return true  // 循环
      if (visited.has(nodeId)) return false

      visited.add(nodeId)
      inStack.add(nodeId)

      for (const dep of graph.get(nodeId) ?? []) {
        if (dfs(dep)) return true
      }

      inStack.delete(nodeId)
      return false
    }

    for (const nodeId of graph.keys()) {
      if (dfs(nodeId)) return true
    }

    return false
  }
}

export const requiredNodesValidator = new RequiredNodesValidator()
