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

const ACP_AGENT_WALLET_ADDRESS_SELLER =
  process.env.ACP_AGENT_WALLET_ADDRESS_SELLER;
const WHITELISTED_WALLET_PRIVATE_KEY =
  process.env.WHITELISTED_WALLET_PRIVATE_KEY;
const WHITELISTED_WALLET_ENTITY_ID = process.env.WHITELISTED_WALLET_ENTITY_ID;
const GAME_API_KEY_SELLER = process.env.GAME_API_KEY_SELLER;
const GAME_DEV_API_KEY = process.env.GAME_DEV_API_KEY;

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

//   Create tools from ACP functions
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

                  const response = await acpPlugin.respondJob.executable({
                      jobId,
                      decision,
                      reasoning,
                      tweetContent
                  }, (msg) => console.log("ACP Response:", msg));

                  console.log("ACP Response Result:", response);
                  return response;
              } catch (error) {
                  console.error("Error in respond_to_job:", error);
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
              return await acpPlugin.deliverJob.executable({
                  jobId,
                  deliverableType,
                  deliverable,
                  reasoning,
                  tweetContent
              }, (msg) => console.log(msg));
          }
      }),

      // Your existing AIXBT Tool
      new DynamicStructuredTool({
          name: "get_top_crypto_projects",
          description: "Fetches and analyzes current top cryptocurrency projects",
          schema: z.object({
              jobId: z.number(),
              description: z.string(),
              reasoning: z.string()
          }),
          func: async ({ jobId, description, reasoning }) => {
              // Your AIXBT API logic here
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

                  // deliver job

                  const state = await acpPlugin.getAcpState();

                  const job = state.jobs.active.asASeller.find(
                    (j) => j.jobId === jobId!
                  );

                  if (!job) {
                    throw new Error(`Job ${jobId} not found or invalid`);
                  }

                  const finalProduct = JSON.stringify(data.data[0].analysis);

                  try {
                    acpPlugin.addProduceItem({
                      jobId: jobId!,
                      type: "text",
                      value: finalProduct,
                    });
                    console.log("finalProduct: ", finalProduct)
                    console.log(`Successfully produced item for job ${jobId}`);
                  } catch (error) {
                    console.error(`Failed to produce item for job ${jobId}:`, error);
                    throw error;  // or handle the error appropriately
                  }

                  return JSON.stringify({
                      projects: data,
                      description: description,
                      reasoning: reasoning
                    });
                } catch (error) {
                  return JSON.stringify({
                      projects: [],
                      description: description,
                      reasoning: reasoning
                    });
                }

              // AIXBT logic end here
          }
      })
  ];

  // Your existing AIXBT Tool
//   const getTopCryptoProjectsTool = new DynamicStructuredTool({
//     name: "get_top_crypto_projects",
//     description: "Fetches and analyzes current top cryptocurrency projects",
//     schema: z.object({
//       jobId: z.number(),
//       description: z.string(),
//       reasoning: z.string(),
//     }),
//     func: async ({ jobId, description, reasoning }) => {
//       // Your AIXBT API logic here
//       console.log("aixbt-langchain");
//       try {
//         const response = await fetch(
//           "https://api.aixbt.tech/v1/projects?limit=2",
//           {
//             headers: {
//               "x-api-key": process.env.AIXBT_API_KEY || "",
//               "Content-Type": "application/json",
//             },
//           }
//         );

//         console.log("response: ", response);
//         if (!response.ok) {
//           throw new Error("Failed to fetch top crypto projects");
//         }
//         const data = (await response.json()) as {
//           data: Array<{ analysis: any }>;
//         };

//         // deliver job

//         const state = await acpPlugin.getAcpState();

//         const job = state.jobs.active.asASeller.find((j) => j.jobId === jobId!);

//         if (!job) {
//           throw new Error(`Job ${jobId} not found or invalid`);
//         }

//         const finalProduct = JSON.stringify(data.data[0].analysis);

//         try {
//           acpPlugin.addProduceItem({
//             jobId: jobId!,
//             type: "text",
//             value: finalProduct,
//           });
//           console.log("finalProduct: ", finalProduct);
//           console.log(`Successfully produced item for job ${jobId}`);
//         } catch (error) {
//           console.error(`Failed to produce item for job ${jobId}:`, error);
//           throw error; // or handle the error appropriately
//         }

//         return JSON.stringify({
//           projects: data,
//           description: description,
//           reasoning: reasoning,
//         });
//       } catch (error) {
//         return JSON.stringify({
//           projects: [],
//           description: description,
//           reasoning: reasoning,
//         });
//       }

//       // AIXBT logic end here
//     },
//   });

//   const acpWorker = acpPlugin.getWorker({
//     functions: [acpPlugin.respondJob, acpPlugin.deliverJob],
// });

//   const tools: DynamicStructuredTool<any, any, any>[] = acpWorker.functions.map((gameFunction) => {
//     return new DynamicStructuredTool({
//         name: gameFunction.name,
//         description: gameFunction.description,
//         schema: z.object({
//             jobId: z.string(),
//             decision: z.enum(['ACCEPT', 'REJECT']),
//             reasoning: z.string(),
//             tweetContent: z.string()
//         }),  // Empty schema for now
//         func: async (args) => gameFunction.executable(args, console.log)
//     });
//   });

//   tools.push(getTopCryptoProjectsTool);

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

  // Example execution
  // Handle ACP phase changes
  acpPlugin.setOnPhaseChange(async (job) => {
    console.log("reacting to job", job);

    if (job.phase === AcpJobPhasesDesc.REQUEST) {
      // Use LangChain agent to decide whether to accept the job
      const result = await agentExecutor.invoke({
        input: `Analyze this job request and decide whether to accept it: ${JSON.stringify(
          job
        )}, lean towards accepting it`,
      });
      console.log("result inside request: ", result);
      // Handle job acceptance logic
    } else if (job.phase === AcpJobPhasesDesc.TRANSACTION) {
      // Use LangChain agent to process and deliver the job
      const result = await agentExecutor.invoke({
        input: `Process this job and provide crypto analysis: ${JSON.stringify(
          job
        )}`,
      });
      console.log("result inside transaction: ", result);
      // Handle job delivery logic
    }
  });

  console.log("Listening for ACP jobs...");
}

main().catch(console.error);
