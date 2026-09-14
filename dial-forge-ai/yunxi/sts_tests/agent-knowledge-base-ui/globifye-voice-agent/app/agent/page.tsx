// app/agent/page.tsx
// Route for the agent console. Open http://localhost:3000/agent
//
// organizationId MUST be a real id from your `organizations` table (documents
// have a FK to it). agentId has no FK yet, so any valid UUID works for testing
// the Knowledge Base attach toggles.
//   select id from organizations limit 1;
import AgentConsole from "@/components/AgentConsole";

export default function AgentPage() {
  const organizationId = "11111111-1111-1111-111111111111"; // Replace with a real organization ID from your database
  const agentId = "00000000-0000-0000-0000-000000000001";

  return <AgentConsole organizationId={organizationId} agentId={agentId} />;
}
