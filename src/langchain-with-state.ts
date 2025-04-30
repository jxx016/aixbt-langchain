import { ChatOpenAI } from "@langchain/openai";
import { createOpenAIFunctionsAgent, AgentExecutor } from "langchain/agents";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { BufferMemory } from "langchain/memory";
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

// Simple state manager for ACP jobs
class AcpStateManager {
  private jobStates: Map<string, {
    phase: string;
    memory: BufferMemory;
    metadata: Record<string, any>;
    lastUpdated: Date;
  }> = new Map();
  
  getJobState(jobId: string): {
    phase: string;
    memory: BufferMemory;
    metadata: Record<string, any>;
    lastUpdated: Date;
  } {
    if (!this.jobStates.has(jobId)) {
      // Initialize new job state with memory
      this.jobStates.set(jobId, {
        phase: "UNKNOWN",
        memory: new BufferMemory({
          memoryKey: "chat_history",
          returnMessages: true,
        }),
        metadata: {},
        lastUpdated: new Date()
      });
    }
    
    return this.jobStates.get(jobId)!;
  }
  
  updateJobPhase(jobId: string, phase: string): void {
    const state = this.getJobState(jobId);
    state.phase = phase;
    state.lastUpdated = new Date();
    console.log(`Updated job ${jobId} to phase ${phase}`);
  }
  
  setJobMetadata(jobId: string, key: string, value: any): void {
    const state = this.getJobState(jobId);
    state.metadata[key] = value;
    state.lastUpdated = new Date();
  }
  
  getJobMetadata(jobId: string, key: string): any {
    return this.getJobState(jobId).metadata[key];
  }
  
  getAllJobs(): string[] {
    return Array.from(this.jobStates.keys());
  }
}

async function main() {
  // Initialize state manager
  const stateManager = new AcpStateManager();
  
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
          stateManager.setJobMetadata(jobId, "decision", decision);
          stateManager.setJobMetadata(jobId, "reasoning", reasoning);

          const response = await acpPlugin.respondJob.executable({
            jobId,
            decision,
            reasoning,
            tweetContent
          }, (msg) => console.log("ACP Response:", msg));

          // Update state after response
          stateManager.setJobMetadata(jobId, "responseStatus", "completed");
          stateManager.setJobMetadata(jobId, "responseTime", new Date());
          
          console.log("ACP Response Result:", response);
          return response;
        } catch (error) {
          console.error("Error in respond_to_job:", error);
          stateManager.setJobMetadata(jobId, "responseStatus", "failed");
          stateManager.setJobMetadata(jobId, "responseError", error);
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
          stateManager.setJobMetadata(jobId, "deliveryStarted", true);
          stateManager.setJobMetadata(jobId, "deliverableType", deliverableType);
          
          const response = await acpPlugin.deliverJob.executable({
            jobId,
            deliverableType,
            deliverable,
            reasoning,
            tweetContent
          }, (msg) => console.log(msg));
          
          // Update state after delivery
          stateManager.setJobMetadata(jobId, "deliveryStatus", "completed");
          stateManager.setJobMetadata(jobId, "deliveryTime", new Date());
          
          return response;
        } catch (error) {
          console.error("Error in deliver_job:", error);
          stateManager.setJobMetadata(jobId, "deliveryStatus", "failed");
          stateManager.setJobMetadata(jobId, "deliveryError", error);
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
        stateManager.setJobMetadata(jobId, "analysisStarted", true);
        stateManager.setJobMetadata(jobId, "analysisStartTime", new Date());
        
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
          stateManager.setJobMetadata(jobId, "analysisData", data);
          stateManager.setJobMetadata(jobId, "analysisComplete", true);

          const state = await acpPlugin.getAcpState();

          const job = state.jobs.active.asASeller.find(
            (j) => Number(j.jobId) === Number(jobId)
          );

          if (!job) {
            throw new Error(`Job ${jobId} not found or invalid`);
          }

          const finalProduct = JSON.stringify(data.data[0].analysis);

          try {
            acpPlugin.addProduceItem({
              jobId: Number(jobId), // Convert string jobId to number
              type: "text", 
              value: finalProduct,
            });
            console.log("finalProduct: ", finalProduct)
            console.log(`Successfully produced item for job ${jobId}`);
            
            // Update state after successful production
            stateManager.setJobMetadata(jobId, "productionStatus", "completed");
          } catch (error) {
            console.error(`Failed to produce item for job ${jobId}:`, error);
            stateManager.setJobMetadata(jobId, "productionStatus", "failed");
            stateManager.setJobMetadata(jobId, "productionError", error);
            throw error;
          }

          return JSON.stringify({
            projects: data,
            description: description || "",
            reasoning: reasoning || ""
          });
        } catch (error) {
          // Update state with error
          stateManager.setJobMetadata(jobId, "analysisError", error);
          stateManager.setJobMetadata(jobId, "analysisComplete", false);
          
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

        when requested for a job on getting a top crypto project, utilize the get_top_crypto_projects tool
        
        ${acpPlugin.agentDescription}`,
    ],
    ["human", "{input}"],
    ["ai", "{agent_scratchpad}"],
  ]);

  // Function to create an agent executor with job-specific memory
  const createAgentExecutor = async (jobId: string) => {
    // Get or create job state with memory from our state manager
    // This ensures each job has its own conversation history
    const jobState = stateManager.getJobState(jobId);
    
    // Create agent with the model, tools, and prompt template
    // This defines the agent's capabilities and instructions
    const agent = await createOpenAIFunctionsAgent({
      llm: model,
      tools,
      prompt,
    });

    // Create executor with job-specific memory
    // The memory allows the agent to remember previous interactions for this specific job
    // This is key for maintaining context across multiple interactions within the same job
    const executor = new AgentExecutor({
      agent: agent,
      tools,
      memory: jobState.memory,  // Using job-specific memory from state manager
      verbose: true,
    });
    return executor;
  };

  // Handle ACP phase changes
  acpPlugin.setOnPhaseChange(async (job) => {
    console.log("reacting to job", job);
    
    // Update job state with new phase
    stateManager.updateJobPhase(job.jobId.toString(), job.phase);
    
    // Get agent executor with job-specific memory
    const agentExecutor = await createAgentExecutor(job.jobId.toString());

    if (job.phase === AcpJobPhasesDesc.REQUEST) {
      // Use LangChain agent to decide whether to accept the job
      const result = await agentExecutor.invoke({
        input: `Analyze this job request and decide whether to accept it: ${JSON.stringify(
          job
        )}, lean towards accepting it`,
      });
      console.log("result inside request: ", result);
      
      // Store result in state
      stateManager.setJobMetadata(job.jobId.toString(), "requestResult", result);
      
    } else if (job.phase === AcpJobPhasesDesc.TRANSACTION) {
      // Check if we've already processed this transaction phase
      const alreadyProcessed = stateManager.getJobMetadata(job.jobId.toString(), "transactionProcessed");
      
      if (!alreadyProcessed) {
        // Use LangChain agent to process and deliver the job
        const result = await agentExecutor.invoke({
          input: `Process this job and provide crypto analysis: ${JSON.stringify(
            job
          )}`,
        });
        console.log("result inside transaction: ", result);
        
        // Store result and mark as processed
        stateManager.setJobMetadata(job.jobId.toString(), "transactionResult", result);
        stateManager.setJobMetadata(job.jobId.toString(), "transactionProcessed", true);
      } else {
        console.log(`Transaction phase for job ${job.jobId} already processed, skipping`);
      }
    }
    
    // Log current state for debugging
    console.log(`Current state for job ${job.jobId}:`, stateManager.getJobState(job.jobId.toString()));
  });

  console.log("Listening for ACP jobs...");
}

main().catch(console.error);