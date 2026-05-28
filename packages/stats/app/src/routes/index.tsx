import "./index.css"
import { Meta, Title } from "@solidjs/meta"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import {
  type CountryEntry,
  getStatsHomeData,
  type LeaderboardEntry,
  type MarketDay,
  type StatsHomeData,
  type SessionCostEntry,
  type TokenCostEntry,
  type UsagePoint,
} from "@opencode-ai/stats-core/domain/home"
import { runtime } from "@opencode-ai/stats-core/runtime"
import { createAsync, query } from "@solidjs/router"
import { scaleBand, scaleLinear } from "d3-scale"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { getRequestEvent } from "solid-js/web"

const products = ["All Users", "Zen", "Go", "Enterprise"] as const
const tokenProducts = ["Zen", "Go", "Enterprise"] as const
const ranges = ["1D", "1W", "1M", "3M", "YTD", "ALL"] as const
const headerLinks = [
  { href: "#top-models", label: "Top Models" },
  { href: "#leaderboard", label: "Leaderboard" },
  { href: "#market-share", label: "Market Share" },
  { href: "#token-cost", label: "Token Cost" },
  { href: "#session-cost", label: "Session Cost" },
] as const
const usageColors = ["#ff5d64", "#ff8a00", "#8bef00", "#12c8b3", "#18c7dc", "#6c7dff", "#9d73f7"]
const marketColors = ["#ed6aff", "#a684ff", "#7c86ff", "#51a2ff", "#00d3f2", "#00d5be", "#00bc7d", "#9ae600", "#ffb900"]
const countryPositions = [
  { x: 112, y: 96 },
  { x: 284, y: 144 },
  { x: 472, y: 92 },
  { x: 642, y: 154 },
  { x: 800, y: 96 },
  { x: 172, y: 234 },
  { x: 362, y: 250 },
  { x: 552, y: 236 },
  { x: 744, y: 252 },
  { x: 48, y: 184 },
  { x: 892, y: 198 },
  { x: 456, y: 176 },
] as const

type UsageProduct = (typeof products)[number]
type TokenProduct = (typeof tokenProducts)[number]
type UsageRange = (typeof ranges)[number]

const getData = query(async () => {
  "use server"
  return runtime.runPromise(getStatsHomeData())
}, "getStatsHomeData")

export default function StatsHome() {
  getRequestEvent()?.response.headers.set(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
  )
  const data = createAsync(() => getData())

  return (
    <main data-page="stats">
      <Title>OpenCode Stats</Title>
      <Meta name="description" content="OpenCode usage, market share, token cost, and session cost stats." />
      <div data-component="container">
        <Header />
        <div data-component="content">
          <Show when={data()} fallback={<StatsLoading />}>
            {(stats) => (
              <>
                <Hero updatedAt={stats().updatedAt} />
                <UsageSection data={stats().usage} />
                <LeaderboardSection data={stats().leaderboard} />
                <MarketShareSection data={stats().market} />
                <TokenCostSection data={stats().tokenCost} />
                <SessionCostSection data={stats().sessionCost} />
                <CountrySection data={stats().country} />
                <Newsletter />
              </>
            )}
          </Show>
        </div>
        <Footer />
      </div>
      <Legal />
    </main>
  )
}

function Hero(props: { updatedAt: string | null }) {
  return (
    <section data-section="hero">
      <div>
        <h1>OpenCode Stats</h1>
        <p data-slot="meta">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
            <rect x="3" y="3" width="10" height="10" fill="currentColor" />
            <rect x="7" y="6.5" width="2" height="4.5" fill="var(--stats-layer-2)" />
            <rect x="7" y="5" width="2" height="1" fill="var(--stats-layer-2)" />
          </svg>
          <span>OpenCode data</span> <b>·</b>{" "}
          <em>{props.updatedAt ? `Updated ${formatUpdatedAt(props.updatedAt)}` : "No rows yet"}</em>
        </p>
      </div>
      <p>See how model usage, provider share, cost, and geography move across OpenCode traffic.</p>
    </section>
  )
}

function StatsLoading() {
  return (
    <>
      <Hero updatedAt={null} />
      <ChartSection title="Usage">
        <EmptyState title="Loading stats" description="Reading model aggregates from model_stat." />
      </ChartSection>
    </>
  )
}

function ChartSection(props: { id?: string; title: string; description?: string; controls?: JSX.Element; children: JSX.Element }) {
  return (
    <section id={props.id} data-section="chart">
      <div data-slot="section-header">
        <div>
          <h2>{props.title}</h2>
          {props.description && <p>{props.description}</p>}
        </div>
        {props.controls}
      </div>
      {props.children}
    </section>
  )
}

function EmptyState(props: { title: string; description: string }) {
  return (
    <div data-component="empty-state">
      <strong>{props.title}</strong>
      <p>{props.description}</p>
    </div>
  )
}

function formatUpdatedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "just now"
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date)
}

function UsageSection(props: { data: StatsHomeData["usage"] }) {
  const [product, setProduct] = createSignal<UsageProduct>("All Users")
  const [range, setRange] = createSignal<UsageRange>("1W")
  const data = createMemo(() => props.data[product()][range()])

  return (
    <ChartSection id="top-models" title="Usage">
      <Show
        when={data().some((item) => usageTotal(item) > 0)}
        fallback={<EmptyState title="No usage data" description="No model_stat rows matched this product and range." />}
      >
        <UsageChart data={data()} />
      </Show>
      <div data-slot="chart-footer">
        <StatsFilters product={product()} range={range()} onProductSelect={setProduct} onRangeSelect={setRange} />
      </div>
    </ChartSection>
  )
}

function StatsFilters(props: {
  product: UsageProduct
  range: UsageRange
  onProductSelect: (product: UsageProduct) => void
  onRangeSelect: (range: UsageRange) => void
}) {
  return (
    <>
      <FilterPills
        items={products}
        selected={props.product}
        label="Product filter"
        variant="product"
        onSelect={props.onProductSelect}
      />
      <FilterPills
        items={ranges}
        selected={props.range}
        label="Date range"
        variant="range"
        onSelect={props.onRangeSelect}
      />
    </>
  )
}

function FilterPills<T extends string>(props: {
  items: readonly T[]
  selected: T
  label: string
  variant: "product" | "range"
  onSelect: (item: T) => void
}) {
  return (
    <div data-component="usage-filter" data-variant={props.variant} role="radiogroup" aria-label={props.label}>
      <For each={props.items}>
        {(item) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.selected === item}
            data-active={props.selected === item ? "true" : undefined}
            onClick={() => props.onSelect(item)}
          >
            {item}
          </button>
        )}
      </For>
    </div>
  )
}

function UsageChart(props: { data: UsagePoint[] }) {
  const [activeIndex, setActiveIndex] = createSignal<number>()
  const [activeSegment, setActiveSegment] = createSignal<number>()
  const height = 434
  const width = 920
  const headerOffset = 46
  const segmentGap = 2
  const maxTotal = createMemo(() => Math.max(1, Math.max(...props.data.map((item) => usageTotal(item))) * 1.02))
  const activePoint = createMemo(() => props.data[activeIndex() ?? -1])
  const y = createMemo(() => scaleLinear([0, maxTotal()], [height, 0]))
  const x = createMemo(() =>
    scaleBand(
      props.data.map((_, index) => String(index)),
      [0, width],
    ).paddingInner(0.08),
  )
  const activeBar = createMemo(() => {
    const index = activeIndex()
    const point = activePoint()
    if (index === undefined) return
    if (!point) return
    return {
      point,
      x: x()(String(index)) ?? 0,
      width: x().bandwidth(),
    }
  })

  return (
    <div data-component="usage-chart">
      <svg viewBox={`0 0 ${width} ${height + headerOffset}`} role="img" aria-label="Stacked usage chart">
        <defs>
          <pattern id="stats-usage-dot-grid" width="6" height="6" patternUnits="userSpaceOnUse">
            <rect x="1" y="1" width="2" height="2" fill="var(--stats-dot)" />
          </pattern>
        </defs>
        <For each={props.data}>
          {(day, dayIndex) => {
            const barX = x()(String(dayIndex())) ?? 0
            const barWidth = x().bandwidth()
            const stackTop = y()(usageTotal(day))
            return (
              <g
                role="button"
                tabIndex={0}
                aria-label={`${day.date} ${formatTokens(usageTotal(day))}`}
                data-active={activeIndex() === dayIndex() ? "true" : undefined}
                onPointerEnter={() => {
                  setActiveIndex(dayIndex())
                  setActiveSegment(undefined)
                }}
                onPointerLeave={(event) => {
                  if (event.pointerType === "touch") return
                  setActiveIndex(undefined)
                  setActiveSegment(undefined)
                }}
                onClick={() => setActiveIndex(dayIndex())}
                onFocus={() => {
                  setActiveIndex(dayIndex())
                  setActiveSegment(undefined)
                }}
                onBlur={() => {
                  setActiveIndex(undefined)
                  setActiveSegment(undefined)
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return
                  event.preventDefault()
                  setActiveIndex(dayIndex())
                }}
              >
                <rect
                  x={barX}
                  y="0"
                  width={barWidth}
                  height={height + headerOffset}
                  fill="transparent"
                  pointer-events="all"
                />
                <text x={barX} y="17" class="chart-total">
                  {formatTokens(usageTotal(day))}
                </text>
                <text x={barX} y="34" class="chart-date">
                  {day.date}
                </text>
                <rect x={barX} y={headerOffset} width={barWidth} height={stackTop} fill="url(#stats-usage-dot-grid)" />
                <For each={day.segments}>
                  {(segment, index) => {
                    const previous = day.segments.slice(0, index()).reduce((sum, item) => sum + item.value, 0)
                    const segmentHeight = y()(previous) - y()(previous + segment.value)
                    const segmentInset = index() === day.segments.length - 1 ? 0 : segmentGap
                    return (
                      <rect
                        x={barX}
                        y={headerOffset + y()(previous + segment.value) + segmentInset}
                        width={barWidth}
                        height={Math.max(segmentHeight - segmentInset, 0)}
                        data-segment-active={
                          activeIndex() === dayIndex() && activeSegment() === index() ? "true" : undefined
                        }
                        opacity={getUsageSegmentOpacity(activeIndex() === dayIndex(), activeSegment(), index())}
                        fill={activeIndex() === dayIndex() ? usageColors[index()] : "var(--stats-bar-idle)"}
                        onPointerEnter={(event) => {
                          event.stopPropagation()
                          setActiveIndex(dayIndex())
                          setActiveSegment(index())
                        }}
                      />
                    )
                  }}
                </For>
              </g>
            )
          }}
        </For>
      </svg>
      <Show when={activeBar()}>
        {(bar) => (
          <div
            data-component="chart-tooltip"
            data-placement={bar().x > width * 0.62 ? "left" : "right"}
            style={getUsageTooltipStyle(bar().x, bar().width, width)}
          >
            <strong>{bar().point.date}</strong>
            <span>{formatTokens(usageTotal(bar().point))} total</span>
            <div data-slot="tooltip-divider" />
            <For each={bar().point.segments}>
              {(segment, index) => (
                <p data-active={activeSegment() === index() ? "true" : undefined}>
                  <span data-slot="tooltip-label">
                    <i style={{ background: usageColors[index()] }} /> {segment.model}
                  </span>
                  <b>{formatTokens(segment.value)}</b>
                </p>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  )
}

function getUsageTooltipStyle(barX: number, barWidth: number, width: number) {
  if (barX > width * 0.62) return { left: "auto", right: `${((width - barX + 12) / width) * 100}%` }
  return { left: `${((barX + barWidth + 12) / width) * 100}%`, right: "auto" }
}

function getUsageSegmentOpacity(isActiveBar: boolean, activeSegment: number | undefined, index: number) {
  if (!isActiveBar) return 1
  if (activeSegment === undefined) return 1
  return activeSegment === index ? 1 : 0.38
}

function usageTotal(point: UsagePoint) {
  return point.segments.reduce((sum, item) => sum + item.value, 0)
}

function formatTokens(value: number) {
  if (value >= 1) return `${value.toFixed(value >= 10 ? 0 : 1)}T`
  return `${Math.round(value * 1000)}B`
}

function LeaderboardSection(props: { data: StatsHomeData["leaderboard"] }) {
  const [product, setProduct] = createSignal<UsageProduct>("All Users")
  const [range, setRange] = createSignal<UsageRange>("1W")
  const data = createMemo(() => props.data[product()][range()])

  return (
    <ChartSection
      id="leaderboard"
      title="Leaderboard"
      description="Shown are the sum of prompt and completion tokens per model, including reasoning tokens."
    >
      <Show
        when={data().length > 0}
        fallback={
          <EmptyState title="No leaderboard data" description="No model_stat rows matched this product and range." />
        }
      >
        <Leaderboard data={data()} />
      </Show>
      <div data-slot="chart-footer">
        <StatsFilters product={product()} range={range()} onProductSelect={setProduct} onRangeSelect={setRange} />
      </div>
    </ChartSection>
  )
}

function Leaderboard(props: { data: LeaderboardEntry[] }) {
  return (
    <div data-component="leaderboard" aria-label="Model token leaderboard">
      <div data-slot="leaderboard-grid">
        <div data-slot="leaderboard-featured">
          <For each={props.data.slice(0, 3)}>{(entry) => <LeaderboardCard entry={entry} size="featured" />}</For>
        </div>
        <div data-slot="leaderboard-compact">
          <For each={props.data.slice(3)}>{(entry) => <LeaderboardCard entry={entry} size="compact" />}</For>
        </div>
      </div>
    </div>
  )
}

function LeaderboardCard(props: { entry: LeaderboardEntry; size: "featured" | "compact" }) {
  return (
    <article data-component="leader-card" data-size={props.size}>
      <span data-slot="rank">{String(props.entry.rank).padStart(2, "0")}</span>
      <ProviderIcon data-slot="leader-watermark" aria-hidden="true" id={getProviderIconId(props.entry.author)} />
      <div data-slot="leader-body">
        <ProviderIcon data-slot="leader-avatar" aria-hidden="true" id={getProviderIconId(props.entry.author)} />
        <div data-slot="leader-copy">
          <div>
            <strong>{props.entry.model}</strong>
            <span>{formatBillions(props.entry.tokens)}</span>
          </div>
          <div>
            <span>{props.entry.author}</span>
            <span data-slot="delta" data-negative={props.entry.change < 0 ? "true" : undefined}>
              {formatChange(props.entry.change)}
            </span>
          </div>
        </div>
      </div>
    </article>
  )
}

function getProviderIconId(author: string) {
  if (author === "MiniMax") return "minimax"
  if (author === "Moonshot") return "moonshotai"
  if (author === "Zhipu") return "zhipuai"
  return author.toLowerCase()
}

function formatBillions(value: number) {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}T`
  return `${value}B`
}

function formatChange(value: number) {
  if (value > 0) return `+${value}%`
  return `${value}%`
}

function MarketShareSection(props: { data: StatsHomeData["market"] }) {
  const [range, setRange] = createSignal<UsageRange>("1W")
  const [activeIndex, setActiveIndex] = createSignal(2)
  const data = createMemo(() => props.data[range()])
  const selectedIndex = createMemo(() => Math.min(activeIndex(), Math.max(data().length - 1, 0)))
  const activeDay = createMemo(() => data()[selectedIndex()])

  return (
    <ChartSection id="market-share" title="Market Share" description="Compare token share by model author.">
      <Show
        when={activeDay()}
        fallback={<EmptyState title="No market data" description="No model_stat rows matched this range." />}
      >
        {(day) => (
          <>
            <MarketShare data={data()} activeIndex={selectedIndex()} onActiveIndexChange={setActiveIndex} />
            <MarketShareList data={day().authors} />
          </>
        )}
      </Show>
      <div data-slot="market-footer">
        <p>
          <span>[*]</span>
          <strong>{activeDay()?.date ?? "No data"}</strong>
        </p>
        <FilterPills items={ranges} selected={range()} label="Date range" variant="range" onSelect={setRange} />
      </div>
    </ChartSection>
  )
}

function MarketShare(props: { data: MarketDay[]; activeIndex: number; onActiveIndexChange: (index: number) => void }) {
  return (
    <div data-component="market-share" role="img" aria-label="Market share by model author">
      <div data-slot="market-labels">
        <For each={props.data}>
          {(day, index) => (
            <button
              type="button"
              data-active={props.activeIndex === index() ? "true" : undefined}
              onClick={() => props.onActiveIndexChange(index())}
            >
              <span>{formatTrillions(day.total)}</span>
              <span>{day.date}</span>
            </button>
          )}
        </For>
      </div>
      <div data-slot="market-bars">
        <For each={props.data}>
          {(day, index) => (
            <button
              type="button"
              aria-label={`${day.date} ${formatTrillions(day.total)}`}
              data-active={props.activeIndex === index() ? "true" : undefined}
              onClick={() => props.onActiveIndexChange(index())}
            >
              <For each={day.authors}>
                {(author, authorIndex) => (
                  <span
                    style={{
                      "background-color": props.activeIndex === index() ? marketColors[authorIndex()] : undefined,
                      "flex-grow": author.share,
                    }}
                  />
                )}
              </For>
            </button>
          )}
        </For>
      </div>
    </div>
  )
}

function MarketShareList(props: { data: MarketDay["authors"] }) {
  return (
    <ol data-component="market-share-list">
      <For each={props.data}>
        {(item, index) => (
          <li>
            <span>{String(index() + 1).padStart(2, "0")}</span>
            <i style={{ background: marketColors[index()] }} />
            <strong>{item.author}</strong>
            <em>{formatTrillions(item.tokens)}</em>
            <b>{item.share.toFixed(1)}%</b>
          </li>
        )}
      </For>
    </ol>
  )
}

function formatTrillions(value: number) {
  return `${value.toFixed(value >= 10 ? 0 : 1)}T`
}

function TokenCostSection(props: { data: StatsHomeData["tokenCost"] }) {
  const [product, setProduct] = createSignal<TokenProduct>("Zen")
  const [activeIndex, setActiveIndex] = createSignal(2)
  const data = createMemo(() => props.data[product()])
  const selectedIndex = createMemo(() => Math.min(activeIndex(), Math.max(data().length - 1, 0)))

  return (
    <ChartSection id="token-cost" title="Token Cost" description="Price per 1M tokens.">
      <Show
        when={data().length > 0}
        fallback={
          <EmptyState title="No token cost data" description="No cost-bearing model_stat rows matched this product." />
        }
      >
        <TokenCostChart data={data()} activeIndex={selectedIndex()} onActiveIndexChange={setActiveIndex} />
      </Show>
      <div data-slot="token-footer">
        <FilterPills
          items={tokenProducts}
          selected={product()}
          label="Product filter"
          variant="product"
          onSelect={setProduct}
        />
      </div>
    </ChartSection>
  )
}

function TokenCostChart(props: {
  data: TokenCostEntry[]
  activeIndex: number
  onActiveIndexChange: (index: number) => void
}) {
  const max = createMemo(() => Math.max(1, ...props.data.map((item) => item.total)))
  const active = createMemo(() => props.data[props.activeIndex] ?? props.data[0])

  return (
    <div data-component="token-cost">
      <For each={props.data}>
        {(item, index) => (
          <button
            type="button"
            data-component="token-row"
            data-active={props.activeIndex === index() ? "true" : undefined}
            onClick={() => props.onActiveIndexChange(index())}
            onPointerEnter={() => props.onActiveIndexChange(index())}
          >
            <strong>{formatDollars(item.total)}</strong>
            <span>{item.model}</span>
            <MetricBar value={item.total} max={max()} active={props.activeIndex === index()} />
          </button>
        )}
      </For>
      <Show when={active()}>
        {(item) => (
          <div data-component="token-tooltip" style={{ top: `${props.activeIndex * 28 + 2}px` }}>
            <p>
              <span>Input</span>
              <strong>{formatDollars(item().input)}</strong>
            </p>
            <p>
              <span>Output</span>
              <strong>{formatDollars(item().output)}</strong>
            </p>
            <p>
              <span>Cached</span>
              <strong>{formatDollars(item().cached)}</strong>
            </p>
          </div>
        )}
      </Show>
    </div>
  )
}

function formatDollars(value: number) {
  return `$${value.toFixed(2)}`
}

function MetricBar(props: { value: number; max: number; active: boolean }) {
  return (
    <i data-component="metric-bar" data-active={props.active ? "true" : undefined}>
      <b style={{ "flex-grow": Math.max(props.value / Math.max(props.max, 1), 0.05) }} />
      <em />
    </i>
  )
}

function SessionCostSection(props: { data: StatsHomeData["sessionCost"] }) {
  const [product, setProduct] = createSignal<TokenProduct>("Zen")
  const [activeIndex, setActiveIndex] = createSignal(2)
  const data = createMemo(() => props.data[product()])
  const selectedIndex = createMemo(() => Math.min(activeIndex(), Math.max(data().length - 1, 0)))

  return (
    <ChartSection id="session-cost" title="Session Cost" description="Average cost per session.">
      <Show
        when={data().length > 0}
        fallback={
          <EmptyState
            title="No session cost data"
            description="No session-bearing model_stat rows matched this product."
          />
        }
      >
        <SessionCostChart data={data()} activeIndex={selectedIndex()} onActiveIndexChange={setActiveIndex} />
      </Show>
      <div data-slot="token-footer">
        <FilterPills
          items={tokenProducts}
          selected={product()}
          label="Product filter"
          variant="product"
          onSelect={setProduct}
        />
      </div>
    </ChartSection>
  )
}

function SessionCostChart(props: {
  data: SessionCostEntry[]
  activeIndex: number
  onActiveIndexChange: (index: number) => void
}) {
  const maxCost = createMemo(() => Math.max(1, ...props.data.map((item) => item.cost)))
  const maxTokens = createMemo(() => Math.max(1, ...props.data.map((item) => item.tokens)))
  const active = createMemo(() => props.data[props.activeIndex] ?? props.data[0])

  return (
    <div data-component="session-cost">
      <div data-slot="session-heading">
        <span />
        <p>COST / SESSION</p>
        <p>TOKENS / SESSIONS</p>
      </div>
      <For each={props.data}>
        {(item, index) => (
          <button
            type="button"
            data-component="token-row"
            data-variant="session"
            data-active={props.activeIndex === index() ? "true" : undefined}
            onClick={() => props.onActiveIndexChange(index())}
            onPointerEnter={() => props.onActiveIndexChange(index())}
          >
            <strong>{formatSessionCost(item.cost)}</strong>
            <span>{item.model}</span>
            <MetricBar value={item.cost} max={maxCost()} active={props.activeIndex === index()} />
            <MetricBar value={item.tokens} max={maxTokens()} active={props.activeIndex === index()} />
          </button>
        )}
      </For>
      <Show when={active()}>
        {(item) => (
          <div
            data-component="token-tooltip"
            data-variant="session"
            style={{ top: `${props.activeIndex * 28 + 21}px` }}
          >
            <p>
              <span>Cost/Session</span>
              <strong>{formatSessionCost(item().cost)}</strong>
            </p>
            <p>
              <span>Tokens/Session</span>
              <strong>{formatTokenCount(item().tokens)}</strong>
            </p>
          </div>
        )}
      </Show>
    </div>
  )
}

function formatTokenCount(value: number) {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`
  return `${Math.round(value / 1_000)}K`
}

function formatSessionCost(value: number) {
  return `$${value.toFixed(4)}`
}

function CountrySection(props: { data: StatsHomeData["country"] }) {
  const [range, setRange] = createSignal<UsageRange>("1W")
  const data = createMemo(() => props.data[range()])

  return (
    <ChartSection title="Token by Country" description="Country-level token totals from geo_stat.">
      <Show
        when={data().length > 0}
        fallback={<EmptyState title="No country data" description="No geo_stat rows matched this range." />}
      >
        <CountryChart data={data()} />
      </Show>
      <div data-slot="country-footer">
        <p>
          <span>[*]</span>
          <strong>Top countries by tokens</strong>
        </p>
        <FilterPills items={ranges} selected={range()} label="Date range" variant="range" onSelect={setRange} />
      </div>
    </ChartSection>
  )
}

function CountryChart(props: { data: CountryEntry[] }) {
  const [activeIndex, setActiveIndex] = createSignal(0)
  const selectedIndex = createMemo(() => Math.min(activeIndex(), Math.max(props.data.length - 1, 0)))
  const active = createMemo(() => props.data[selectedIndex()])
  const max = createMemo(() => Math.max(0.0001, ...props.data.map((item) => item.tokens)))

  return (
    <div data-component="country-map">
      <svg viewBox="0 0 920 320" role="img" aria-label="Country token share bubble chart">
        <For each={props.data.slice(0, countryPositions.length)}>
          {(item, index) => {
            const position = countryPositions[index()]
            const radius = 18 + Math.sqrt(item.tokens / max()) * 58
            return (
              <g
                role="button"
                tabIndex={0}
                aria-label={`${formatCountry(item.country)} ${formatTokens(item.tokens)}`}
                data-active={selectedIndex() === index() ? "true" : undefined}
                onPointerEnter={() => setActiveIndex(index())}
                onClick={() => setActiveIndex(index())}
                onFocus={() => setActiveIndex(index())}
              >
                <circle cx={position.x} cy={position.y} r={radius} />
                <text x={position.x} y={position.y + 4} text-anchor="middle">
                  {item.country}
                </text>
              </g>
            )
          }}
        </For>
      </svg>
      <Show when={active()}>
        {(item) => (
          <div data-component="map-tooltip">
            <strong>{formatCountry(item().country)}</strong>
            <span>{item().continent || "Unknown region"}</span>
            <p>
              <b>{formatTokens(item().tokens)}</b>
              <em>{item().share.toFixed(1)}%</em>
            </p>
          </div>
        )}
      </Show>
      <CountryList data={props.data.slice(0, 8)} activeIndex={selectedIndex()} onActiveIndexChange={setActiveIndex} />
    </div>
  )
}

function CountryList(props: {
  data: CountryEntry[]
  activeIndex: number
  onActiveIndexChange: (index: number) => void
}) {
  return (
    <ol data-component="country-list">
      <For each={props.data}>
        {(item, index) => (
          <li>
            <button
              type="button"
              data-active={props.activeIndex === index() ? "true" : undefined}
              onClick={() => props.onActiveIndexChange(index())}
              onPointerEnter={() => props.onActiveIndexChange(index())}
            >
              <span>{String(item.rank).padStart(2, "0")}</span>
              <strong>{formatCountry(item.country)}</strong>
              <em>{formatTokens(item.tokens)}</em>
              <b>{item.share.toFixed(1)}%</b>
            </button>
          </li>
        )}
      </For>
    </ol>
  )
}

function formatCountry(country: string) {
  const known: Record<string, string> = {
    AU: "Australia",
    BR: "Brazil",
    CA: "Canada",
    CN: "China",
    DE: "Germany",
    FR: "France",
    GB: "United Kingdom",
    IN: "India",
    JP: "Japan",
    KR: "South Korea",
    NL: "Netherlands",
    SG: "Singapore",
    US: "United States",
    ZZ: "Unknown",
  }
  return known[country] ?? country
}

function Newsletter() {
  return (
    <section data-section="newsletter">
      <div>
        <h2>Be the first to know when we release new products</h2>
        <p>Join the waitlist for early access.</p>
      </div>
      <form>
        <input type="email" placeholder="Email address" />
        <button>Subscribe</button>
      </form>
    </section>
  )
}

function Header() {
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [menuViewport, setMenuViewport] = createSignal(false)

  createEffect(() => {
    if (typeof window === "undefined") return
    const media = window.matchMedia("(max-width: 74.999rem)")
    const update = () => setMenuViewport(media.matches)
    update()
    media.addEventListener("change", update)
    onCleanup(() => media.removeEventListener("change", update))
  })

  createEffect(() => {
    if (!menuOpen()) return
    if (!menuViewport()) return
    if (typeof document === "undefined") return
    const page = document.querySelector<HTMLElement>('[data-page="stats"]')
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth
    const htmlOverflow = document.documentElement.style.overflow
    const pagePaddingRight = page?.style.paddingRight
    const bodyOverflow = document.body.style.overflow
    document.documentElement.style.overflow = "hidden"
    if (scrollbarWidth > 0 && page) page.style.paddingRight = `${scrollbarWidth}px`
    document.body.style.overflow = "hidden"
    onCleanup(() => {
      document.documentElement.style.overflow = htmlOverflow
      if (page && pagePaddingRight !== undefined) page.style.paddingRight = pagePaddingRight
      document.body.style.overflow = bodyOverflow
    })
  })

  return (
    <header data-component="top" data-menu-open={menuOpen() ? "true" : undefined}>
      <div data-slot="header-bar">
        <a data-slot="brand" href="/" aria-label="OpenCode home">
          <StatsWordmark />
        </a>
        <nav data-component="section-nav" aria-label="Stats sections">
          <ul>
            <For each={headerLinks}>
              {(link) => (
                <li>
                  <a href={link.href}>{link.label}</a>
                </li>
              )}
            </For>
          </ul>
        </nav>
        <div data-slot="header-actions">
          <a
            data-slot="header-button"
            data-variant="neutral"
            href="https://github.com/sst/opencode"
            target="_blank"
            rel="noreferrer"
          >
            <strong>GitHub</strong>
            <span>[150K]</span>
          </a>
          <a data-slot="header-button" data-variant="contrast" href="https://opencode.ai/">
            <strong>Try OpenCode</strong>
          </a>
          <button
            data-slot="menu-button"
            type="button"
            aria-controls="stats-mobile-nav"
            aria-expanded={menuOpen() ? "true" : "false"}
            aria-label={menuOpen() ? "Close navigation" : "Open navigation"}
          onClick={() => setMenuOpen((value) => !value)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <Show when={menuOpen()} fallback={<path d="M2 4.72H14M2 8.5H14M2 12.28H14" stroke="currentColor" />}>
              <path d="M4.44 4.44L11.56 11.56M11.56 4.44L4.44 11.56" stroke="currentColor" />
            </Show>
          </svg>
        </button>
        </div>
      </div>
      <nav id="stats-mobile-nav" data-slot="mobile-menu" aria-label="Stats sections" hidden={!menuOpen()}>
        <a
          data-slot="mobile-menu-item"
          data-variant="github"
          href="https://github.com/sst/opencode"
          target="_blank"
          rel="noreferrer"
        >
          <strong>GitHub</strong>
          <span>[150K]</span>
        </a>
        <For each={headerLinks}>
          {(link) => (
            <a data-slot="mobile-menu-item" href={link.href} onClick={() => setMenuOpen(false)}>
              {link.label}
            </a>
          )}
        </For>
      </nav>
    </header>
  )
}

function StatsWordmark() {
  return (
    <span data-slot="stats-wordmark" aria-hidden="true">
      <svg data-slot="brand-mark" width="19" height="24" viewBox="0 0 19 24" fill="none">
        <path opacity="0.2" d="M14.25 19.2H4.75V9.6H14.25V19.2Z" fill="currentColor" />
        <path d="M14.25 4.8H4.75V19.2H14.25V4.8ZM19 24H0V0H19V24Z" fill="currentColor" />
      </svg>
      <svg data-slot="brand-label" width="51" height="14" viewBox="0 0 50.8509 14" fill="none">
        <path d="M46.2359 14C45.2276 14 44.3356 13.819 43.56 13.4571C42.7973 13.0822 42.138 12.5328 41.5822 11.8089L43.1722 10.277C43.56 10.807 44.0124 11.2142 44.5295 11.4986C45.0466 11.7701 45.6283 11.9058 46.2747 11.9058C47.7225 11.9058 48.4464 11.2465 48.4464 9.92798C48.4464 9.38504 48.3172 8.97138 48.0586 8.68698C47.8001 8.40259 47.3735 8.19575 46.7788 8.06648L45.596 7.8338C44.3679 7.57525 43.463 7.13573 42.8813 6.51524C42.2996 5.89474 42.0088 5.02862 42.0088 3.9169C42.0088 2.62419 42.3901 1.6482 43.1528 0.98892C43.9284 0.32964 45.0272 0 46.4492 0C47.4187 0 48.2461 0.161588 48.9312 0.484764C49.6293 0.795014 50.2239 1.28624 50.7151 1.95845L49.1251 3.45152C48.789 2.99908 48.4076 2.66297 47.9811 2.44321C47.5545 2.21053 47.0309 2.09418 46.4104 2.09418C45.7253 2.09418 45.2211 2.22992 44.898 2.50139C44.5748 2.77285 44.4132 3.21237 44.4132 3.81995C44.4132 4.3241 44.536 4.71191 44.7816 4.98338C45.0401 5.25485 45.4538 5.45522 46.0226 5.58449L47.2054 5.83656C47.8647 5.97876 48.4206 6.15328 48.873 6.36011C49.3384 6.56694 49.7133 6.82548 49.9977 7.13573C50.295 7.44598 50.5083 7.8144 50.6376 8.241C50.7798 8.65466 50.8509 9.14589 50.8509 9.71468C50.8509 11.1108 50.4501 12.1773 49.6486 12.9141C48.8601 13.638 47.7225 14 46.2359 14Z" fill="currentColor" />
        <path d="M36.9543 2.34643V13.7675H34.5305V2.34643H31.1371V0.232856H40.367V2.34643H36.9543Z" fill="currentColor" />
        <path d="M28.6196 13.7675L27.6695 10.2384H23.3066L22.3565 13.7675H20.0296L23.9853 0.232856H27.049L31.0047 13.7675H28.6196ZM26.0407 4.57635L25.6141 2.42399H25.3426L24.916 4.57635L23.8883 8.27995H27.0878L26.0407 4.57635Z" fill="currentColor" />
        <path d="M16.4849 2.34643V13.7675H14.0611V2.34643H10.6678V0.232856H19.8977V2.34643H16.4849Z" fill="currentColor" />
        <path d="M4.65374 14C3.64543 14 2.75346 13.819 1.97784 13.4571C1.21514 13.0822 0.555863 12.5328 0 11.8089L1.59003 10.277C1.97784 10.807 2.43029 11.2142 2.94737 11.4986C3.46445 11.7701 4.04617 11.9058 4.69252 11.9058C6.14035 11.9058 6.86427 11.2465 6.86427 9.92798C6.86427 9.38504 6.735 8.97138 6.47646 8.68698C6.21791 8.40259 5.79132 8.19575 5.19668 8.06648L4.01385 7.8338C2.78578 7.57525 1.88089 7.13573 1.29917 6.51524C0.717452 5.89474 0.426593 5.02862 0.426593 3.9169C0.426593 2.62419 0.807941 1.6482 1.57064 0.98892C2.34626 0.32964 3.44506 0 4.86704 0C5.83657 0 6.6639 0.161588 7.34903 0.484764C8.04709 0.795014 8.64174 1.28624 9.13297 1.95845L7.54294 3.45152C7.20683 2.99908 6.82549 2.66297 6.39889 2.44321C5.9723 2.21053 5.44875 2.09418 4.82826 2.09418C4.14312 2.09418 3.63897 2.22992 3.31579 2.50139C2.99261 2.77285 2.83103 3.21237 2.83103 3.81995C2.83103 4.3241 2.95383 4.71191 3.19945 4.98338C3.45799 5.25485 3.87165 5.45522 4.44044 5.58449L5.62327 5.83656C6.28255 5.97876 6.83841 6.15328 7.29086 6.36011C7.75623 6.56694 8.13112 6.82548 8.41551 7.13573C8.71284 7.44598 8.92613 7.8144 9.0554 8.241C9.1976 8.65466 9.2687 9.14589 9.2687 9.71468C9.2687 11.1108 8.86796 12.1773 8.06648 12.9141C7.27793 13.638 6.14035 14 4.65374 14Z" fill="currentColor" />
      </svg>
    </span>
  )
}

function Footer() {
  return (
    <footer data-component="footer">
      <div data-slot="cell">
        <a href="https://github.com/sst/opencode" target="_blank" rel="noreferrer">
          GitHub
        </a>
      </div>
      <div data-slot="cell">
        <a href="https://opencode.ai/docs">Docs</a>
      </div>
      <div data-slot="cell">
        <a href="https://opencode.ai/changelog">Changelog</a>
      </div>
      <div data-slot="cell">
        <a href="https://x.com/opencode_ai">X</a>
      </div>
    </footer>
  )
}

function Legal() {
  return (
    <div data-component="legal">
      <span>
        ©{new Date().getFullYear()} <a href="https://anoma.ly">Anomaly</a>
      </span>
      <span>
        <a href="https://opencode.ai/brand">Brand</a>
      </span>
      <span>
        <a href="https://opencode.ai/legal/privacy-policy">Privacy</a>
      </span>
      <span>
        <a href="https://opencode.ai/legal/terms-of-service">Terms</a>
      </span>
    </div>
  )
}
