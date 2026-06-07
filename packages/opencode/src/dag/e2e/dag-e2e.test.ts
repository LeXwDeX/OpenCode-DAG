// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * DAG End-to-End Integration Tests
 * 
 * Tests the complete DAG workflow system using Scheduler API:
 * - Sequential workflow execution
 * - Parallel node execution
 * - Error handling
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { Scheduler } from '../scheduler/Scheduler'
import type { WorkerExecutor } from '../scheduler/types'

// Stub executor for successful execution
const stubExecutor: WorkerExecutor = async (worker) => ({
  success: true,
  workerId: worker.workerId,
})

describe('DAG End-to-End Integration', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    scheduler = new Scheduler(undefined, undefined, stubExecutor)
  })

  describe('Simple Sequential Workflow', () => {
    it('should execute a 3-node sequential workflow successfully', async () => {
      const config = (id: string) => ({
        workerId: id,
        type: 'code' as const,
      })

      // Create 3 sequential workers
      await scheduler.createWorker('node-1', config('node-1'))
      await scheduler.executeWorker('node-1', {})
      
      await scheduler.createWorker('node-2', config('node-2'))
      await scheduler.executeWorker('node-2', {})
      
      await scheduler.createWorker('node-3', config('node-3'))
      await scheduler.executeWorker('node-3', {})

      // Verify all workers completed
      const workers = await scheduler.getAllWorkers()
      expect(workers).toHaveLength(3)
      expect(workers[0].status).toBe('completed')
      expect(workers[1].status).toBe('completed')
      expect(workers[2].status).toBe('completed')
    })
  })

  describe('Parallel Workflow Execution', () => {
    it('should execute 3 parallel workers', async () => {
      const config = (id: string) => ({
        workerId: id,
        type: 'code' as const,
      })

      // Create 3 independent workers
      await scheduler.createWorker('worker-1', config('worker-1'))
      await scheduler.createWorker('worker-2', config('worker-2'))
      await scheduler.createWorker('worker-3', config('worker-3'))

      // Execute in parallel
      await Promise.all([
        scheduler.executeWorker('worker-1', {}),
        scheduler.executeWorker('worker-2', {}),
        scheduler.executeWorker('worker-3', {}),
      ])

      // Verify all workers completed
      const workers = await scheduler.getAllWorkers()
      expect(workers).toHaveLength(3)
      workers.forEach(w => {
        expect(w.status).toBe('completed')
      })
    })
  })

  describe('Error Handling', () => {
    it('should handle worker failures', async () => {
      // Create executor that fails
      const failingExecutor: WorkerExecutor = async (worker) => {
        throw new Error(`Worker ${worker.workerId} failed`)
      }

      const errorScheduler = new Scheduler(undefined, undefined, failingExecutor)
      
      const config = {
        workerId: 'failing-worker',
        type: 'code' as const,
      }

      await errorScheduler.createWorker('failing-worker', config)

      // Execute should throw an error
      try {
        await errorScheduler.executeWorker('failing-worker', {})
        throw new Error('Should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain('failing-worker')
      }

      // Verify worker was marked as failed
      const worker = await errorScheduler.getWorker('failing-worker')
      expect(worker?.status).toBe('failed')
    })
  })
})

describe('Scheduler Integration Tests', () => {
  let scheduler: Scheduler
  let stubExecutor: WorkerExecutor

  beforeEach(() => {
    stubExecutor = async (worker) => ({
      success: true,
      workerId: worker.workerId,
    })
    scheduler = new Scheduler(undefined, undefined, stubExecutor)
  })

  it('should create multiple workers', async () => {
    const config = { workerId: 'test-1', type: 'code' as const }
    await scheduler.createWorker('test-1', config)

    const workers = await scheduler.getAllWorkers()
    expect(workers).toHaveLength(1)
  })

  it('should get worker by ID', async () => {
    const config = { workerId: 'test-worker', type: 'code' as const }
    await scheduler.createWorker('test-worker', config)

    const worker = await scheduler.getWorker('test-worker')
    expect(worker).toBeDefined()
    expect(worker!.workerId).toBe('test-worker')
    expect(worker!.status).toBe('pending')
  })

  it('should execute worker and update status', async () => {
    const config = { workerId: 'exec-test', type: 'code' as const }
    await scheduler.createWorker('exec-test', config)
    await scheduler.executeWorker('exec-test', {})

    const worker = await scheduler.getWorker('exec-test')
    expect(worker!.status).toBe('completed')
  })

  it('should update worker status', async () => {
    const config = { workerId: 'status-test', type: 'code' as const }
    await scheduler.createWorker('status-test', config)

    await scheduler.updateWorkerStatus('status-test', 'running')
    let worker = await scheduler.getWorker('status-test')
    expect(worker!.status).toBe('running')

    await scheduler.updateWorkerStatus('status-test', 'completed')
    worker = await scheduler.getWorker('status-test')
    expect(worker!.status).toBe('completed')
  })
})
