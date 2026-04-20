import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { formatDistanceToNow } from "date-fns";
import {
  AGENT_CONFIGS,
  type UnifiedSession,
  type AgentType,
} from "../providers/types.js";
import { applyFilters } from "../core/aggregator.js";
import {
  getSessionHistory,
  type HistoryMessage,
} from "../core/history.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AppProps {
  sessions: UnifiedSession[];
  onSelect: (session: UnifiedSession) => void;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** agent 过滤器循环列表 */
const AGENT_FILTER_CYCLE: (AgentType | "all")[] = [
  "all",
  "claude-code",
  "codex",
  "cursor",
  "opencode",
];

/** 可见列表行数 */
const VISIBLE_ROWS = 15;

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** 缩短路径显示：将 HOME 前缀替换为 ~，超长则截断中间 */
function shortenPath(p: string, maxLen = 30): string {
  if (!p) return "";
  const home = process.env["HOME"] || process.env["USERPROFILE"] || "";
  let display = p;
  if (home && display.startsWith(home)) {
    display = "~" + display.slice(home.length);
  }
  if (display.length <= maxLen) return display;
  return display.slice(0, 12) + "..." + display.slice(-15);
}

/** 相对时间格式化 */
function relativeTime(date: Date): string {
  try {
    return formatDistanceToNow(date, { addSuffix: true });
  } catch {
    return "";
  }
}

/** Agent badge 彩色标识 */
function AgentBadge({ agent }: { agent: AgentType }) {
  const config = AGENT_CONFIGS[agent];
  return (
    <Text color={config.color} bold>
      {config.icon}
    </Text>
  );
}

/** 过滤器标签 */
function filterLabel(f: AgentType | "all"): string {
  if (f === "all") return "All Agents";
  return AGENT_CONFIGS[f].displayName;
}

// ---------------------------------------------------------------------------
// HistoryView 历史预览组件
// ---------------------------------------------------------------------------

interface HistoryViewProps {
  session: UnifiedSession;
  messages: HistoryMessage[] | null; // null = loading
}

/** 截断文本到指定宽度，保留首行 */
function truncateText(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 3) + "...";
}

function HistoryView({ session, messages }: HistoryViewProps) {
  const MAX_MESSAGES = 20;
  const MAX_WIDTH = 80;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box
        borderStyle="single"
        borderColor="cyan"
        paddingX={1}
        flexDirection="column"
      >
        {/* 会话信息头 */}
        <Box marginBottom={1} flexDirection="column">
          <Text color="cyan" bold>
            {" "}Message History
          </Text>
          <Text> </Text>
          <Text>
            {"  "}
            <AgentBadge agent={session.agent} />
            {"  "}
            <Text bold>{session.title}</Text>
          </Text>
          <Text color="gray">
            {"  "}
            {shortenPath(session.workingDirectory, 60)}
          </Text>
        </Box>

        {/* 消息列表 */}
        {messages === null ? (
          <Box paddingY={1} justifyContent="center">
            <Text color="yellow">Loading...</Text>
          </Box>
        ) : messages.length === 0 ? (
          <Box paddingY={1} justifyContent="center">
            <Text color="gray">No message history available.</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {messages.slice(-MAX_MESSAGES).map((msg, i) => {
              const roleColor =
                msg.role === "user"
                  ? "cyan"
                  : msg.role === "assistant"
                    ? "green"
                    : "gray";
              const content = truncateText(msg.content, MAX_WIDTH);

              return (
                <Box key={i} flexDirection="column">
                  <Text>
                    {"  "}
                    <Text color={roleColor} bold>
                      [{msg.role}]
                    </Text>
                    {msg.timestamp && (
                      <Text color="gray" dimColor>
                        {" "}
                        {msg.timestamp.toLocaleString()}
                      </Text>
                    )}
                  </Text>
                  <Text color="white">{"    "}{content}</Text>
                  {i < Math.min(messages.length, MAX_MESSAGES) - 1 && (
                    <Text> </Text>
                  )}
                </Box>
              );
            })}
            {messages.length > MAX_MESSAGES && (
              <Box marginTop={1}>
                <Text color="gray" dimColor>
                  {"  "}Showing last {MAX_MESSAGES} of {messages.length} messages
                </Text>
              </Box>
            )}
          </Box>
        )}
      </Box>

      {/* 底部提示 */}
      <Box paddingX={1}>
        <Text color="gray">
          Press <Text color="white" bold>any key</Text> to return
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// HelpView 帮助页面组件
// ---------------------------------------------------------------------------

function HelpView() {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="single" borderColor="cyan" paddingX={1} flexDirection="column">
        {/* 小自传 */}
        <Box marginBottom={1} flexDirection="column">
          <Text color="cyan" bold>
            {" "}asm - Agent Sessions Manager v0.1.0
          </Text>
          <Text> </Text>
          <Text color="gray">
            {"  "}你有没有过这种经历？明明记得跟 AI 讨论过某个问题，
          </Text>
          <Text color="gray">
            {"  "}但就是想不起来是在哪个目录、哪个 agent、哪个会话里。
          </Text>
          <Text color="gray">
            {"  "}于是你打开一个终端，cd 到某个目录，打开 agent，翻了半天，
          </Text>
          <Text color="gray">
            {"  "}发现不在这儿。再试另一个目录...另一个 agent...
          </Text>
          <Text> </Text>
          <Text color="white">
            {"  "}asm 就是为了终结这个循环而生的。
          </Text>
          <Text color="gray">
            {"  "}它潜入你所有 coding agent 的本地数据，把散落各处的会话
          </Text>
          <Text color="gray">
            {"  "}汇聚成一张统一视图。搜索、过滤、一键恢复——
          </Text>
          <Text color="gray">
            {"  "}让你把时间花在写代码上，而不是找代码在哪。
          </Text>
        </Box>

        {/* 快捷键 */}
        <Box marginBottom={1} flexDirection="column">
          <Text color="yellow" bold>  Keybindings</Text>
          <Text> </Text>
          <Text>  <Text color="white" bold>{"  ↑/↓"}</Text><Text color="gray">  或  </Text><Text color="white" bold>j/k</Text>{"    "}上下导航</Text>
          <Text>  <Text color="white" bold>Enter</Text>{"          "}恢复选中会话 (cd + resume)</Text>
          <Text>  <Text color="white" bold>{"    /"}</Text>{"          "}进入搜索模式 (模糊匹配)</Text>
          <Text>  <Text color="white" bold>{"  Tab"}</Text>{"          "}切换 Agent 过滤器</Text>
          <Text>  <Text color="white" bold>{"    h"}</Text>{"          "}预览选中会话的消息历史</Text>
          <Text>  <Text color="white" bold>{"  Esc"}</Text>{"          "}退出搜索 / 关闭帮助</Text>
          <Text>  <Text color="white" bold>{"    ?"}</Text>{"          "}显示/关闭本帮助</Text>
          <Text>  <Text color="white" bold>{"    q"}</Text>{"          "}退出 asm</Text>
        </Box>

        {/* Agent 支持表 */}
        <Box marginBottom={1} flexDirection="column">
          <Text color="yellow" bold>  Supported Agents</Text>
          <Text> </Text>
          <Text>  <Text color="magenta" bold>CC</Text>  Claude Code    <Text color="green">full resume</Text>     claude -r {"<id>"}</Text>
          <Text>  <Text color="green" bold>CX</Text>  Codex          <Text color="green">full resume</Text>     codex --resume {"<id>"}</Text>
          <Text>  <Text color="blue" bold>CR</Text>  Cursor         <Text color="yellow">open workspace</Text>  cursor {"<dir>"}</Text>
          <Text>  <Text color="cyan" bold>OC</Text>  OpenCode       <Text color="yellow">open workspace</Text>  opencode</Text>
          <Text> </Text>
          <Text color="gray">  {"  "}full resume = cd 到对应目录 + 恢复到具体会话上下文</Text>
          <Text color="gray">  {"  "}open workspace = 打开 workspace 目录 (无法定位到具体会话)</Text>
        </Box>

        {/* 命令行示例 */}
        <Box flexDirection="column">
          <Text color="yellow" bold>  CLI Commands</Text>
          <Text> </Text>
          <Text>  <Text color="gray">$</Text> asm                          交互式 TUI (就是你现在看到的)</Text>
          <Text>  <Text color="gray">$</Text> asm list                     列出所有会话</Text>
          <Text>  <Text color="gray">$</Text> asm list -a claude-code      只看 Claude Code</Text>
          <Text>  <Text color="gray">$</Text> asm list -s 7d               最近 7 天的会话</Text>
          <Text>  <Text color="gray">$</Text> asm list -d ~/Projects       按目录过滤</Text>
          <Text>  <Text color="gray">$</Text> asm search "关键词"          模糊搜索</Text>
          <Text>  <Text color="gray">$</Text> asm open {"<session-id>"}        直接恢复指定会话</Text>
        </Box>
      </Box>

      {/* 底部提示 */}
      <Box paddingX={1}>
        <Text color="gray">
          Press <Text color="white" bold>any key</Text> to return
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// App 主组件
// ---------------------------------------------------------------------------

export function App({ sessions, onSelect }: AppProps) {
  const { exit } = useApp();

  // 状态
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historySession, setHistorySession] = useState<UnifiedSession | null>(null);
  const [historyMessages, setHistoryMessages] = useState<HistoryMessage[] | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [agentFilterIdx, setAgentFilterIdx] = useState(0);

  const agentFilter = AGENT_FILTER_CYCLE[agentFilterIdx]!;

  // 过滤后的会话列表
  const filteredSessions = useMemo(() => {
    return applyFilters(sessions, {
      agent: agentFilter === "all" ? undefined : agentFilter,
      keyword: searchQuery || undefined,
    });
  }, [sessions, agentFilter, searchQuery]);

  // 索引越界保护
  useEffect(() => {
    if (filteredSessions.length === 0) {
      setSelectedIndex(0);
      setScrollOffset(0);
    } else if (selectedIndex >= filteredSessions.length) {
      setSelectedIndex(filteredSessions.length - 1);
    }
  }, [filteredSessions.length, selectedIndex]);

  // 键盘输入处理
  useInput((input, key) => {
    // ── 帮助页面模式: 任意键关闭 ──
    if (showHelp) {
      setShowHelp(false);
      return;
    }

    // ── 历史预览模式: 任意键关闭 ──
    if (showHistory) {
      setShowHistory(false);
      setHistorySession(null);
      setHistoryMessages(null);
      return;
    }

    // ── 搜索模式 ──
    if (searchMode) {
      if (key.escape) {
        setSearchMode(false);
        setSearchQuery("");
        return;
      }
      if (key.return) {
        setSearchMode(false);
        return;
      }
      if (key.upArrow) {
        navigateUp();
        return;
      }
      if (key.downArrow) {
        navigateDown();
        return;
      }
      return;
    }

    // ── 普通模式 ──
    if (input === "q" || key.escape) {
      exit();
      return;
    }

    if (input === "?") {
      setShowHelp(true);
      return;
    }

    if (input === "h") {
      const session = filteredSessions[selectedIndex];
      if (session) {
        setHistorySession(session);
        setHistoryMessages(null); // loading 状态
        setShowHistory(true);
        // 异步获取历史
        getSessionHistory(session.id, session.agent, session.workingDirectory)
          .then((history) => setHistoryMessages(history.messages))
          .catch(() => setHistoryMessages([]));
      }
      return;
    }

    if (input === "/" || input === "s") {
      setSearchMode(true);
      return;
    }

    if (key.tab) {
      setAgentFilterIdx((prev) => (prev + 1) % AGENT_FILTER_CYCLE.length);
      setSelectedIndex(0);
      setScrollOffset(0);
      return;
    }

    if (key.upArrow || input === "k") {
      navigateUp();
      return;
    }

    if (key.downArrow || input === "j") {
      navigateDown();
      return;
    }

    if (key.return) {
      const session = filteredSessions[selectedIndex];
      if (session) {
        onSelect(session);
        exit();
      }
      return;
    }
  });

  function navigateUp() {
    setSelectedIndex((prev) => {
      const next = Math.max(0, prev - 1);
      if (next < scrollOffset) {
        setScrollOffset(next);
      }
      return next;
    });
  }

  function navigateDown() {
    setSelectedIndex((prev) => {
      const next = Math.min(filteredSessions.length - 1, prev + 1);
      if (next >= scrollOffset + VISIBLE_ROWS) {
        setScrollOffset(next - VISIBLE_ROWS + 1);
      }
      return next;
    });
  }

  // ── 历史预览页面 ──
  if (showHistory && historySession) {
    return <HistoryView session={historySession} messages={historyMessages} />;
  }

  // ── 帮助页面 ──
  if (showHelp) {
    return <HelpView />;
  }

  // ── 主列表视图 ──
  const visibleSessions = filteredSessions.slice(
    scrollOffset,
    scrollOffset + VISIBLE_ROWS,
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* 头部: 搜索 + 过滤器 */}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Box flexGrow={1}>
          {searchMode ? (
            <Box>
              <Text color="yellow">Search: </Text>
              <TextInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Type to search..."
              />
            </Box>
          ) : (
            <Text>
              <Text color="gray">
                {searchQuery
                  ? `Search: "${searchQuery}"`
                  : "Press / to search"}
              </Text>
            </Text>
          )}
        </Box>
        <Box marginLeft={2}>
          <Text color="cyan">[{filterLabel(agentFilter)}]</Text>
        </Box>
      </Box>

      {/* 会话列表 */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        minHeight={VISIBLE_ROWS + 2}
      >
        {filteredSessions.length === 0 ? (
          <Box justifyContent="center" paddingY={2}>
            <Text color="gray">No sessions found.</Text>
          </Box>
        ) : (
          visibleSessions.map((session, i) => {
            const globalIndex = scrollOffset + i;
            const isSelected = globalIndex === selectedIndex;

            return (
              <Box key={session.id + session.agent} gap={1}>
                <Text color="yellow">{isSelected ? ">" : " "}</Text>
                <AgentBadge agent={session.agent} />
                <Box width={40}>
                  <Text
                    color={isSelected ? "yellow" : "white"}
                    bold={isSelected}
                    wrap="truncate"
                  >
                    {session.title}
                  </Text>
                </Box>
                <Box width={30}>
                  <Text color="gray" wrap="truncate">
                    {shortenPath(session.workingDirectory)}
                  </Text>
                </Box>
                <Box width={16}>
                  <Text color="green" wrap="truncate">
                    {session.gitBranch || ""}
                  </Text>
                </Box>
                <Box width={18}>
                  <Text color="gray" dimColor wrap="truncate">
                    {relativeTime(session.updatedAt)}
                  </Text>
                </Box>
              </Box>
            );
          })
        )}

        {/* 滚动指示 */}
        {filteredSessions.length > VISIBLE_ROWS && (
          <Box justifyContent="flex-end">
            <Text color="gray" dimColor>
              [{scrollOffset + 1}-
              {Math.min(scrollOffset + VISIBLE_ROWS, filteredSessions.length)}/
              {filteredSessions.length}]
            </Text>
          </Box>
        )}
      </Box>

      {/* 底部帮助栏 */}
      <Box paddingX={1} gap={2}>
        <Text color="gray">
          <Text color="white" bold>Enter</Text> resume
          {"  "}
          <Text color="white" bold>↑↓</Text> navigate
          {"  "}
          <Text color="white" bold>Tab</Text> filter
          {"  "}
          <Text color="white" bold>/</Text> search
          {"  "}
          <Text color="white" bold>h</Text> history
          {"  "}
          <Text color="white" bold>?</Text> help
          {"  "}
          <Text color="white" bold>q</Text> quit
        </Text>
      </Box>
    </Box>
  );
}
