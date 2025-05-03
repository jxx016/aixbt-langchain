// IMPORTANT: Add your API keys to your environment variables
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { StateGraph, MessagesAnnotation, MemorySaver } from "@langchain/langgraph";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import AcpPlugin, {
  AcpJobPhasesDesc,
  AcpToken,
} from "@virtuals-protocol/game-acp-plugin";
import dotenv from "dotenv";

dotenv.config();

// Environment variables
const ACP_AGENT_WALLET_ADDRESS_SELLER = process.env.ACP_AGENT_WALLET_ADDRESS_SELLER;
const WHITELISTED_WALLET_PRIVATE_KEY = process.env.WHITELISTED_WALLET_PRIVATE_KEY;
const WHITELISTED_WALLET_ENTITY_ID = process.env.WHITELISTED_WALLET_ENTITY_ID;
const GAME_DEV_API_KEY = process.env.GAME_DEV_API_KEY;
const AIXBT_API_KEY = process.env.AIXBT_API_KEY;

// Define our state type with annotations
type AcpState = typeof MessagesAnnotation.State & {
  jobId?: string;
  phase?: string;
  analysisComplete?: boolean;
};

async function main() {
  // Initialize ACP Plugin
  const acpPlugin = new AcpPlugin({
    apiKey: GAME_DEV_API_KEY || "",
    acpTokenClient: await AcpToken.build(
      (WHITELISTED_WALLET_PRIVATE_KEY || "0x0") as `0x${string}`,
      parseInt(WHITELISTED_WALLET_ENTITY_ID || "0") as number,
      (ACP_AGENT_WALLET_ADDRESS_SELLER || "0x0") as `0x${string}`
    ),
  });

  // Initialize model
  const model = new ChatOpenAI({
    temperature: 0,
    modelName: "gpt-4-turbo-preview",
  });

  // Create tools
  const tools = [
    new DynamicStructuredTool({
      name: "respond_to_job",
      description: "Accept or reject a job request in ACP",
      schema: z.object({
        jobId: z.string(),
        decision: z.enum(['ACCEPT', 'REJECT']),
        reasoning: z.string(),
        tweetContent: z.string()
      }),
      func: async ({ jobId, decision, reasoning, tweetContent }) => {
        console.log("Responding to job:", { jobId, decision });
        return await acpPlugin.respondJob.executable({
          jobId,
          decision,
          reasoning,
          tweetContent
        }, (msg) => console.log("ACP Response:", msg));
      }
    }),
    new DynamicStructuredTool({
      name: "deliver_job",
      description: "Deliver the completed job to the buyer",
      schema: z.object({
        jobId: z.string(),
        deliverableType: z.string(),
        deliverable: z.string(),
        reasoning: z.string(),
        tweetContent: z.string()
      }),
      func: async ({ jobId, deliverableType, deliverable, reasoning, tweetContent }) => {
        console.log("Delivering job:", jobId);
        return await acpPlugin.deliverJob.executable({
          jobId,
          deliverableType,
          deliverable,
          reasoning,
          tweetContent
        }, (msg) => console.log(msg));
      }
    }),
    new DynamicStructuredTool({
      name: "get_top_crypto_projects",
      description: "Fetches and analyzes current top cryptocurrency projects",
      schema: z.object({
        jobId: z.string().optional(),
      }),
      func: async ({ jobId }) => {
        console.log("Fetching top crypto projects");
        try {
          const response = await fetch('https://api.aixbt.tech/v1/projects?limit=2', {
            headers: {
              'x-api-key': AIXBT_API_KEY || '',
              'Content-Type': 'application/json'
            }
          });
          
          if (!response.ok) {
            throw new Error('Failed to fetch top crypto projects');
          }
          
          const data = await response.json() as { data: Array<{ analysis: any }> };
          
          if (jobId) {
            try {
              acpPlugin.addProduceItem({
                jobId: +jobId,
                type: "text",
                value: JSON.stringify(data.data[0].analysis),
              });
            } catch (error) {
              console.error(`Failed to produce item for job ${jobId}:`, error);
            }
          }
          
          return JSON.stringify(data);
        } catch (error) {
          console.error("Error fetching crypto projects:", error);
          return JSON.stringify({ error: String(error) });
        }
      }
    })
  ];

  // Create a tool node to handle tool execution
  const toolNode = new ToolNode(tools);
  
  // Bind tools to the model
  const modelWithTools = model.bindTools(tools);

  // Initialize memory to persist state between graph runs
  const checkpointer = new MemorySaver();

  // Define the function that determines the next step
  function shouldContinue(state: AcpState) {
    const lastMessage = state.messages[state.messages.length - 1] as AIMessage;

    // If the LLM makes a tool call, route to the "tools" node
    if (lastMessage.tool_calls?.length) {
      return "tools";
    }
    
    // If we're in the REQUEST phase and haven't responded yet
    if (state.phase === AcpJobPhasesDesc.REQUEST && !state.messages.some(m => 
      m instanceof AIMessage && m.tool_calls?.some(tc => tc.name === "respond_to_job"))) {
      return "request_handler";
    }
    
    // If we're in the TRANSACTION phase and analysis is complete
    if (state.phase === AcpJobPhasesDesc.TRANSACTION && state.analysisComplete) {
      return "delivery_handler";
    }
    
    // If we're in the TRANSACTION phase and analysis is not complete
    if (state.phase === AcpJobPhasesDesc.TRANSACTION && !state.analysisComplete) {
      return "analysis_handler";
    }
    
    // Otherwise, we stop
    return "__end__";
  }

  // Define the function that calls the model
  async function callModel(state: AcpState) {
    const response = await modelWithTools.invoke(state.messages);
    return { messages: [...state.messages, response] };
  }

  // Handler for the REQUEST phase
  async function handleRequest(state: AcpState) {
    console.log(`Handling request for job ${state.jobId}`);
    
    const systemMessage = new HumanMessage(
      `You are an AI agent that sells crypto analysis through ACP protocol.
      You have received a new job request with ID: ${state.jobId}.
      Please respond to accept this job.`
    );
    
    return { 
      messages: [...state.messages, systemMessage],
    };
  }

  // Handler for the analysis phase
  async function handleAnalysis(state: AcpState) {
    console.log(`Starting analysis for job ${state.jobId}`);
    
    const systemMessage = new HumanMessage(
      `You need to analyze crypto projects for job ${state.jobId}.
      Use the get_top_crypto_projects tool to fetch data.`
    );
    
    return { 
      messages: [...state.messages, systemMessage],
      analysisComplete: true
    };
  }

  // Handler for the delivery phase
  async function handleDelivery(state: AcpState) {
    console.log(`Preparing delivery for job ${state.jobId}`);
    
    const systemMessage = new HumanMessage(
      `The analysis is complete for job ${state.jobId}.
      Please deliver the job using the deliver_job tool.`
    );
    
    return { 
      messages: [...state.messages, systemMessage]
    };
  }
  // Define the graph
  const workflow = new StateGraph<{
    messages: any[];
    jobId: string;
    phase: string;
    analysisComplete: boolean;
  }>({
    channels: {
      messages: { reducer: (prev: any[], value: any) => [...(prev || []), value] },
      jobId: { reducer: (_: string, value: string) => value },
      phase: { reducer: (_: string, value: string) => value }, 
      analysisComplete: { reducer: (_: boolean, value: boolean) => value }
    }
  })
    .addNode("agent", callModel)
    .addNode("tools", toolNode)
    .addNode("request_handler", handleRequest)
    .addNode("analysis_handler", handleAnalysis)
    .addNode("delivery_handler", handleDelivery)
    .addEdge("__start__", "agent")
    .addEdge("tools", "agent")
    .addEdge("request_handler", "agent")
    .addEdge("analysis_handler", "agent")
    .addEdge("delivery_handler", "agent")
    .addConditionalEdges("agent", (state) => shouldContinue(state as AcpState));

  // Compile the graph
  const app = workflow.compile();

  // Handle ACP phase changes
  acpPlugin.setOnPhaseChange(async (job) => {
    console.log("Phase change detected for job:", job.jobId, "Phase:", job.phase);
    
    // Run the graph with the job context
    await app.invoke(
      {
        messages: [],
        jobId: job.jobId,
        phase: job.phase,
        analysisComplete: false
      },
      { configurable: { thread_id: job.jobId } }
    );
  });

  console.log("LangGraph ACP Agent is running and listening for jobs...");
}

main().catch(console.error); 