#!/usr/bin/env python3
"""
Qwen3.7-Max 异常停止问题 - 复杂场景复现脚本

增加更多轮次、更复杂的任务、更长的上下文，尝试触发异常停止问题。
"""

import json
import time
from datetime import datetime
from openai import OpenAI

# OpenCode 配置
BASE_URL = "http://192.168.33.110:8000/v1"
API_KEY = "sk-st0868"
MODEL = "qwen3.7-max"

# 初始化客户端
client = OpenAI(
    base_url=BASE_URL,
    api_key=API_KEY
)

# 日志文件
LOG_FILE = f"qwen37_complex_reproduction_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"

def log(message, data=None):
    """记录日志"""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    log_entry = f"[{timestamp}] {message}"
    if data:
        log_entry += f"\n{json.dumps(data, indent=2, ensure_ascii=False)}"
    
    print(log_entry)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(log_entry + "\n\n")

def simulate_complex_conversation():
    """模拟复杂的多轮对话"""
    
    # 系统提示词（英文版本 - 触发问题）
    system_prompt = """You are a helpful AI assistant with access to tools.

You operate in a context-constrained environment. Manage context continuously to avoid buildup and preserve retrieval quality.

The ONLY tool you have for context management is `compress`. It replaces older conversation content with technical summaries you produce.

CRITICAL CONSTRAINTS
- Context management is done ONLY by calling the `compress` tool. NEVER generate summaries as plain text.
- NEVER output `<summary>` or `<analysis>` tags in your text response. These are NOT part of your output format.
- If you think context needs compression, call the `compress` tool. Do NOT write a summary inline.

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
                        "path": {
                            "type": "string",
                            "description": "The file path to read"
                        }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Write content to a file",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The file path to write to"
                        },
                        "content": {
                            "type": "string",
                            "description": "The content to write"
                        }
                    },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_files",
                "description": "List files in a directory",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The directory path to list"
                        }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "search_code",
                "description": "Search for code patterns in files",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": {
                            "type": "string",
                            "description": "The pattern to search for"
                        },
                        "path": {
                            "type": "string",
                            "description": "The path to search in"
                        }
                    },
                    "required": ["pattern"]
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
                        "topic": {
                            "type": "string",
                            "description": "Short label (3-5 words) for the compression"
                        },
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

    # 复杂的多轮对话任务（20 轮）
    tasks = [
        "Please analyze the code structure of this project and list all directories recursively.",
        "Read the README.md file and provide a detailed summary of its content.",
        "Search for all Python files in the project and list them.",
        "Read the main.py file if it exists, otherwise read index.js.",
        "Create a new file called 'project_analysis.md' with a comprehensive analysis.",
        "Read the project_analysis.md file you just created.",
        "Search for all configuration files (package.json, pyproject.toml, etc.).",
        "Read each configuration file you found and summarize their purposes.",
        "Create a file called 'config_summary.md' with the configuration summaries.",
        "Read the config_summary.md file to verify its content.",
        "Search for all test files in the project.",
        "List all test files and categorize them by type.",
        "Create a file called 'test_inventory.md' with the test file inventory.",
        "Read the test_inventory.md file.",
        "Search for all documentation files (*.md, *.txt, *.rst).",
        "Create a comprehensive documentation index in 'docs_index.md'.",
        "Read the docs_index.md file.",
        "Now let's compress the earlier conversation to save context. Please use the compress tool to summarize the first 10 messages.",
        "After compression, create a final summary file called 'final_report.md'.",
        "Read the final_report.md file and verify everything is correct."
    ]

    log("=" * 80)
    log(f"开始复杂场景复现测试")
    log(f"模型: {MODEL}")
    log(f"API: {BASE_URL}")
    log(f"总轮次: {len(tasks)}")
    log("=" * 80)

    anomaly_count = 0
    total_calls = 0
    consecutive_stops = 0

    for i, task in enumerate(tasks, 1):
        log(f"\n{'='*80}")
        log(f"轮次 {i}/{len(tasks)}")
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
                max_tokens=4096
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
                "content_length": len(message.content) if message.content else 0,
                "content_preview": (message.content[:200] + "...") if message.content and len(message.content) > 200 else message.content
            }

            log(f"API 响应:", response_data)

            # 检测异常停止
            is_anomaly = False
            anomaly_reasons = []

            # 检测条件 1: finish_reason=stop 且没有工具调用且输出 token 很少
            if finish_reason == "stop" and not has_tool_calls and output_tokens <= 10:
                is_anomaly = True
                anomaly_reasons.append(f"异常停止: finish_reason=stop, output_tokens={output_tokens}, has_tool_calls=False")
                consecutive_stops += 1
            else:
                consecutive_stops = 0
            
            # 检测条件 2: 检测到 <analysis> 或 <summary> 标签
            if message.content and ("<analysis>" in message.content or "<summary>" in message.content):
                is_anomaly = True
                anomaly_reasons.append("检测到 <analysis> 或 <summary> 标签")

            # 检测条件 3: 连续多次停止
            if consecutive_stops >= 2:
                is_anomaly = True
                anomaly_reasons.append(f"连续 {consecutive_stops} 次停止")

            if is_anomaly:
                anomaly_count += 1
                log(f"⚠️ 检测到异常停止!", {"reasons": anomaly_reasons})
                log(f"完整响应内容:", {"content": message.content})

            # 处理工具调用
            if has_tool_calls and message.tool_calls:
                log(f"工具调用: {tool_calls_count} 个")
                messages.append(message)
                
                for tool_call in message.tool_calls:
                    log(f"  - {tool_call.function.name}({tool_call.function.arguments[:100]}...)")
                    
                    # 模拟工具执行
                    if tool_call.function.name == "read_file":
                        args = json.loads(tool_call.function.arguments)
                        tool_response = f"文件内容: {args['path']}\n\n这是模拟的文件内容。包含一些示例文本用于测试。" * 10
                    elif tool_call.function.name == "write_file":
                        args = json.loads(tool_call.function.arguments)
                        tool_response = f"成功写入文件: {args['path']} ({len(args['content'])} 字节)"
                    elif tool_call.function.name == "list_files":
                        args = json.loads(tool_call.function.arguments)
                        tool_response = f"目录 {args['path']} 的文件列表:\n- file1.py\n- file2.py\n- README.md\n- package.json"
                    elif tool_call.function.name == "search_code":
                        args = json.loads(tool_call.function.arguments)
                        tool_response = f"搜索 '{args['pattern']}' 的结果:\n找到 5 个匹配项"
                    elif tool_call.function.name == "compress":
                        tool_response = "压缩完成。上下文已成功压缩。"
                    else:
                        tool_response = "工具执行完成"
                    
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": tool_response
                    })
            else:
                # 没有工具调用，添加助手响应
                messages.append(message)
                log(f"助手响应: {message.content[:200] if message.content else '(空)'}...")

        except Exception as e:
            log(f"❌ API 调用失败: {str(e)}")
            break

        # 短暂延迟，避免过快调用
        time.sleep(0.5)

    # 总结
    log(f"\n{'='*80}")
    log("测试完成")
    log(f"{'='*80}")
    log(f"总调用次数: {total_calls}")
    log(f"异常停止次数: {anomaly_count}")
    log(f"异常率: {anomaly_count/total_calls*100:.1f}%" if total_calls > 0 else "N/A")
    log(f"最终对话历史长度: {len(messages)} 条消息")
    log(f"日志文件: {LOG_FILE}")
    log(f"{'='*80}")

    return anomaly_count, total_calls

def main():
    """主函数"""
    print("Qwen3.7-Max 异常停止问题 - 复杂场景复现脚本")
    print("=" * 80)
    print("此脚本将执行 20 轮复杂对话，尝试触发异常停止问题")
    print("=" * 80)
    
    anomaly, total = simulate_complex_conversation()
    
    print("\n" + "=" * 80)
    print("最终结果")
    print("=" * 80)
    print(f"总调用次数: {total}")
    print(f"异常停止次数: {anomaly}")
    print(f"异常率: {anomaly/total*100:.1f}%" if total > 0 else "N/A")
    print("=" * 80)

if __name__ == "__main__":
    main()
