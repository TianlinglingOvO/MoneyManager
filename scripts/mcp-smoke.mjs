import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_SMOKE_URL ?? "http://127.0.0.1:8788/mcp";
const headers = process.env.MCP_SMOKE_TOKEN
  ? { Authorization: `Bearer ${process.env.MCP_SMOKE_TOKEN}` }
  : undefined;
const client = new Client({ name: "money-manager-smoke", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });

function textPayload(result) {
  const block = result.content?.find((item) => item.type === "text");
  if (!block?.text) throw new Error("MCP 返回内容缺失");
  return JSON.parse(block.text);
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(`tools:${tools.tools.map((tool) => tool.name).sort().join(",")}`);
  if (process.env.MCP_SMOKE_ALLOW_PROPOSAL === "1") {
    const categoriesResult = await client.callTool({ name: "list_categories", arguments: { kind: "expense" } });
    const categories = textPayload(categoriesResult);
    const category = categories.find((item) => !item.isArchived);
    if (!category) throw new Error("没有可用支出分类");
    const proposalResult = await client.callTool({
      name: "propose_add_transaction",
      arguments: {
        kind: "expense",
        amount: 6.66,
        categoryId: category.id,
        localDate: "2026-08-03",
        note: "OpenClaw 验收提议",
        reason: "验证只提议不直写"
      }
    });
    const payload = textPayload(proposalResult);
    console.log(`proposal:${payload.proposal.id}`);
  }
} finally {
  await client.close();
}
