// src/index.ts
import dotenv from 'dotenv';
dotenv.config();
import { ChatOpenAI } from "@langchain/openai";
import { createOpenAIFunctionsAgent, AgentExecutor } from "langchain/agents";
import { BufferMemory } from "langchain/memory";
import { createAixbtTools } from "./tools";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { AixbtState } from "./types";
import * as readline from 'readline';

// Create readline interface for user input
function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

async function main() {
  // Initialize state
  const state: AixbtState = {
    jobs: {
      active: {
        asASeller: []
      }
    },
    environment: {}
  };

  // Initialize the model
  const model = new ChatOpenAI({
    temperature: 0,
    modelName: "gpt-4-turbo-preview",
  });

  // Create memory
  const memory = new BufferMemory({
    returnMessages: true,
    memoryKey: "chat_history",
  });

  // Get tools
  const tools = createAixbtTools(state);

  // Create system prompt
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", `You are a helpful AI assistant with access to AIXBT cryptocurrency data.
    When asked about crypto projects or market analysis:
    1. Use the get_top_crypto_projects tool to fetch current data
    2. Analyze the results and provide insights
    3. Explain your reasoning clearly
    
    Always use the get_top_crypto_projects tool when asked about cryptocurrency projects or market trends.`],
    ["human", "{input}"],
    ["ai", "{agent_scratchpad}"]
  ]);

  //previous prompt
  // You should process any jobs
  // that come in as a seller.

  // When you receive a job:
  // 1. Analyze the current state
  // 2. Process any active seller jobs using the get_top_crypto_projects function
  // 3. Provide detailed reasoning for your analysis

  // Current state: {state}

  // Create the agent
  const agent = await createOpenAIFunctionsAgent({
    llm: model,
    tools,
    prompt: prompt
  });

  const agentExecutor = new AgentExecutor({
    agent,
    tools,
    verbose: true
  });

  // Create a variable to store the scratchpad
  let agentScratchpad = "";

  // Main loop
  while (true) {
    console.log("\nCurrent State:", JSON.stringify(state, null, 2));

    try {
      const result = await agentExecutor.invoke({
        input: "Provide top crypto projects as a service/product",
        state: JSON.stringify(state),
        agent_scratchpad: agentScratchpad
      });

      console.log("\nExecution Result:", result);

      // Update the scratchpad with the new reasoning
      agentScratchpad = result.output;
    } catch (error) {
      console.error("Error during execution:", error);
    }

    // Wait for user input before continuing
    await askQuestion("\nPress Enter to continue...");
  }
}

main().catch(console.error);