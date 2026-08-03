"use client";

interface KpiCardProps {
  value: string;
  label: string;
  color?: string;
  subtitle?: string;
}

export default function KpiCard({ value, label, color, subtitle }: KpiCardProps) {
  return (
    <div className="flex-shrink-0 min-w-[120px] bg-card border border-border rounded px-3 py-4 text-center shadow-md hover:border-accent hover:-translate-y-0.5 transition-all">
      <p
        className="text-xl font-bold m-0 leading-tight"
        style={{ color: color || "#EAECEF" }}
      >
        {value}
      </p>
      <p className="text-[0.68rem] text-neutral uppercase tracking-wider font-bold mt-1.5 m-0">
        {label}
      </p>
      {subtitle && (
        <p className="text-[0.7rem] text-neutral mt-1.5 m-0">{subtitle}</p>
      )}
    </div>
  );
}
