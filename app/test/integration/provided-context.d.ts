declare module 'vitest' {
  export interface ProvidedContext {
    dynamodbEndpoint: string;
  }
}

export {};
