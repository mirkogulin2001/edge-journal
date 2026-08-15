"use client";

import dynamic from "next/dynamic";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Plot = dynamic(() => import("react-plotly.js"), { ssr: false }) as any;

const CARD_BG = "#181A20";
const TEXT_MAIN = "#EAECEF";
const GRID_COLOR = "rgba(43, 49, 57, 0.35)";
const ZERO_COLOR = "rgba(43, 49, 57, 0.5)";

interface PlotlyChartProps {
  data: Record<string, unknown>[];
  layout?: Record<string, unknown>;
  style?: React.CSSProperties;
  className?: string;
}

export default function PlotlyChart({
  data,
  layout = {},
  style,
  className,
}: PlotlyChartProps) {
  const defaultAxis = {
    showgrid: true,
    gridcolor: GRID_COLOR,
    griddash: "dot" as const,
    zerolinecolor: ZERO_COLOR,
    showline: false,
    tickfont: { size: 11, color: "#848E9C" },
  };

  const titleObj =
    typeof layout.title === "string"
      ? { text: layout.title }
      : (layout.title as Record<string, unknown>) || {};

  const mergedLayout = {
    paper_bgcolor: CARD_BG,
    plot_bgcolor: CARD_BG,
    font: {
      color: TEXT_MAIN,
      family: "Inter, system-ui, sans-serif",
      size: 12,
    },
    margin: { l: 50, r: 20, t: 36, b: 30 },
    showlegend: false,
    hoverlabel: {
      bgcolor: "#1E2329",
      bordercolor: "rgba(0,176,189,0.3)",
      font: { size: 12, color: TEXT_MAIN, family: "Inter, system-ui, sans-serif" },
    },
    ...layout,
    title: {
      font: { size: 12, color: "#848E9C" },
      x: 0.02,
      xanchor: "left" as const,
      y: 0.98,
      yanchor: "top" as const,
      ...titleObj,
    },
    xaxis: { ...defaultAxis, ...(layout.xaxis as object) },
    yaxis: { ...defaultAxis, ...(layout.yaxis as object) },
  };

  return (
    <div
      className={`rounded-lg overflow-hidden border border-border/50 shadow-lg ${className || ""}`}
    >
      <Plot
        data={data}
        layout={mergedLayout}
        config={{ displayModeBar: false, responsive: true }}
        useResizeHandler
        style={{ width: "100%", height: "100%", ...style }}
      />
    </div>
  );
}
