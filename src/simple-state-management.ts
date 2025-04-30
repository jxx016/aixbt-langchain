import { ChatOpenAI } from "@langchain/openai";
import { createOpenAIFunctionsAgent, AgentExecutor } from "langchain/agents";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import AcpPlugin, {
  AcpJobPhasesDesc,
  AcpToken,
} from "@virtuals-protocol/game-acp-plugin";
import dotenv from "dotenv";

dotenv.config();

// Environment variables
const ACP_AGENT_WALLET_ADDRESS_SELLER =
  process.env.ACP_AGENT_WALLET_ADDRESS_SELLER;
const WHITELISTED_WALLET_PRIVATE_KEY =
  process.env.WHITELISTED_WALLET_PRIVATE_KEY;
const WHITELISTED_WALLET_ENTITY_ID = process.env.WHITELISTED_WALLET_ENTITY_ID;
const GAME_DEV_API_KEY = process.env.GAME_DEV_API_KEY;

// Simple in-memory state store for job-specific metadata
const jobStates = new Map();

// Define the type for inventory items
interface InventoryItem {
  jobId: string | number;
  type: string; 
  value: string;
}

// Type the inventory object
const agentInventory: {
  acquired: InventoryItem[];
} = {
  acquired: []
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

  // Create tools from ACP functions
  const tools = [
    // ACP Response Tool
    new DynamicStructuredTool({
      name: "respond_to_job",
      description: "ALWAYS use this first to accept a job request in ACP. Use 'ACCEPT' or 'REJECT' for decision.",
      schema: z.object({
        jobId: z.string(),
        decision: z.enum(['ACCEPT', 'REJECT']),
        reasoning: z.string(),
        tweetContent: z.string()
      }),
      func: async ({ jobId, decision, reasoning, tweetContent }) => {
        try {
          console.log("Attempting to respond to job with:", { jobId, decision, reasoning, tweetContent });
          
          // Update state before responding
          const jobState = jobStates.get(jobId) || { history: [] };
          jobState.responseAttempt = { decision, reasoning, timestamp: new Date() };
          jobStates.set(jobId, jobState);

          const response = await acpPlugin.respondJob.executable({
            jobId,
            decision,
            reasoning,
            tweetContent
          }, (msg) => console.log("ACP Response:", msg));

          // Update state after response
          jobState.responseStatus = "completed";
          jobState.responseTime = new Date();
          jobState.history.push({
            action: "respond",
            decision,
            reasoning,
            timestamp: new Date()
          });
          
          console.log("ACP Response Result:", response);
          return response;
        } catch (error) {
          console.error("Error in respond_to_job:", error);
          
          // Update state with error
          const jobState = jobStates.get(jobId) || { history: [] };
          jobState.responseStatus = "failed";
          jobState.responseError = error as Error;
          jobState.history.push({
            action: "respond_error", 
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date()
          });
          
          throw error;
        }
      }
    }),

    // ACP Delivery Tool
    new DynamicStructuredTool({
      name: "deliver_job",
      description: "Use this to deliver the completed job to the buyer",
      schema: z.object({
        jobId: z.string(),
        deliverableType: z.string(),
        deliverable: z.string(),
        reasoning: z.string(),
        tweetContent: z.string()
      }),
      func: async ({ jobId, deliverableType, deliverable, reasoning, tweetContent }) => {
        try {
          // Update state before delivery
          const jobState = jobStates.get(jobId) || { history: [] };
          jobState.deliveryStarted = true;
          jobState.deliverableType = deliverableType;
          jobStates.set(jobId, jobState);
          
          const response = await acpPlugin.deliverJob.executable({
            jobId,
            deliverableType,
            deliverable,
            reasoning,
            tweetContent
          }, (msg) => console.log(msg));
          
          // Update state after delivery
          jobState.deliveryStatus = "completed";
          jobState.deliveryTime = new Date();
          jobState.history.push({
            action: "deliver",
            deliverableType,
            reasoning,
            timestamp: new Date()
          });
          
          return response;
        } catch (error) {
          console.error("Error in deliver_job:", error);
          
          // Update state with error
          const jobState = jobStates.get(jobId) || { history: [] };
          jobState.deliveryStatus = "failed";
          jobState.deliveryError = error instanceof Error ? error.message : String(error);
          jobState.history.push({
            action: "deliver_error", 
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date()
          });
          
          throw error;
        }
      }
    }),

    // AIXBT Tool
    new DynamicStructuredTool({
      name: "get_top_crypto_projects",
      description: "Fetches and analyzes current top cryptocurrency projects",
      schema: z.object({
        jobId: z.string(),
        description: z.string().optional(),
        reasoning: z.string().optional()
      }),
      func: async ({ jobId, description, reasoning }) => {
        // Update state before analysis
        const jobState = jobStates.get(jobId) || { history: [] };
        jobState.analysisStarted = true;
        jobState.analysisStartTime = new Date();
        jobStates.set(jobId, jobState);
        
        console.log("aixbt-langchain");
        try {
          const response = await fetch('https://api.aixbt.tech/v1/projects?limit=2', {
            headers: {
              'x-api-key': process.env.AIXBT_API_KEY || '',
              'Content-Type': 'application/json'
            }
          });

          console.log("response: ", response)
          if (!response.ok) {
            throw new Error('Failed to fetch top crypto projects');
          }
          const data = await response.json() as {
            data: Array<{ analysis: any }>
          };

          // Store analysis data in state
          jobState.analysisData = data;
          jobState.analysisComplete = true;
          jobState.history.push({
            action: "analysis",
            timestamp: new Date()
          });

          const state = await acpPlugin.getAcpState();
          const job = state.jobs.active.asASeller.find(
            (j) => j.jobId === Number(jobId)
          );

          if (!job) {
            throw new Error(`Job ${jobId} not found or invalid`);
          }

          const finalProduct = JSON.stringify(data.data[0].analysis);

          try {
            acpPlugin.addProduceItem({
              jobId: Number(jobId), // Convert string to number
              type: "text", 
              value: finalProduct // Use string value
            });
            console.log("finalProduct: ", finalProduct)
            console.log(`Successfully produced item for job ${jobId}`);
            
            // Update state after successful production
            jobState.productionStatus = "completed";
            jobState.history.push({
              action: "produce",
              timestamp: new Date()
            });
          } catch (error) {
            console.error(`Failed to produce item for job ${jobId}:`, error);
            jobState.productionStatus = "failed";
            jobState.productionError = error instanceof Error ? error : new Error('Unknown error');
            jobState.history.push({
              action: "produce_error",
              error: error instanceof Error ? error.message : 'Unknown error',
              timestamp: new Date()
            });
            throw error;
          }

          return JSON.stringify({
            projects: data,
            description: description || "",
            reasoning: reasoning || ""
          });
        } catch (error) {
          // Update state with error
          jobState.analysisError = error instanceof Error ? error : new Error('Unknown error');
          jobState.analysisComplete = false;
          jobState.history.push({
            action: "analysis_error", 
            error: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date()
          });
          
          return JSON.stringify({
            projects: [],
            description: description || "",
            reasoning: reasoning || ""
          });
        }
      }
    })
  ];

  // Initialize model and create agent
  const model = new ChatOpenAI({
    temperature: 0,
    modelName: "gpt-4-turbo-preview",
  });

  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      `You are an AI agent that sells crypto analysis through ACP protocol.
        
        STRICT WORKFLOW:
        1. For REQUEST phase:
           - ALWAYS use respond_to_job tool first to accept the job
           - Wait for transaction phase
        
        2. For TRANSACTION phase:
           - Use get_top_crypto_projects to get analysis
           - ALWAYS use deliver_job tool to send the result

        Current job state: {job_state}
        
        ${acpPlugin.agentDescription}`,
    ],
    ["human", "{input}"],
    ["ai", "{agent_scratchpad}"],
  ]);

  const agent = await createOpenAIFunctionsAgent({
    llm: model,
    tools,
    prompt,
  });

  const agentExecutor = new AgentExecutor({
    agent,
    tools,
    verbose: true,
  });

  // Handle ACP phase changes
  acpPlugin.setOnPhaseChange(async (job) => {
    console.log("reacting to job", job);

    // Get or initialize job state
    if (!jobStates.has(job.jobId)) {
      jobStates.set(job.jobId, {
        phase: job.phase,
        history: [],
        lastUpdated: new Date(),
      });
    }

    const jobState = jobStates.get(job.jobId);
    jobState.phase = job.phase;
    jobState.lastUpdated = new Date();

    // Add phase change to history
    jobState.history.push({
      action: "phase_change",
      oldPhase: jobState.previousPhase || "NONE",
      newPhase: job.phase,
      timestamp: new Date()
    });
    
    jobState.previousPhase = job.phase;

    // Get the official ACP state (includes inventory and jobs)
    const acpState = await acpPlugin.getAcpState();
    
    // Combine our job-specific metadata with ACP's official state
    // This demonstrates how to pass state to a LangChain agent
    const combinedStateForPrompt = {
      // Job-specific metadata we're tracking
      jobId: job.jobId,
      phase: job.phase,
      history: jobState.history,
      analysisComplete: jobState.analysisComplete || false,
      responseStatus: jobState.responseStatus || "pending",
      deliveryStatus: jobState.deliveryStatus || "pending",
      
      // Official ACP state (includes inventory)
      acpInventory: acpState.inventory,
      activeJobs: acpState.jobs.active,
      completedJobs: acpState.jobs.completed
    };

    if (job.phase === AcpJobPhasesDesc.REQUEST) {
      // Check if we've already processed this request
      if (jobState.responseStatus === "completed") {
        console.log(`Job ${job.jobId} already responded to, skipping`);
        return;
      }
      
      // Use LangChain agent to decide whether to accept the job
      // Pass the combined state to the agent
      const result = await agentExecutor.invoke({
        input: `Analyze this job request and decide whether to accept it: ${JSON.stringify(
          job
        )}, lean towards accepting it`,
        job_state: JSON.stringify(combinedStateForPrompt),
      });
      
      console.log("result inside request: ", result);
      
      // Update job state with result
      jobState.requestResult = result.output;
      
    } else if (job.phase === AcpJobPhasesDesc.TRANSACTION) {
      // Check if we've already processed this transaction
      if (jobState.deliveryStatus === "completed") {
        console.log(`Job ${job.jobId} already delivered, skipping`);
        return;
      }
      
      // Use LangChain agent to process and deliver the job
      // Pass the combined state to the agent
      const result = await agentExecutor.invoke({
        input: `Process this job and provide crypto analysis: ${JSON.stringify(
          job
        )}`,
        job_state: JSON.stringify(combinedStateForPrompt),
      });
      
      console.log("result inside transaction: ", result);
      
      // Update job state with result
      jobState.transactionResult = result.output;
    }
    
    // Log current state for debugging
    console.log(`Current state for job ${job.jobId}:`, jobState);
  });

  // Add a helper function to track produced items in inventory
  const addToInventory = (jobId: string, type: string, value: string) => {
    // Define the type for inventory items
    interface InventoryItem {
      jobId: string;
      type: string; 
      value: string;
    }

    // Cast acquired to array of InventoryItem
    const currentInventory = agentInventory.acquired as InventoryItem[];
    
    // Initialize agentInventory.acquired as InventoryItem[] if not already set
    if (!agentInventory.acquired) {
      agentInventory.acquired = [] as InventoryItem[];
    }
    
    // Now add the new item
    (agentInventory.acquired as InventoryItem[]).push({ jobId, type, value });
    console.log(`Added item to inventory for job ${jobId}`);
  };

  console.log("Listening for ACP jobs with simple state management...");
}

main().catch(console.error); 