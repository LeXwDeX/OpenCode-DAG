import { Effect } from "effect"
import { Database } from "@/storage/db"
import { eq, desc, gte, lte } from "drizzle-orm"
import { dagViolations } from "../persistence/schema"
import type { DAGSessionService } from "./session-service"
import type { DAGViolation } from "./types"

/**
 * Violation Query API
 * 
 * Provides high-level query interfaces for workflow violations.
 * Supports filtering, counting, and history queries.
 */
export class ViolationQueryAPI {
  constructor(private sessionService: DAGSessionService) {}

  /**
   * Query all violations for a specific workflow
   */
  getWorkflowViolations(workflowId: string): Effect.Effect<DAGViolation[], Error> {
    return this.sessionService.listViolations(workflowId)
  }

  /**
   * Count violations by severity for a workflow
   */
  countBySeverity(workflowId: string): Effect.Effect<Record<string, number>, Error> {
    return Effect.sync(() => {
      let rows: any[] = []
      Database.use((db) => {
        rows = db.select()
          .from(dagViolations)
          .where(eq(dagViolations.workflow_id, workflowId))
          .all()
      })
      
      const violations = rows.map(mapRow)
      
      const counts: Record<string, number> = {
        error: 0,
        warning: 0,
        info: 0,
      }
      
      for (const v of violations) {
        if (v.severity in counts) {
          counts[v.severity]++
        }
      }
      
      return counts
    })
  }

  /**
   * Get violation history for a specific node across all workflows
   */
  getNodeViolationHistory(nodeId: string): Effect.Effect<DAGViolation[], Error> {
    return Effect.sync(() => {
      let rows: any[] = []
      Database.use((db) => {
        rows = db.select()
          .from(dagViolations)
          .where(eq(dagViolations.node_id, nodeId))
          .orderBy(desc(dagViolations.created_at))
          .all()
      })
      
      return rows.map(mapRow)
    })
  }

  /**
   * Check if a specific node was skipped in a workflow
   */
  wasNodeSkipped(workflowId: string, nodeId: string): Effect.Effect<boolean, Error> {
    return Effect.sync(() => {
      let rows: any[] = []
      Database.use((db) => {
        rows = db.select()
          .from(dagViolations)
          .where(eq(dagViolations.workflow_id, workflowId))
          .all()
      })
      
      const violations = rows.map(mapRow)
      
      return violations.some(
        (v: DAGViolation) => v.nodeId === nodeId && 
               v.type === "required_node_skipped"
      )
    })
  }

  /**
   * Get all workflows that have violations
   */
  getViolatedWorkflows(): Effect.Effect<string[], Error> {
    return Effect.sync(() => {
      let rows: any[] = []
      Database.use((db) => {
        rows = db.selectDistinct({ workflow_id: dagViolations.workflow_id })
          .from(dagViolations)
          .all()
      })
      
      return rows.map((row: any) => row.workflow_id)
    })
  }

  /**
   * Query violations with filters
   */
  queryViolations(params: {
    workflowId?: string
    severity?: string
    type?: string
    since?: Date
    until?: Date
  }): Effect.Effect<DAGViolation[], Error> {
    return Effect.sync(() => {
      let rows: any[] = []
      Database.use((db) => {
        // Build base query
        let query: any = db.select().from(dagViolations)
        
        // Apply filters
        if (params.workflowId) {
          query = query.where(eq(dagViolations.workflow_id, params.workflowId))
        }
        
        if (params.severity) {
          query = query.where(eq(dagViolations.severity, params.severity))
        }
        
        if (params.type) {
          query = query.where(eq(dagViolations.violation_type, params.type))
        }
        
        if (params.since) {
          query = query.where(gte(dagViolations.created_at, params.since.getTime()))
        }
        
        if (params.until) {
          query = query.where(lte(dagViolations.created_at, params.until.getTime()))
        }
        
        rows = query.orderBy(desc(dagViolations.created_at)).all()
      })
      
      return rows.map(mapRow)
    })
  }
}

/**
 * Map database row to DAGViolation
 */
function mapRow(row: any): DAGViolation {
  return {
    id: row.violation_id,
    workflowId: row.workflow_id,
    nodeId: row.node_id ?? undefined,
    type: row.violation_type,
    severity: row.severity,
    message: row.message,
    timestamp: new Date(row.created_at).toISOString(),
    details: row.details ? JSON.parse(row.details) : undefined,
  }
}

/**
 * Create violation query API instance
 */
export function createViolationQueryAPI(
  sessionService: DAGSessionService
): ViolationQueryAPI {
  return new ViolationQueryAPI(sessionService)
}
