"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div style={{ background: "#0B0E11", color: "#EAECEF", padding: 40, fontFamily: "monospace", minHeight: "100vh" }}>
      <h1>Error</h1>
      <pre style={{ color: "#F6465D", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {error.message}
      </pre>
      <pre style={{ color: "#848E9C", fontSize: 12, whiteSpace: "pre-wrap" }}>
        {error.stack}
      </pre>
      <button
        onClick={reset}
        style={{ marginTop: 20, padding: "10px 20px", background: "#00C9A7", color: "#0B0E11", border: "none", borderRadius: 4, cursor: "pointer", fontWeight: "bold" }}
        >
        REINTENTAR
      </button>
    </div>
  );
}
