#!/usr/bin/env python3
"""
Qwen3.7-Max <analysis>/<summary> 标签生成问题 - 全面复现脚本

尝试多种触发条件：
1. 不同的 thinking depth (low, medium, high)
2. 特定的触发短语
3. 长对话（100 轮）
4. 不同的对话模式
"""

import json
import time
from datetime import datetime
from openai import OpenAI

# 阿里云百炼直接 API 配置
BASE_URL = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
API_KEY = "sk-sp-D.HLRDY.TjBE.MEYCIQCyDCJh4Z7kqX2BNPUkeHW088HzROsf6sXswz11jpgC9QIhAOoqfYa6goD/iIv7k1llSt+14urtC9fZJvW3o2iahK+9"
MODEL = "qwen3.7-max"

# 初始化客户端
client = OpenAI(
    base_url=BASE_URL,
    api_key=API_KEY
)

# 日志文件
LOG_FILE = f"qwen37_comprehensive_test_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"

def log(message, data=None):
    """记录日志"""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    log_entry = f"[{timestamp}] {message}"
    if data:
        log_entry += f"\n{json.dumps(data, indent=2, ensure_ascii=False)}"
    
    print(log_entry)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(log_entry + "\n\n")

def get_original_dcp_system_prompt():
    """获取原始英文 DCP 系统提示词"""
    return """You operate in a context-constrained environment. Manage context continuously to avoid buildup and preserve retrieval quality. Efficient context management is paramount for your agentic performance.

The ONLY tool you have for context management is `compress`. It replaces older conversation content with technical summaries you produce.

`<dcp-message-id>` and `<dcp-system-reminder>` tags are environment-injected metadata. Do not output them.

THE PHILOSOPHY OF COMPRESS
`compress` transforms conversation content into dense, high-fidelity summaries. This is not cleanup - it is crystallization. Your summary becomes the authoritative record of what transpired.

Think of compression as phase transitions: raw exploration becomes refined understanding. The original context served its purpose; your summary now carries that understanding forward.

COMPRESS WHEN

A section is genuinely closed and the raw conversation has served its purpose:

- Research concluded and findings are clear
- Implementation finished and verified
- Exploration exhausted and patterns understood
- Dead-end noise can be discarded without waiting for a whole chapter to close

DO NOT COMPRESS IF

- Raw context is still relevant and needed for edits or precise references
- The target content is still actively in progress
- You may need exact code, error messages, or file contents in the immediate next steps

Before compressing, ask: _"Is this section closed enough to become summary-only right now?"_

Evaluate conversation signal-to-noise REGULARLY. Use `compress` deliberately with quality-first summaries. Prioritize stale content intelligently to maintain a high-signal context window that supports your agency.

It is of your responsibility to keep a sharp, high-quality context window for optimal performance."""

def test_with_thinking_depth(depth_name, thinking_budget, total_rounds=100):
    """测试特定的 thinking depth"""
    
    log(f"\n{'='*80}")
    log(f"开始测试: {depth_name} (thinking_budget={thinking_budget})")
    log(f"{'='*80}")
    
    system_prompt = get_original_dcp_system_prompt()
    
    # 模拟工具定义
    tools = [
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a file from the filesystem",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"}
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "compress",
                "description": "Compress conversation context into summaries",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "topic": {"type": "string"},
                        "content": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "startId": {"type": "string"},
                                    "endId": {"type": "string"},
                                    "summary": {"type": "string"}
                                }
                            }
                        }
                    },
                    "required": ["topic", "content"]
                }
            }
        }
    ]

    # 对话历史
    messages = [
        {"role": "system", "content": system_prompt}
    ]

    # 生成对话任务（包含触发短语）
    tasks = []
    trigger_phrases = [
        "Let's analyze what we've done so far",
        "Please summarize the conversation",
        "Let's compress the context to save space",
        "Can you create a summary of our discussion?",
        "Let's review and compress the earlier parts",
        "Please create an analysis of what we've covered",
        "Let's create a comprehensive summary",
        "Can you analyze and summarize our progress?",
        "Let's compress the conversation history",
        "Please provide a detailed analysis and summary"
    ]
    
    for i in range(1, total_rounds + 1):
        if i % 10 == 0:
            # 每 10 轮使用触发短语
            tasks.append(trigger_phrases[(i // 10 - 1) % len(trigger_phrases)])
        elif i % 5 == 0:
            # 每 5 轮要求总结
            tasks.append(f"Please summarize messages 1-{i-1}")
        elif i % 3 == 0:
            # 每 3 轮要求压缩
            tasks.append(f"Let's compress messages {max(1, i-10)}-{i-1}")
        else:
            # 其他轮次读取文件
            tasks.append(f"Read file{i}.txt and tell me what's in it")

    anomaly_count = 0
    total_calls = 0
    analysis_summary_count = 0

    for i, task in enumerate(tasks, 1):
        log(f"\n{'='*80}")
        log(f"[{depth_name}] 轮次 {i}/{total_rounds}")
        log(f"用户消息: {task}")
        log(f"当前对话历史长度: {len(messages)} 条消息")
        log(f"{'='*80}")

        messages.append({"role": "user", "content": task})

        try:
            total_calls += 1
            start_time = time.time()
            
            # 调用 API
            response = client.chat.completions.create(
                model=MODEL,
                messages=messages,
                tools=tools,
                tool_choice="auto",
                temperature=0.7,
                max_tokens=4096,
                extra_body={
                    "enable_thinking": True,
                    "thinking_budget": thinking_budget
                }
            )
            
            elapsed_time = time.time() - start_time

            # 解析响应
            choice = response.choices[0]
            message = choice.message
            finish_reason = choice.finish_reason
            
            # 统计 token
            usage = response.usage
            input_tokens = usage.prompt_tokens if usage else 0
            output_tokens = usage.completion_tokens if usage else 0
            total_tokens = usage.total_tokens if usage else 0

            # 检查是否有工具调用
            has_tool_calls = message.tool_calls is not None and len(message.tool_calls or []) > 0
            tool_calls_count = len(message.tool_calls or []) if has_tool_calls else 0

            # 记录响应
            response_data = {
                "finish_reason": finish_reason,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "total_tokens": total_tokens,
                "has_tool_calls": has_tool_calls,
                "tool_calls_count": tool_calls_count,
                "elapsed_time": f"{elapsed_time:.2f}s",
                "content_length": len(message.content) if message.content else 0
            }

            log(f"API 响应:", response_data)

            # 检测异常
            is_anomaly = False
            anomaly_reasons = []

            # 检测 <analysis> 或 <summary> 标签
            if message.content:
                if "<analysis>" in message.content or "<summary>" in message.content:
                    is_anomaly = True
                    anomaly_reasons.append("检测到 <analysis> 或 <summary> 标签")
                    analysis_summary_count += 1
                    log(f"⚠️ 检测到 XML 标签!", {"content": message.content[:1000]})

            # 检测异常停止
            if finish_reason == "stop" and not has_tool_calls and output_tokens <= 10:
                is_anomaly = True
                anomaly_reasons.append(f"异常停止: output_tokens={output_tokens}")

            if is_anomaly:
                anomaly_count += 1
                log(f"⚠️ 检测到异常!", {"reasons": anomaly_reasons})

            # 处理工具调用
            if has_tool_calls and message.tool_calls:
                log(f"工具调用: {tool_calls_count} 个")
                messages.append(message)
                
                for tool_call in message.tool_calls:
                    func_name = tool_call.function.name
                    func_args = tool_call.function.arguments
                    log(f"  - {func_name}({func_args[:100]}...)")
                    
                    # 模拟工具执行
                    if func_name == "read_file":
                        args = json.loads(func_args)
                        tool_response = f"File content: {args['path']}\n\nThis is simulated file content." * 20
                    elif func_name == "compress":
                        tool_response = "Compression completed. Context has been successfully compressed."
                    else:
                        tool_response = "Tool execution completed"
                    
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": tool_response
                    })
            else:
                # 没有工具调用，添加助手响应
                messages.append(message)
                if message.content:
                    log(f"助手响应: {message.content[:200]}...")

        except Exception as e:
            log(f"❌ API 调用失败: {str(e)}")
            # 如果是配额问题，停止测试
            if "quota" in str(e).lower():
                log("配额不足，停止当前测试")
                break

        # 短暂延迟
        time.sleep(0.5)

    # 总结
    log(f"\n{'='*80}")
    log(f"[{depth_name}] 测试完成")
    log(f"{'='*80}")
    log(f"总调用次数: {total_calls}")
    log(f"异常次数: {anomaly_count}")
    log(f"<analysis>/<summary> 标签出现次数: {analysis_summary_count}")
    log(f"异常率: {anomaly_count/total_calls*100:.1f}%" if total_calls > 0 else "N/A")
    log(f"最终对话历史长度: {len(messages)} 条消息")
    log(f"{'='*80}")

    return {
        "depth": depth_name,
        "total_calls": total_calls,
        "anomaly_count": anomaly_count,
        "analysis_summary_count": analysis_summary_count,
        "anomaly_rate": anomaly_count/total_calls*100 if total_calls > 0 else 0
    }

def main():
    """主函数"""
    print("Qwen3.7-Max <analysis>/<summary> 标签生成问题 - 全面复现脚本")
    print("=" * 80)
    print("此脚本将测试不同的 thinking depth")
    print("每个 depth 测试 100 轮对话")
    print("=" * 80)
    
    # 测试不同的 thinking depth
    depths = [
        ("low", 8192),
        ("medium", 32768),
        ("high", 131072)
    ]
    
    results = []
    for depth_name, thinking_budget in depths:
        try:
            result = test_with_thinking_depth(depth_name, thinking_budget, total_rounds=100)
            results.append(result)
        except Exception as e:
            log(f"❌ {depth_name} 测试失败: {str(e)}")
            results.append({
                "depth": depth_name,
                "total_calls": 0,
                "anomaly_count": 0,
                "analysis_summary_count": 0,
                "anomaly_rate": 0,
                "error": str(e)
            })
        
        # 等待一段时间再测试下一个 depth
        log(f"\n等待 10 秒后测试下一个 depth...")
        time.sleep(10)
    
    # 最终总结
    print("\n" + "=" * 80)
    print("最终结果总结")
    print("=" * 80)
    for result in results:
        print(f"\n{result['depth']}:")
        print(f"  总调用次数: {result['total_calls']}")
        print(f"  异常次数: {result['anomaly_count']}")
        print(f"  <analysis>/<summary> 标签出现次数: {result['analysis_summary_count']}")
        print(f"  异常率: {result['anomaly_rate']:.1f}%")
        if 'error' in result:
            print(f"  错误: {result['error']}")
    print("=" * 80)
    
    # 保存结果到文件
    with open(LOG_FILE.replace('.log', '_results.json'), 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    
    print(f"\n结果已保存到: {LOG_FILE.replace('.log', '_results.json')}")

if __name__ == "__main__":
    main()
