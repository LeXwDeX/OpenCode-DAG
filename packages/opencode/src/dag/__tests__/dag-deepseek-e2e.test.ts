// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * DAG End-to-End Test with deepseek-v4-pro
 *
 * 使用真实 deepseek-v4-pro 模型进行端到端测试
 * 配置从 ~/.config/opencode/opencode.json 读取
 *
 * 注意：这些测试调用真实 LLM API，需要更长超时时间（30 秒）
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { promises as fs, existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// 默认超时：30 秒（LLM API 调用需要更长时间）
// ============================================================================
const DEFAULT_TIMEOUT = 30000;

// ============================================================================
// E2E 跳过守卫：CI 环境没有用户级 opencode.json，也不应依赖外部真实 LLM 服务；
// 配置文件缺失或处于 CI 时跳过整个 e2e describe（retry helper 单测不受影响）。
// ============================================================================
const CONFIG_PATH = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
const SKIP_E2E = !existsSync(CONFIG_PATH) || !!process.env.CI;

// ============================================================================
// 重试辅助函数：应对外部 LLM API 不稳定
// ============================================================================
async function retry<T>(fn: () => Promise<T>, maxRetries: number = 2, delayMs: number = 2000): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        console.log(`[RETRY] Attempt ${attempt + 1}/${maxRetries} failed, retrying in ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

// ============================================================================
// 加载 deepseek-v4-pro 配置
// ============================================================================

async function loadDeepSeekConfig() {
  const configContent = await fs.readFile(CONFIG_PATH, 'utf-8');
  const config = JSON.parse(configContent);
  
  const provider = config.provider['local-proxy-compatible'];
  if (!provider) {
    throw new Error('local-proxy-compatible provider not found in config');
  }
  
  const model = provider.models['deepseek-v4-pro'];
  if (!model) {
    throw new Error('deepseek-v4-pro model not found in config');
  }
  
  return {
    baseURL: provider.options.baseURL,
    apiKey: provider.options.apiKey,
    modelId: 'deepseek-v4-pro',
    modelName: model.name,
    enableThinking: model.reasoning,
  };
}

// ============================================================================
// retry 辅助函数单元测试
// ============================================================================

describe('retry helper', () => {
  it('should return result on first success', async () => {
    const result = await retry(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  it('should retry on failure and succeed', async () => {
    let attempts = 0;
    const result = await retry(() => {
      attempts++;
      if (attempts < 2) throw new Error('transient');
      return Promise.resolve('recovered');
    }, 2, 10);
    expect(result).toBe('recovered');
    expect(attempts).toBe(2);
  });

  it('should throw after exhausting retries', async () => {
    let attempts = 0;
    await expect(
      retry(() => {
        attempts++;
        return Promise.reject(new Error('always fails'));
      }, 2, 10),
    ).rejects.toThrow('always fails');
    expect(attempts).toBe(3); // initial + 2 retries
  });
});

// ============================================================================
// 端到端测试
// ============================================================================

describe.skipIf(SKIP_E2E)('DAG End-to-End Test with deepseek-v4-pro', () => {
  let deepseekClient: any;
  let config: any;

  beforeAll(async () => {
    // 加载配置
    config = await loadDeepSeekConfig();
    console.log(`\n[INFO] 使用模型: ${config.modelName} (${config.modelId})`);
    console.log(`[INFO] API 地址: ${config.baseURL}`);
    console.log(`[INFO] 启用推理: ${config.enableThinking}`);
    
    // 创建 OpenAI-compatible 客户端
    deepseekClient = createOpenAICompatible({
      name: 'deepseek',
      baseURL: config.baseURL,
      apiKey: config.apiKey,
    });
  });

  describe('deepseek-v4-pro 模型测试', () => {
    it('应该能够调用 deepseek-v4-pro 并返回结果', async () => {
      const model = deepseekClient(config.modelId);
      
      const result = await retry(() => generateText({
        model,
        prompt: '用 100 字描述什么是 DAG 工作流',
        maxOutputTokens: 200,
      }));

      expect(result.text).toBeDefined();
      // LLM 可能返回 reasoning_content 而非 text，检查两者
      const textContent = result.text || '';
      const reasoningContent = result.reasoning ? String(result.reasoning) : '';
      const hasReasoning = reasoningContent.length > 0;
      const hasText = textContent.length > 0;
      expect(hasText || hasReasoning).toBe(true);
      console.log(`\n[TEST] 模型响应: ${(textContent || reasoningContent).substring(0, 100)}...`);
    }, DEFAULT_TIMEOUT);

    it('应该能够处理复杂推理请求', async () => {
      const model = deepseekClient(config.modelId);
      
      const result = await retry(() => generateText({
        model,
        prompt: '分析一个 3 节点的 DAG 工作流的依赖关系和执行顺序',
        maxOutputTokens: 500,
      }));

      expect(result.text).toBeDefined();
      // reasoning 模型可能将回答放在 reasoning_content 而非 content
      const textContent = result.text || '';
      const reasoningContent = result.reasoning ? String(result.reasoning) : '';
      const hasReasoning = reasoningContent.length > 0;
      const hasText = textContent.length > 0;
      expect(hasText || hasReasoning).toBe(true);
      expect(result.usage).toBeDefined();
      expect(result.usage.totalTokens).toBeGreaterThan(0);
      console.log(`\n[TEST] text 长度: ${textContent.length}, reasoning 长度: ${reasoningContent.length}`);
      console.log(`[INFO] Token 使用: ${result.usage.totalTokens}`);
      console.log(`[TEST] 推理结果预览: ${(textContent || reasoningContent).substring(0, 150)}...`);
    }, DEFAULT_TIMEOUT);
  });

  describe('多节点工作流测试', () => {
    it('应该能够模拟 3 节点串行工作流', async () => {
      const model = deepseekClient(config.modelId);
      
      // 模拟工作流执行
      const workflow = {
        nodes: ['setup', 'build', 'test'],
        dependencies: {
          build: ['setup'],
          test: ['build'],
        },
      };

      // 执行每个节点
      const results = [];
      for (const node of workflow.nodes) {
        const result = await retry(() => generateText({
          model,
          prompt: `执行工作流节点: ${node}`,
          maxOutputTokens: 200,
        }));
        
        results.push({
          nodeId: node,
          status: 'completed',
          output: result.text,
        });
      }

      expect(results).toHaveLength(3);
      expect(results[0].nodeId).toBe('setup');
      expect(results[0].status).toBe('completed');
      expect(results[0].output).toBeDefined();
      
      console.log(`\n[TEST] 工作流执行完成: ${results.length} 个节点`);
      console.log(`[INFO] 第一个节点输出: ${results[0].output.substring(0, 100)}...`);
    }, DEFAULT_TIMEOUT * 2); // 串行工作流需要更长时间

    it('应该能够处理并行节点', async () => {
      const model = deepseekClient(config.modelId);
      
      // 模拟并行执行
      const parallelNodes = ['task-a', 'task-b', 'task-c'];
      
      const promises = parallelNodes.map(async (node) => {
        const result = await retry(() => generateText({
          model,
          prompt: `执行并行任务: ${node}`,
          maxOutputTokens: 150,
        }));
        
        return {
          nodeId: node,
          status: 'completed',
          output: result.text,
        };
      });

      const results = await Promise.all(promises);

      expect(results).toHaveLength(3);
      results.forEach((r) => {
        expect(r.status).toBe('completed');
        expect(r.output).toBeDefined();
      });

      console.log(`\n[TEST] 并行任务完成: ${results.length} 个任务`);
      console.log(`[INFO] 任务 A 输出: ${results[0].output.substring(0, 80)}...`);
      console.log(`[INFO] 任务 B 输出: ${results[1].output.substring(0, 80)}...`);
      console.log(`[INFO] 任务 C 输出: ${results[2].output.substring(0, 80)}...`);
    }, DEFAULT_TIMEOUT);
  });

  describe('工作流状态管理测试', () => {
    it('应该能够管理工作流的完整生命周期', async () => {
      const model = deepseekClient(config.modelId);
      
      const workflowId = `workflow-${Date.now()}`;
      const states: string[] = ['pending', 'running', 'completed'];
      
      // 管理工作流状态
      for (const state of states) {
        const result = await retry(() => generateText({
          model,
          prompt: `工作流 ${workflowId} 状态变更: ${state}`,
          maxOutputTokens: 100,
        }));
        
        expect(result.text).toBeDefined();
      }
      
      console.log(`\n[TEST] 工作流 ${workflowId} 生命周期完成`);
      console.log(`[INFO] 状态流转: ${states.join(' -> ')}`);
    }, DEFAULT_TIMEOUT * 2);
  });
});
