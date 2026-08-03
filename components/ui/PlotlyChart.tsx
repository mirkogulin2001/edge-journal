"use client";

import dynamic from "next/dynamic";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Plot = dynamic(() => import("react-plotly.js"), { ssr: false }) as any;

const CARD_BG = "#181A20";
const BORDER_COLOR = "#2B3139";
const TEXT_MAIN = "#EAECEF";

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
    gridcolor: BORDER_COLOR,
    zerolinecolor: BORDER_COLOR,
  };

  const mergedLayout = {
    paper_bgcolor: CARD_BG,
    plot_bgcolor: CARD_BG,
    font: {
      color: TEXT_MAIN,
      family: "Chakra Petch, Inter, sans-serif",
    },
    margin: { l: 20, r: 20, t: 40, b: 20 },
    showlegend: false,
    ...layout,
    xaxis: { ...defaultAxis, ...(layout.xaxis as object) },
    yaxis: { ...defaultAxis, ...(layout.yaxis as object) },
  };

  return (
    <div
      className={`rounded overflow-hidden border border-border shadow-md ${className || ""}`}
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
