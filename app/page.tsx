export default function Page() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: "40rem" }}>
      <h1>X4 Compliance MCP</h1>
      <p>
        Internal MCP server for the X4 Group Compliance team. There is nothing to
        see here. The endpoint is <code>/api/compliance/mcp</code> and it requires
        a shared secret.
      </p>
    </main>
  );
}
