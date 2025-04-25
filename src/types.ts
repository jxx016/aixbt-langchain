// src/types.ts
export interface AixbtState {
    jobs: {
      active: {
        asASeller: Job[];
      };
    };
    environment: Record<string, any>;
  }
  
  export interface Job {
    jobId: number;
    type: string;
    status: string;
    value: string;
  }
  
  export interface AixbtProject {
    id: string;
    name: string;
    // Add other fields based on AIXBT API response
  }