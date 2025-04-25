// src/tools.ts
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { AixbtState } from "./types";

export function createAixbtTools(state: AixbtState) {
  const getTopProjects = new DynamicStructuredTool({
    name: "get_top_crypto_projects",
    description: "Use this tool to fetch and analyze the current top cryptocurrency projects from AIXBT. Returns detailed information about trending crypto projects.",
    schema: z.object({
      description: z.string().describe("A brief summary of what was found in the top crypto projects"),
      reasoning: z.string().describe("Detailed explanation of why these projects are noteworthy")
    }),
    func: async ({ description, reasoning }) => {
      try {
        // Fetch projects from AIXBT
        const response = await fetch('https://api.aixbt.tech/v1/projects?limit=2', {
          headers: {
            'x-api-key': process.env.AIXBT_API_KEY || '',
            'Content-Type': 'application/json'
          }
        });
        
        if (!response.ok) {
          throw new Error('Failed to fetch projects');
        }
        
        const data = await response.json();
        
        // // Find the job in state
        // const job = state.jobs.active.asASeller.find(
        //   (j) => j.jobId === parseInt(jobId)
        // );

        // if (!job) {
        //   throw new Error(`Job ${jobId} not found or invalid`);
        // }

        // // Process the result
        // const result = {
        //   projects: data,
        //   description,
        //   reasoning,
        //   jobId
        // };

        // return JSON.stringify(response);
        return JSON.stringify({
            projects: data,
            description: description,
            reasoning: reasoning
          });
      } catch (error) {
        throw new Error(`Error processing request: ${error}`);
      }
    }
  });

  return [getTopProjects];
}