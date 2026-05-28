#!/usr/bin/env python3
"""
Qwen3.7-Max + DCP 插件异常停止问题复现脚本

重点：
1. 使用 DCP 插件的原始英文提示词
2. 模拟多轮对话（20+ 轮）
3. 包含压缩相关的任务
4. 尝试触发 <analysis>/<summary> 标签生成
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
LOG_FILE = f"qwen37_dcp_reproduction_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"

def log(message, data=None):
    """记录日志"""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    log_entry = f"[{timestamp}] {message}"
    if data:
        log_entry += f"\n{json.dumps(data, indent=2, ensure_ascii=False)}"
    
    print(log_entry)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(log_entry + "\n\n")

def get_dcp_system_prompt(use_chinese=False):
    """获取 DCP 系统提示词"""
    
    if use_chinese:
        return """你在一个上下文受限的环境中运行。持续管理上下文以避免堆积并保持检索质量。高效的上下文管理对你的代理性能至关重要。

你用于上下文管理的唯一工具是 `compress`。它用你生成的技术摘要替换较旧的对话内容。

关键约束
- 上下文管理仅通过调用 `compress` 工具完成。绝不以纯文本形式生成摘要。
- **严格禁止**在文本响应中输出 `<summary>` 或 `<analysis>` XML 标签。这些标签会导致系统错误。
- 如果你认为上下文需要压缩，调用 `compress` 工具。不要内联编写摘要。
- 所有输出必须使用**中文**。
- 如果需要在文本中组织信息，使用 Markdown 格式（如 `## 分析`、`## 总结`），绝不使用 XML 标签。

压缩的哲学
`compress` 将对话内容转换为密集、高保真的摘要。这不是清理——而是结晶。你的摘要成为所发生事情的权威记录。

将压缩视为相变：原始探索变为精炼理解。原始上下文已完成其使命；你的摘要现在承载该理解向前。

何时压缩
当一个部分真正关闭且原始对话已完成其使命时：
- 研究已完成且发现已明确
- 实现已完成并验证
- 探索已穷尽且模式已理解
- 死胡同噪音可以在不等待整个章节关闭的情况下被丢弃

不要压缩的情况
- 原始上下文仍然相关且需要用于编辑或精确引用
- 目标内容仍在积极进行中
- 你可能在接下来的步骤中需要确切的代码、错误消息或文件内容

压缩前问自己：_"这个部分现在是否足够关闭以成为仅摘要？"_

定期评估对话的信噪比。有意识地使用 `compress` 并提供高质量摘要。智能地优先处理过时内容，以维护支持你代理能力的高信号上下文窗口。

保持锐利、高质量的上下文窗口以获得最佳性能是你的责任。"""
    else:
        # 原始英文提示词（触发问题）
        return """You operate in a context-constrained environment. Manage context continuously to avoid buildup and preserve retrieval quality. Efficient context management is paramount for your agentic performance.

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

def simulate_dcp_conversation(use_chinese_prompts=False):
    """模拟 DCP 场景的多轮对话"""
    
    system_prompt = get_dcp_system_prompt(use_chinese_prompts)
    
    # 模拟工具定义（包含 compress）
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
                "name": "write_file",
                "description": "Write content to a file",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "content": {"type": "string"}
                    },
                    "required": ["path", "content"]
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

    # 多轮对话任务（25 轮，模拟周末长时间对话）
    tasks = [
        "Let's start by analyzing the project structure. Read the root directory.",
        "Now read the README.md file and summarize it.",
        "Search for all Python files in the project.",
        "Read the main.py file if it exists.",
        "Create a file called 'analysis_step1.md' with your findings.",
        "Read the analysis_step1.md file to verify.",
        "Now let's look at the configuration files. Read package.json.",
        "Read pyproject.toml if it exists.",
        "Create a file called 'config_analysis.md' with configuration details.",
        "Read the config_analysis.md file.",
        "Search for all test files in the project.",
        "List all test files and their purposes.",
        "Create a file called 'test_inventory.md'.",
        "Read the test_inventory.md file.",
        "Now let's examine the documentation. Read all .md files.",
        "Create a comprehensive documentation index in 'docs_index.md'.",
        "Read the docs_index.md file.",
        "Let's review what we've done so far. Summarize the first 10 steps.",
        "Create a progress report in 'progress_report.md'.",
        "Read the progress_report.md file.",
        "Now I think we should compress the earlier conversation to save context.",
        "Please use the compress tool to summarize messages 1-15.",
        "After compression, create a final summary in 'final_summary.md'.",
        "Read the final_summary.md file.",
        "Let's compress one more time. Summarize the remaining conversation."
    ]

    prompt_type = "中文" if use_chinese_prompts else "英文"
    log("=" * 80)
    log(f"开始 DCP 场景复现测试 - 使用{prompt_type}提示词")
    log(f"模型: {MODEL}")
    log(f"API: {BASE_URL}")
    log(f"总轮次: {len(tasks)}")
    log("=" * 80)

    anomaly_count = 0
    total_calls = 0
    analysis_summary_count = 0

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
                    log(f"⚠️ 检测到 XML 标签!", {"content": message.content[:500]})

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
                        tool_response = f"文件内容: {args['path']}\n\n这是模拟的文件内容。" * 20
                    elif func_name == "write_file":
                        args = json.loads(func_args)
                        tool_response = f"成功写入文件: {args['path']} ({len(args['content'])} 字节)"
                    elif func_name == "compress":
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
                if message.content:
                    log(f"助手响应: {message.content[:200]}...")

        except Exception as e:
            log(f"❌ API 调用失败: {str(e)}")
            break

        # 短暂延迟
        time.sleep(0.5)

    # 总结
    log(f"\n{'='*80}")
    log("测试完成")
    log(f"{'='*80}")
    log(f"总调用次数: {total_calls}")
    log(f"异常次数: {anomaly_count}")
    log(f"<analysis>/<summary> 标签出现次数: {analysis_summary_count}")
    log(f"异常率: {anomaly_count/total_calls*100:.1f}%" if total_calls > 0 else "N/A")
    log(f"最终对话历史长度: {len(messages)} 条消息")
    log(f"日志文件: {LOG_FILE}")
    log(f"{'='*80}")

    return anomaly_count, total_calls, analysis_summary_count

def main():
    """主函数"""
    print("Qwen3.7-Max + DCP 插件异常停止问题复现脚本")
    print("=" * 80)
    print("此脚本将执行 25 轮多轮对话，尝试触发 DCP 相关的异常停止问题")
    print("=" * 80)
    
    # 测试 1: 使用英文提示词（预期触发问题）
    print("\n测试 1: 使用英文 DCP 提示词（预期触发问题）")
    anomaly_en, total_en, tags_en = simulate_dcp_conversation(use_chinese_prompts=False)
    
    # 等待一段时间
    print("\n等待 5 秒...")
    time.sleep(5)
    
    # 测试 2: 使用中文提示词（修复后）
    print("\n测试 2: 使用中文 DCP 提示词（预期减少问题）")
    anomaly_zh, total_zh, tags_zh = simulate_dcp_conversation(use_chinese_prompts=True)
    
    # 对比结果
    print("\n" + "=" * 80)
    print("对比结果")
    print("=" * 80)
    print(f"英文提示词: {anomaly_en}/{total_en} 异常, {tags_en} 次 XML 标签")
    print(f"中文提示词: {anomaly_zh}/{total_zh} 异常, {tags_zh} 次 XML 标签")
    print("=" * 80)

if __name__ == "__main__":
    main()
